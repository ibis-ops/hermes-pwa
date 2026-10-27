import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import bot_graph
import pwa_router
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")

ROUTER_ON_TOP = {
    "nodes": {
        "router": {
            "reportsTo": None,
            "canMessage": ["gmail-connector", "manager", "signal-connector"],
            "role": "Front door: answers quick things, hands real work on.",
        },
        "manager": {"reportsTo": "router", "canMessage": ["router"], "role": "Coordinates multi-step jobs across bots."},
        "gmail-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": ""},
        "signal-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": "Sends Signal messages."},
    }
}
ROUTES = {
    "manager": "Coordinates the other bots for multi-step jobs that span several of them.",
    "gmail-connector": "Reads and sends email in Sean's Gmail.",
    "default": "General work as the main agent.",
}
ON = {"enabled": True, "bot": "router", "jevModel": "", "minConfidence": 0.6}
KEY_NAMES = ("HERMES_PWA_JEV_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY")


def jev_answer(choice, confidence, cost=0.00002):
    """OpenRouter's shape: a confidence next to the probabilities, the cost in usage."""

    def post(url, headers, body, timeout):
        post.calls.append({"url": url, "headers": headers, "body": json.loads(body), "timeout": timeout})
        return {
            "answers": {"route": {"type": "choice", "choice": choice, "confidence": confidence, "probabilities": {choice: confidence}}},
            "usage": {"input_tokens": 400, "output_tokens": 20, "cost": cost},
        }

    post.calls = []
    return post


def vercel_answer(choice, probability, *, refuse_zdr=False):
    """Vercel's /v1/evaluate shape: probabilities only, the cost as text in the gateway metadata."""

    def post(url, headers, body, timeout):
        sent = json.loads(body)
        post.calls.append({"url": url, "headers": headers, "body": sent, "timeout": timeout})
        if refuse_zdr and sent.get("providerOptions", {}).get("gateway", {}).get("zeroDataRetention"):
            raise pwa_router.JevHTTPError(403, '{"error":"Zero Data Retention is available on Pro and Enterprise plans"}')
        rest = round(1 - probability, 4)
        return {
            "model": "typesafe-ai/jev",
            "answers": {"route": {"type": "choice", "choice": choice, "probabilities": {choice: probability, "answer" if choice != "answer" else "manager": rest}}},
            "usage": {"inputTokens": 275, "outputTokens": 20},
            "providerMetadata": {"gateway": {"cost": "0.00001155", "routing": {"finalProvider": "typesafe-ai"}}},
        }

    post.calls = []
    return post


def failing(status, body=""):
    def post(url, headers, body_bytes, timeout):
        raise pwa_router.JevHTTPError(status, body)

    return post


class TempHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for name in KEY_NAMES:
            os.environ.pop(name, None)
        root = patch.object(bot_graph, "_root_hermes_home", return_value=Path(self.tmp.name))
        root.start()
        self.addCleanup(root.stop)
        bot_graph.forget_seen()
        pwa_router.forget_previous()
        self.addCleanup(bot_graph.forget_seen)
        self.addCleanup(pwa_router.forget_previous)


class SettingsTests(TempHome):
    def test_defaults_until_saved_then_merges(self):
        self.assertEqual(pwa_router.load_settings(), pwa_router.default_settings())
        self.assertFalse(pwa_router.load_settings()["enabled"])
        saved = pwa_router.save_settings({"enabled": True})
        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["bot"], "router")
        pwa_router.save_settings({"bot": "front-door", "minConfidence": 0.75})
        settings = pwa_router.load_settings()
        self.assertEqual((settings["enabled"], settings["bot"], settings["minConfidence"]), (True, "front-door", 0.75))

    def test_refuses_bad_values(self):
        for bad in ("x", {"enabled": "yes"}, {"bot": "Not A Bot"}, {"minConfidence": 2}, {"minConfidence": True}, {"jevModel": "bad model"}):
            with self.subTest(bad=bad), self.assertRaises(pwa_router.RouterSettingsError):
                pwa_router.save_settings(bad)


class CandidateTests(unittest.TestCase):
    def test_team_map_and_delegation_routes_both_apply(self):
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        # signal-connector is on the map but has no delegation route; default has a route but is not on the map.
        self.assertEqual(list(options), ["gmail-connector", "manager"])
        self.assertEqual(options["manager"], "Coordinates multi-step jobs across bots.")
        self.assertEqual(options["gmail-connector"], "Reads and sends email in Sean's Gmail.")

    def test_without_a_map_every_route_is_a_candidate(self):
        self.assertEqual(sorted(pwa_router.candidates("router", None, ROUTES)), ["default", "gmail-connector", "manager"])
        # Profile routes off: the map alone decides.
        self.assertEqual(sorted(pwa_router.candidates("router", ROUTER_ON_TOP, None)), ["gmail-connector", "manager", "signal-connector"])


