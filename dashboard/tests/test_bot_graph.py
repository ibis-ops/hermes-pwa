import importlib
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import bot_graph
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")

MANAGER_ON_TOP = {
    "nodes": {
        "manager": {"reportsTo": None, "canMessage": ["gmail-connector", "signal-connector"], "role": "Routes work to the connectors."},
        "gmail-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": "Reads and drafts email."},
        "signal-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": ""},
    }
}


class TempHermesHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        # Resolve the map's home from the environment alone, as outside Hermes.
        root = patch.object(bot_graph, "_root_hermes_home", return_value=Path(self.tmp.name))
        root.start()
        self.addCleanup(root.stop)
        bot_graph.forget_seen()
        self.addCleanup(bot_graph.forget_seen)


class ValidateTests(unittest.TestCase):
    def test_keeps_a_clean_copy(self):
        graph = bot_graph.validate(
            {
                "nodes": {
                    "manager": {"reportsTo": None, "canMessage": ["worker", "worker", "manager"], "role": "  Leads  the team. "},
                    "worker": {"reportsTo": "manager", "canMessage": ["manager"]},
                }
            }
        )
        self.assertEqual(graph["nodes"]["manager"], {"reportsTo": None, "canMessage": ["worker"], "role": "Leads the team."})
        self.assertEqual(graph["nodes"]["worker"]["role"], "")

    def test_refuses_maps_that_do_not_hold_together(self):
        bad_maps = [
            "not a map",
            {"nodes": []},
            {"nodes": {"Bad Name": {}}},
            {"nodes": {"a": {"reportsTo": "ghost"}}},
            {"nodes": {"a": {"reportsTo": "a"}}},
            {"nodes": {"a": {"reportsTo": "b"}, "b": {"reportsTo": "a"}}},
            {"nodes": {"a": {"canMessage": ["ghost"]}}},
            {"nodes": {"a": {"canMessage": "b"}}},
            {"nodes": {"a": {"role": "x" * (bot_graph.MAX_ROLE_CHARS + 1)}}},
            {"nodes": {f"bot{i}": {} for i in range(bot_graph.MAX_BOTS + 1)}},
        ]
        for raw in bad_maps:
            with self.subTest(raw=str(raw)[:60]):
                with self.assertRaises(bot_graph.GraphError):
                    bot_graph.validate(raw)


class StorageAndContextTests(TempHermesHome):
    def test_saves_and_loads_with_a_rising_version(self):
        self.assertIsNone(bot_graph.load())
        first = bot_graph.save(MANAGER_ON_TOP)
        self.assertEqual(first["version"], 1)
        second = bot_graph.save(MANAGER_ON_TOP)
        self.assertEqual(second["version"], 2)
        loaded = bot_graph.load()
        self.assertEqual(loaded["version"], 2)
        self.assertEqual(loaded["nodes"]["gmail-connector"]["reportsTo"], "manager")
        self.assertTrue((Path(self.tmp.name) / "plugins" / "hermes-pwa" / "bot_graph.json").is_file())

    def test_tells_the_manager_and_a_connector_their_places(self):
        graph = bot_graph.validate(MANAGER_ON_TOP)
        manager = bot_graph.context_for("manager", graph)
        self.assertIn("You are Manager (@manager).", manager)
        self.assertIn("You report directly to Sean.", manager)
        self.assertIn("Reporting to you: Gmail Connector (@gmail-connector), Signal Connector (@signal-connector).", manager)
        self.assertIn("Your role: Routes work to the connectors.", manager)
        connector = bot_graph.context_for("gmail-connector", graph)
        self.assertIn("You report to Manager (@manager).", connector)
        self.assertIn("You can message or hand work to: Manager (@manager).", connector)
        self.assertIn("nothing is blocked", connector)
        self.assertIsNone(bot_graph.context_for("not-on-map", graph))

    def test_hook_says_it_once_per_chat_and_again_after_a_change(self):
        self.assertIsNone(bot_graph.hook_context("s-1", bot="manager"))
        bot_graph.save(MANAGER_ON_TOP)
        self.assertIn("You are Manager", bot_graph.hook_context("s-1", bot="manager"))
        self.assertIsNone(bot_graph.hook_context("s-1", bot="manager"))
        self.assertIn("You are Manager", bot_graph.hook_context("s-2", bot="manager"))
        bot_graph.save(MANAGER_ON_TOP)
        self.assertIn("You are Manager", bot_graph.hook_context("s-1", bot="manager"))

    def test_hook_leaves_delegated_runs_and_unmapped_bots_alone(self):
        bot_graph.save(MANAGER_ON_TOP)
        self.assertIsNone(bot_graph.hook_context("child", parent_session_id="parent", bot="manager"))
        self.assertIsNone(bot_graph.hook_context("s-9", bot="someone-else"))
        self.assertIsNone(bot_graph.hook_context("", bot="manager"))


class RouteTests(TempHermesHome):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.anonymous = TestClient(app)

    def test_requires_dashboard_auth(self):
        self.assertEqual(self.anonymous.get("/bots/graph").status_code, 401)
        self.assertEqual(self.anonymous.put("/bots/graph", json=MANAGER_ON_TOP).status_code, 401)

    def test_saves_and_returns_the_map(self):
        self.assertEqual(self.client.get("/bots/graph").json(), {"graph": None})
        saved = self.client.put("/bots/graph", json=MANAGER_ON_TOP)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["graph"]["version"], 1)
        loaded = self.client.get("/bots/graph").json()["graph"]
        self.assertEqual(loaded["nodes"]["manager"]["canMessage"], ["gmail-connector", "signal-connector"])
        self.assertEqual(saved.headers["cache-control"], "private, no-store")

    def test_refuses_a_broken_map_and_cross_site_writes(self):
        broken = {"nodes": {"a": {"reportsTo": "b"}, "b": {"reportsTo": "a"}}}
        response = self.client.put("/bots/graph", json=broken)
        self.assertEqual(response.status_code, 400)
        self.assertIn("circle", response.json()["detail"])
        cross = self.client.put("/bots/graph", json=MANAGER_ON_TOP, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(cross.status_code, 403)
        self.assertEqual(self.client.get("/bots/graph").json(), {"graph": None})


class RuntimeHookTests(TempHermesHome):
    def test_pre_llm_call_hook_adds_the_map_to_the_turn(self):
        root = Path(__file__).resolve().parents[2]
        module_name = "hermes_pwa_team_map_test"
        for key in [k for k in sys.modules if k == module_name or k.startswith(f"{module_name}.")]:
            sys.modules.pop(key, None)
        spec = importlib.util.spec_from_file_location(module_name, root / "__init__.py", submodule_search_locations=[str(root)])
        runtime = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = runtime
        spec.loader.exec_module(runtime)
        graph_module = sys.modules[f"{module_name}.bot_graph"]
        with patch.object(graph_module, "_root_hermes_home", return_value=Path(self.tmp.name)), patch.object(
            graph_module, "_current_bot", return_value="gmail-connector"
        ):
            self.assertIsNone(runtime._on_pre_llm_call(session_id="s-1"))
            bot_graph.save(MANAGER_ON_TOP)
            result = runtime._on_pre_llm_call(session_id="s-1", parent_session_id="")
            self.assertIn("You report to Manager (@manager).", result["context"])
            self.assertIsNone(runtime._on_pre_llm_call(session_id="s-1"))


if __name__ == "__main__":
    unittest.main()
