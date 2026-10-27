import importlib
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import agent_history
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


def _make_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, model TEXT, profile_name TEXT,
            started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER, tool_call_count INTEGER,
            input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL,
            parent_session_id TEXT, last_activity_at REAL, last_activity_description TEXT
        )
        """
    )
    conn.execute(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL)"
    )
    conn.commit()
    return conn


class AgentHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hermes = Path(self.tmp.name) / ".hermes"
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.hermes)}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        agent_history.clear_cache()
        self.addCleanup(agent_history.clear_cache)

    def test_lists_subagent_sessions_newest_first_with_their_answer(self):
        now = 1_792_860_000.0
        conn = _make_db(self.hermes / "state.db")
        conn.execute(
            "INSERT INTO sessions VALUES ('parent', 'oneshot', 'Check calendar via delegate', 'claude-sonnet-5', 'default', ?, NULL, NULL, 4, 1, 0, 0, NULL, NULL, NULL, NULL, NULL)",
            (now - 400,),
        )
        conn.execute(
            "INSERT INTO sessions VALUES ('sub1', 'subagent', 'Subagent: Check the calendar for today', 'claude-sonnet-5', 'google-calander', ?, ?, 'agent_close', 13, 6, 12, 5492, 0.02, NULL, 'parent', ?, 'done')",
            (now - 300, now - 240, now - 240),
        )
        conn.execute(
            "INSERT INTO sessions VALUES ('sub2', 'subagent', 'Subagent: Find the biggest downloads', 'claude-sonnet-5', NULL, ?, NULL, NULL, 2, 1, 0, 0, NULL, NULL, 'parent', ?, 'running ls')",
            (now - 60, now - 10),
        )
        conn.execute(
            "INSERT INTO sessions VALUES ('sub3', 'subagent', 'Subagent: Old one', 'm', 'manager', ?, ?, 'ws_orphan_reap', 1, 0, 0, 0, NULL, NULL, NULL, NULL, NULL)",
            (now - 40 * 86400, now - 40 * 86400 + 10),
        )
        conn.execute(
            "INSERT INTO sessions VALUES ('chat', 'tui', 'A normal chat', 'm', 'default', ?, NULL, NULL, 3, 0, 0, 0, NULL, NULL, NULL, NULL, NULL)",
            (now - 100,),
        )
        conn.executemany(
            "INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)",
            [
                ("sub1", "user", "Check the calendar", None, now - 300),
                ("sub1", "assistant", "", '[{"function": {"name": "terminal"}}]', now - 290),
                ("sub1", "assistant", "## Summary\n\nTwo events today.", None, now - 245),
            ],
        )
        conn.commit()
        conn.close()
        conn = _make_db(self.hermes / "profiles" / "manager" / "state.db")
        conn.execute(
            "INSERT INTO sessions VALUES ('sub4', 'subagent', 'Subagent: Draft the reply', 'claude-sonnet-5', 'gmail-connector', ?, ?, 'error: provider timeout', 2, 1, 0, 0, NULL, NULL, 'missing-parent', NULL, NULL)",
            (now - 200, now - 190),
        )
        conn.commit()
        conn.close()

        result = agent_history.build_history(hermes_root=self.hermes, days=30, now=now)
        self.assertEqual(result["profiles"], ["default", "manager"])
        runs = result["runs"]
        self.assertEqual([run["id"] for run in runs], ["sub2", "sub4", "sub1"])
        running, failed, done = runs
        self.assertEqual(running["status"], "running")
        self.assertEqual(running["bot"], "default")
        self.assertAlmostEqual(running["duration_seconds"], 60, delta=0.01)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["owner_profile"], "manager")
        self.assertEqual(failed["parent"], {"id": "missing-parent", "title": None, "source": None, "profile": None})
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["bot"], "google-calander")
        self.assertEqual(done["goal"], "Check the calendar for today")
        self.assertEqual(done["result"], "## Summary\n\nTwo events today.")
        self.assertEqual(done["parent"]["title"], "Check calendar via delegate")
        self.assertEqual(done["cost_usd"], 0.02)
        self.assertAlmostEqual(done["duration_seconds"], 60)

    def test_stale_unfinished_run_is_unknown_and_old_rows_fall_outside_the_window(self):
        now = 1_792_860_000.0
        conn = _make_db(self.hermes / "state.db")
        conn.execute(
            "INSERT INTO sessions VALUES ('stale', 'subagent', 'Subagent: Never finished', 'm', 'default', ?, NULL, NULL, 1, 0, 0, 0, NULL, NULL, NULL, ?, NULL)",
            (now - 7200, now - 7000),
        )
        conn.commit()
        conn.close()
        result = agent_history.build_history(hermes_root=self.hermes, days=30, now=now)
        self.assertEqual(result["runs"][0]["status"], "unknown")
        self.assertIsNone(result["runs"][0]["duration_seconds"])
        self.assertEqual(agent_history.build_history(hermes_root=self.hermes, days=1, now=now + 3 * 86400)["runs"], [])

    def test_missing_database_is_empty(self):
        result = agent_history.build_history(hermes_root=self.hermes / "nope", days=30, now=1.0)
        self.assertEqual(result, {"profiles": [], "days": 30, "scanned_at": 1.0, "total": 0, "runs": []})

    def test_cached_history_is_bounded_snaps_days_and_applies_the_limit(self):
        built = []

        def fake_build(*, days, limit, now):
            built.append((days, limit))
            return {"profiles": [], "days": days, "runs": [{"id": f"r{i}"} for i in range(4)], "total": 4}

        with patch.object(agent_history, "build_history", fake_build):
            first = agent_history.cached_history(days=10, limit=2)
            self.assertEqual(first["days"], 30)
            self.assertEqual([run["id"] for run in first["runs"]], ["r0", "r1"])
            self.assertEqual(first["total"], 4)
            second = agent_history.cached_history(days=30, limit=99999)
            self.assertEqual(len(second["runs"]), 4)
            self.assertEqual(built, [(30, agent_history.MAX_LIMIT)])
            for days in (7, 60, 365, 3650):
                agent_history.cached_history(days=days, limit=200)
            self.assertEqual(len(built), 5)
            self.assertLessEqual(len(agent_history._CACHE), 4)
            agent_history.cached_history(days=30, limit=200)
            self.assertEqual(len(built), 6)
            self.assertEqual(built[-1], (30, agent_history.MAX_LIMIT))


class AgentHistoryRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router, prefix="/api/plugins/hermes-pwa")
        self.client = TestClient(app)

    def test_requires_auth_and_clamps(self):
        self.assertEqual(self.client.get("/api/plugins/hermes-pwa/agents/history").status_code, 401)
        seen = {}

        def fake(days, limit):
            seen.update(days=days, limit=limit)
            return {"profiles": [], "runs": [], "total": 0}

        with patch("dashboard.plugin_api.agent_cached_history", fake):
            response = self.client.get(
                "/api/plugins/hermes-pwa/agents/history?days=0&limit=99999",
                headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen, {"days": 1, "limit": 1000})
        self.assertEqual(response.headers["cache-control"], "private, no-store")


if __name__ == "__main__":
    unittest.main()