class DecideTests(unittest.TestCase):
    def setUp(self):
        pwa_router.forget_previous()

    def test_asks_jev_through_vercel_with_zero_data_retention(self):
        post = vercel_answer("gmail-connector", 0.93)
        decision = pwa_router.decide(
            "Any email from the Kahunas clients today?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
            session_id="s-1", key="vck_test", provider=pwa_router.VERCEL, post=post, now=1000.0,
        )
        self.assertEqual((decision["route"], decision["source"], decision["confidence"]), ("gmail-connector", "jev", 0.93))
        self.assertEqual((decision["provider"], decision["zdr"], decision["cost"]), ("vercel", True, 0.00001155))
        call = post.calls[0]
        self.assertEqual(call["url"], "https://ai-gateway.vercel.sh/v1/evaluate")
        self.assertEqual(call["headers"]["Authorization"], "Bearer vck_test")
        self.assertNotIn("X-Title", call["headers"])
        self.assertEqual(call["body"]["model"], "typesafe-ai/jev")
        self.assertEqual(call["body"]["providerOptions"], {"gateway": {"zeroDataRetention": True}})
        self.assertNotIn("session_id", call["body"])
        self.assertEqual(call["body"]["state"], {"message": "Any email from the Kahunas clients today?"})
        self.assertEqual(sorted(call["body"]["questions"]["route"]["criteria"]), ["answer", "gmail-connector", "manager"])

    def test_a_plan_without_zero_data_retention_still_routes(self):
        post = vercel_answer("manager", 0.8, refuse_zdr=True)
        decision = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="vck_test", provider=pwa_router.VERCEL, post=post, now=1000.0)
        self.assertEqual((decision["route"], decision["zdr"]), ("manager", False))
        self.assertEqual([("providerOptions" in c["body"]) for c in post.calls], [True, False])
        # Within the hour it asks without zero data retention straight away; after it, tries again.
        again = vercel_answer("manager", 0.8, refuse_zdr=True)
        pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                          key="vck_test", provider=pwa_router.VERCEL, post=again, now=1000.0 + 600)
        self.assertEqual(len(again.calls), 1)
        later = vercel_answer("manager", 0.8)
        result = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                   key="vck_test", provider=pwa_router.VERCEL, post=later, now=1000.0 + 3700)
        self.assertEqual(result["zdr"], True)

    def test_asks_jev_through_openrouter_and_follows_a_sure_pick(self):
        post = jev_answer("gmail-connector", 0.91)
        decision = pwa_router.decide(
            "Any email from the Kahunas clients today?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
            session_id="s-1", key="sk-or-test", provider=pwa_router.OPENROUTER, post=post, now=1000.0,
        )
        self.assertEqual((decision["route"], decision["source"], decision["confidence"]), ("gmail-connector", "jev", 0.91))
        call = post.calls[0]
        self.assertEqual(call["url"], "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(call["headers"]["Authorization"], "Bearer sk-or-test")
        self.assertEqual(call["body"]["model"], "~typesafe/jev-latest")
        self.assertEqual(call["body"]["state"], {"message": "Any email from the Kahunas clients today?"})
        question = call["body"]["questions"]["route"]
        self.assertEqual(question["type"], "choice")
        self.assertEqual(sorted(question["criteria"]), ["answer", "gmail-connector", "manager"])
        self.assertEqual(call["body"]["session_id"], "s-1")
        self.assertNotIn("providerOptions", call["body"])
        self.assertEqual(decision["zdr"], None)

    def test_a_model_from_the_other_service_falls_back_to_its_own_jev(self):
        stale = {**ON, "jevModel": "~typesafe/jev-latest"}
        self.assertEqual(pwa_router.jev_model(pwa_router.VERCEL, stale), "typesafe-ai/jev")
        self.assertEqual(pwa_router.jev_model(pwa_router.OPENROUTER, stale), "~typesafe/jev-latest")
        self.assertEqual(pwa_router.jev_model(pwa_router.VERCEL, {**ON, "jevModel": "typesafe-ai/jev-1.14"}), "typesafe-ai/jev-1.14")
        self.assertEqual(pwa_router.jev_model(pwa_router.OPENROUTER, ON), "~typesafe/jev-latest")

    def test_a_follow_up_carries_the_previous_message_and_where_it_went(self):
        pwa_router.decide("Check my inbox", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, session_id="s-1",
                          key="k", post=jev_answer("gmail-connector", 0.9), now=1000.0)
        post = jev_answer("gmail-connector", 0.8)
        pwa_router.decide("and reply to the first one", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                          session_id="s-1", key="k", post=post, now=1300.0)
        self.assertEqual(post.calls[0]["body"]["state"]["previous_message"], "Check my inbox")
        self.assertEqual(post.calls[0]["body"]["state"]["previous_route"], "gmail-connector")
        # Long after, it is a new topic.
        later = jev_answer("answer", 0.9)
        pwa_router.decide("what is 2+2", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, session_id="s-1",
                          key="k", post=later, now=1300.0 + 3 * 3600)
        self.assertNotIn("previous_message", later.calls[0]["body"]["state"])

    def test_an_unsure_pick_is_a_guess_and_the_router_decides(self):
        decision = pwa_router.decide("hmm", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="k", post=jev_answer("manager", 0.42))
        self.assertEqual((decision["route"], decision["guess"], decision["source"]), (None, "manager", "router"))

    def test_without_a_key_jev_is_not_asked(self):
        decision = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key=None)
        self.assertEqual((decision["route"], decision["source"], decision["reason"]), (None, "router", "no Jev key on the Mac"))

    def test_jev_failures_become_a_reason(self):
        cases = [
            (pwa_router.VERCEL, 401, "", "Vercel AI Gateway refused the key"),
            (pwa_router.VERCEL, 402, "", "Vercel AI Gateway is out of credits"),
            (pwa_router.VERCEL, 403, '{"error":"Insufficient funds: add AI Gateway credits"}', "Vercel AI Gateway is out of credits"),
            (pwa_router.VERCEL, 403, '{"error":"This model is not available on the free tier"}', "Jev is not in Vercel AI Gateway's free tier"),
            (pwa_router.VERCEL, 429, "", "Vercel AI Gateway is rate limiting"),
            (pwa_router.OPENROUTER, 402, "", "OpenRouter is out of credits"),
            (pwa_router.OPENROUTER, 500, "", "OpenRouter answered 500"),
        ]
        for provider, status, body, reason in cases:
            with self.subTest(provider=provider.name, status=status, body=body):
                decision = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                             provider=provider, post=failing(status, body))
                self.assertEqual((decision["route"], decision["reason"]), (None, reason))

        def timeout(url, headers, body, timeout):
            raise TimeoutError("timed out")

        self.assertEqual(
            pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k", post=timeout)["reason"],
            "Jev took too long",
        )
        # A choice that is not one of the options is not followed.
        self.assertIsNone(
            pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                              post=jev_answer("signal-connector", 0.99))["route"]
        )

    def test_no_one_to_hand_to_means_answer(self):
        decision = pwa_router.decide("hi", bot="router", settings=ON, graph={"nodes": {"router": {"reportsTo": None, "canMessage": [], "role": ""}}}, routes={}, key="k")
        self.assertEqual(decision["route"], "answer")


class DirectiveTests(unittest.TestCase):
    def test_says_what_to_do_for_each_outcome(self):
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        answer = pwa_router.directive("router", {"route": "answer", "source": "jev", "confidence": 0.93, "options": options}, False)
        self.assertIn("picked you to answer it yourself (93% sure)", answer)
        hand = pwa_router.directive("router", {"route": "manager", "source": "jev", "confidence": 0.81, "options": options}, True)
        self.assertIn("Jev picked Manager (@manager) for this (81% sure)", hand)
        self.assertIn('profile "manager", role "orchestrator"', hand)
        flat = pwa_router.directive("router", {"route": "gmail-connector", "source": "jev", "confidence": 0.8, "options": options}, True)
        self.assertNotIn("orchestrator", flat)
        unsure = pwa_router.directive("router", {"route": None, "guess": "manager", "confidence": 0.4, "source": "router", "options": options}, False)
        self.assertIn("best guess Manager (@manager), 40%", unsure)
        self.assertIn("Decide yourself", unsure)
        self.assertIn("Gmail Connector (@gmail-connector): Reads and sends email", unsure)
        off = pwa_router.directive("router", {"route": None, "reason": "no Jev key on the Mac", "source": "router", "options": options}, False)
        self.assertIn("Jev did not decide this time (no Jev key on the Mac)", off)
        for text in (answer, hand, flat, unsure, off):
            self.assertNotIn("—", text)


class CredentialTests(TempHome):
    def write_env(self, text):
        (Path(self.tmp.name) / ".env").write_text(text, encoding="utf-8")
        pwa_router.forget_previous()  # the cache keys on the file's stamp, which a fast rewrite can repeat

    def test_reads_the_key_from_hermes_env_and_picks_the_service(self):
        self.assertIsNone(pwa_router.jev_credentials())
        self.write_env("ANTHROPIC_API_KEY=sk-ant-x\nHERMES_PWA_JEV_API_KEY=vck_abc123\n")
        provider, key = pwa_router.jev_credentials()
        self.assertEqual((provider.name, key), ("vercel", "vck_abc123"))
        # A copied env line and quotes are cleaned off; an OpenRouter key is told apart by its prefix.
        self.write_env('HERMES_PWA_JEV_API_KEY="AI_GATEWAY_API_KEY=vck_line"\n')
        self.assertEqual(pwa_router.jev_credentials()[1], "vck_line")
        self.write_env("export HERMES_PWA_JEV_API_KEY='sk-or-v1-abc'\n")
        self.assertEqual(pwa_router.jev_credentials()[0].name, "openrouter")

    def test_the_env_file_wins_and_hermes_keys_are_the_fallback(self):
        with patch.dict(os.environ, {"HERMES_PWA_JEV_API_KEY": "vck_old"}):
            self.write_env("HERMES_PWA_JEV_API_KEY=vck_new\n")
            self.assertEqual(pwa_router.jev_credentials()[1], "vck_new")
        self.write_env("AI_GATEWAY_API_KEY=vck_hermes\n")
        self.assertEqual([*map(lambda x: getattr(x, "name", x), pwa_router.jev_credentials())], ["vercel", "vck_hermes"])
        self.write_env("OPENROUTER_API_KEY=sk-or-hermes\nHERMES_PWA_JEV_API_KEY=op://vault/item/key\n")
        self.assertEqual(pwa_router.jev_credentials()[0].name, "openrouter")

    def test_status_says_which_service_without_the_key(self):
        self.assertEqual(pwa_router.status()["keyConfigured"], False)
        self.assertIsNone(pwa_router.status()["provider"])
        self.write_env("HERMES_PWA_JEV_API_KEY=vck_secret_value\n")
        status = pwa_router.status()
        self.assertEqual((status["keyConfigured"], status["provider"], status["keyName"]), (True, "Vercel AI Gateway", "HERMES_PWA_JEV_API_KEY"))
        self.assertNotIn("vck_secret_value", json.dumps(status))


class HookAndLogTests(TempHome):
    def hook(self, message, session="s-1", **kwargs):
        with patch.object(pwa_router, "delegation_routes", return_value=(ROUTES, False)):
            return pwa_router.hook_context(session, message, bot=kwargs.pop("bot", "router"), **kwargs)

    def test_off_until_turned_on_and_only_for_the_router(self):
        bot_graph.save(ROUTER_ON_TOP)
        self.assertIsNone(self.hook("hello"))
        pwa_router.save_settings({"enabled": True})
        self.assertIn("Jev did not decide this time", self.hook("hello"))
        self.assertIsNone(self.hook("hello", bot="manager"))
        self.assertIsNone(self.hook("hello", parent_session_id="parent"))
        self.assertIsNone(self.hook("[Background process notification] job 4 finished"))
        self.assertIsNone(self.hook("   "))

    def test_a_key_added_later_works_without_a_restart(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        self.assertIn("no Jev key on the Mac", self.hook("hello"))
        (Path(self.tmp.name) / ".env").write_text("HERMES_PWA_JEV_API_KEY=vck_test\n", encoding="utf-8")
        post = vercel_answer("answer", 0.97)
        self.assertIn("picked you to answer it yourself (97% sure)", self.hook("what is 15% of 2340?", post=post))
        self.assertEqual(post.calls[0]["headers"]["Authorization"], "Bearer vck_test")
        self.assertEqual((pwa_router.recent()[0]["provider"], pwa_router.recent()[0]["zdr"]), ("vercel", True))

    def test_logs_each_decision_without_the_message(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["OPENROUTER_API_KEY"] = "sk-or-test"
        self.addCleanup(os.environ.pop, "OPENROUTER_API_KEY", None)
        message = "Please check my inbox for anything from the Kahunas clients about Friday and draft replies"
        text = self.hook(message, post=jev_answer("gmail-connector", 0.88))
        self.assertIn("Jev picked Gmail Connector (@gmail-connector)", text)
        self.hook("2+2?", session="s-2", post=jev_answer("answer", 0.97))
        newest = pwa_router.recent()
        self.assertEqual([d["route"] for d in newest], ["answer", "gmail-connector"])
        entry = pwa_router.recent(session_id="s-1")[0]
        self.assertEqual(entry["key"], pwa_router.text_key(message))
        self.assertTrue(entry["preview"].endswith("…"))
        self.assertLessEqual(len(entry["preview"]), pwa_router.PREVIEW_CHARS)
        self.assertEqual((entry["source"], entry["confidence"], entry["sessionId"]), ("jev", 0.88, "s-1"))
        raw = pwa_router.decisions_path().read_text(encoding="utf-8")
        self.assertNotIn("draft replies", raw)
        self.assertEqual(oct(pwa_router.decisions_path().stat().st_mode & 0o777), "0o600")

    def test_log_keeps_the_newest(self):
        with patch.object(pwa_router, "LOG_KEEP", 3):
            for i in range(5):
                pwa_router.record({"route": "answer", "source": "jev"}, bot="router", session_id="s", message=f"m{i}")
        self.assertEqual([d["preview"] for d in pwa_router.recent()], ["m4", "m3", "m2"])

    def test_text_key_matches_the_app(self):
        # The phone app computes the same fingerprint (packages/web/src/lib/routerDecisions.test.ts).
        self.assertEqual(pwa_router.text_key("  Hello   world \n"), "594d29c7")
        self.assertEqual(pwa_router.text_key("Draft an email to Kahunas clients about Friday’s check-ins \U0001F680"), "28d37499")


class RouteTests(TempHome):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.anonymous = TestClient(app)

    def test_requires_dashboard_auth(self):
        self.assertIn(self.anonymous.get("/router").status_code, (401, 403))
        self.assertIn(self.anonymous.put("/router", json={"enabled": True}).status_code, (401, 403))
        self.assertIn(self.anonymous.get("/router/decisions").status_code, (401, 403))

    def test_status_save_and_decisions(self):
        body = self.client.get("/router").json()
        self.assertEqual(body["settings"]["enabled"], False)
        self.assertEqual(body["keyConfigured"], False)
        self.assertEqual(body["decisions"], [])
        saved = self.client.put("/router", json={"enabled": True, "bot": "router"})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["settings"]["enabled"])
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}):
            body = self.client.get("/router").json()
            self.assertEqual((body["keyConfigured"], body["provider"]), (True, "OpenRouter"))
        bad = self.client.put("/router", json={"minConfidence": 5})
        self.assertEqual(bad.status_code, 400)
        pwa_router.record({"route": "manager", "source": "jev", "confidence": 0.8}, bot="router", session_id="s-1", message="plan my week")
        pwa_router.record({"route": "answer", "source": "jev", "confidence": 0.9}, bot="router", session_id="s-2", message="hi")
        only = self.client.get("/router/decisions", params={"session_id": "s-1"}).json()["decisions"]
        self.assertEqual([d["route"] for d in only], ["manager"])
        self.assertEqual(len(self.client.get("/router").json()["decisions"]), 2)


class RuntimeHookTests(TempHome):
    def test_pre_llm_call_adds_the_team_map_and_the_router_note(self):
        root = Path(__file__).resolve().parents[2]
        module_name = "hermes_pwa_router_runtime_test"
        for key in [k for k in sys.modules if k == module_name or k.startswith(f"{module_name}.")]:
            sys.modules.pop(key, None)
        spec = importlib.util.spec_from_file_location(module_name, root / "__init__.py", submodule_search_locations=[str(root)])
        runtime = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = runtime
        spec.loader.exec_module(runtime)
        graph_module = sys.modules[f"{module_name}.bot_graph"]
        router_module = sys.modules[f"{module_name}.pwa_router"]
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        post = jev_answer("manager", 0.86)
        with patch.object(graph_module, "_root_hermes_home", return_value=Path(self.tmp.name)), patch.object(
            graph_module, "_current_bot", return_value="router"
        ), patch.object(router_module, "delegation_routes", return_value=(ROUTES, True)), patch.object(
            router_module, "_post_json", post
        ), patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}):
            first = runtime._on_pre_llm_call(session_id="s-1", user_message="Plan my week across email and calendar")["context"]
            self.assertIn("You are Router (@router).", first)
            self.assertIn('Jev picked Manager (@manager) for this (86% sure). Hand it over with delegate_task, profile "manager", role "orchestrator"', first)
            second = runtime._on_pre_llm_call(session_id="s-1", user_message="thanks")["context"]
            self.assertNotIn("You are Router", second)
            self.assertIn("Jev picked Manager", second)
            # A delegated child of the router is left alone.
            self.assertIsNone(runtime._on_pre_llm_call(session_id="c-1", parent_session_id="s-1", user_message="do it"))


if __name__ == "__main__":
    unittest.main()
