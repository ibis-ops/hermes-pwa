import importlib
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import bot_activity
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")

NOW = 1_792_860_000.0
URL = "/api/plugins/hermes-pwa/bots/activity"
_SCHEMA = (
    "id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, profile_name TEXT, parent_session_id TEXT, "
    "started_at REAL NOT NULL, ended_at REAL, last_activity_at REAL, last_activity_description TEXT"
)


def _write_db(path: Path, *rows: dict, schema: str = _SCHEMA) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute(f"CREATE TABLE sessions ({schema})")
        for row in rows:
            conn.execute(
                f"INSERT INTO sessions ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                tuple(row.values()),
            )
        conn.commit()
    finally:
        conn.close()


def _row(session_id: str, **fields: object) -> dict:
    return {"id": session_id, "source": "tui", "started_at": NOW - 600, **fields}


def _idle() -> dict:
    return {"working": False, "work": [], "last_active_at": None, "last_title": None}


class BotActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hermes = Path(self.tmp.name) / ".hermes"
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.hermes)}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        bot_activity.clear_cache()
        self.addCleanup(bot_activity.clear_cache)

    def _scan(self) -> dict:
        return bot_activity.build_activity(hermes_root=self.hermes, now=NOW)

    def test_only_an_open_session_with_a_fresh_label_is_working(self):
        _write_db(
            self.hermes / "state.db",
            _row("live", title="Plan the week", profile_name="default", last_activity_at=NOW - 30,
                 last_activity_description="executing tool: terminal"),
            _row("edge", last_activity_at=NOW - 180, last_activity_description="starting API call #3"),
            _row("stale", last_activity_at=NOW - 181, last_activity_description="starting API call #2"),
            _row("ended", ended_at=NOW - 10, last_activity_at=NOW - 20,
                 last_activity_description="tool completed: search_files (2.1s)"),
            _row("cleared", last_activity_at=NOW - 5, last_activity_description=""),
            _row("blank", last_activity_at=NOW - 6, last_activity_description="  \n "),
            _row("unlabelled", last_activity_at=NOW - 7),
        )
        result = self._scan()
        self.assertEqual(result["scanned_at"], NOW)
        self.assertEqual(result["working_window_seconds"], 180)
        default = result["bots"]["default"]
        self.assertTrue(default["working"])
        self.assertEqual([item["session_id"] for item in default["work"]], ["live", "edge"])
        self.assertEqual(
            default["work"][0],
            {
                "kind": "chat",
                "title": "Plan the week",
                "activity": "executing tool: terminal",
                "requested_by": None,
                "source": "tui",
                "session_id": "live",
                "started_at": NOW - 600,
                "updated_at": NOW - 30,
            },
        )

    def test_delegated_work_is_credited_to_the_bot_that_runs_it(self):
        _write_db(self.hermes / "state.db")
        for bot in ("gmail-connector", "google-calander", "manager"):
            _write_db(self.hermes / "profiles" / bot / "state.db")
        _write_db(
            self.hermes / "profiles" / "router" / "state.db",
            _row("ask", source="oneshot", title="Sort my morning", profile_name="router", started_at=NOW - 200,
                 last_activity_at=NOW - 10, last_activity_description="tool completed: delegate_task (3.2s)"),
            _row("sub", source="subagent", title="Subagent: Check the calendar for today",
                 profile_name="google-calander", parent_session_id="ask", started_at=NOW - 120,
                 last_activity_at=NOW - 20, last_activity_description="executing tool: terminal"),
            _row("child", source="tui", title="Draft the reply", profile_name="gmail-connector",
                 parent_session_id="ask", started_at=NOW - 90, last_activity_at=NOW - 15,
                 last_activity_description="waiting for stream response (12s, no chunks yet)"),
            _row("own-child", title="Follow up", profile_name="router", parent_session_id="ask",
                 last_activity_at=NOW - 25, last_activity_description="starting API call #1"),
            _row("unnamed-sub", source="subagent", title="Subagent: Tidy notes", parent_session_id="ask",
                 last_activity_at=NOW - 30, last_activity_description="executing tool: patch"),
        )
        bots = self._scan()["bots"]
        self.assertEqual(list(bots), ["default", "gmail-connector", "google-calander", "manager", "router"])
        self.assertEqual(
            bots["google-calander"],
            {
                "working": True,
                "work": [
                    {
                        "kind": "delegated",
                        "title": "Check the calendar for today",
                        "activity": "executing tool: terminal",
                        "requested_by": "router",
                        "source": "subagent",
                        "session_id": "sub",
                        "started_at": NOW - 120,
                        "updated_at": NOW - 20,
                    }
                ],
                "last_active_at": NOW - 20,
                "last_title": "Check the calendar for today",
            },
        )
        child = bots["gmail-connector"]["work"][0]
        self.assertEqual(
            (child["session_id"], child["kind"], child["requested_by"], child["source"]),
            ("child", "delegated", "router", "tui"),
        )
        router_work = bots["router"]["work"]
        self.assertEqual([item["session_id"] for item in router_work], ["ask", "own-child", "unnamed-sub"])
        self.assertEqual([item["kind"] for item in router_work], ["chat", "chat", "delegated"])
        self.assertEqual([item["requested_by"] for item in router_work], [None, None, None])
        self.assertEqual(router_work[2]["title"], "Tidy notes")
        self.assertEqual((bots["router"]["last_active_at"], bots["router"]["last_title"]), (NOW - 10, "Sort my morning"))
        self.assertEqual(bots["manager"], _idle())
        self.assertEqual(bots["default"], _idle())

    def test_kind_follows_the_source(self):
        _write_db(
            self.hermes / "state.db",
            _row("nightly", source="cron", title="Nightly digest", last_activity_at=NOW - 10,
                 last_activity_description="starting API call #1"),
            _row("texts", source="signal", title="Answer the group chat", last_activity_at=NOW - 20,
                 last_activity_description="executing tool: send_message"),
            _row("quick", source="oneshot", last_activity_at=NOW - 30, last_activity_description="starting API call #2"),
        )
        work = self._scan()["bots"]["default"]["work"]
        self.assertEqual(
            [(item["session_id"], item["kind"]) for item in work],
            [("nightly", "scheduled"), ("texts", "messaging"), ("quick", "chat")],
        )
        self.assertIsNone(work[2]["title"])

    def test_work_is_newest_first_and_capped_per_bot(self):
        _write_db(
            self.hermes / "state.db",
            *(_row(f"turn{i}", last_activity_at=NOW - i, last_activity_description=f"starting API call #{i}")
              for i in range(7, 0, -1)),
        )
        default = self._scan()["bots"]["default"]
        self.assertTrue(default["working"])
        self.assertEqual([item["session_id"] for item in default["work"]], ["turn1", "turn2", "turn3", "turn4", "turn5"])

    def test_last_active_is_the_newest_row_of_the_last_30_days(self):
        _write_db(
            self.hermes / "state.db",
            _row("labelled", title="Older turn", started_at=NOW - 90000, ended_at=NOW - 86000,
                 last_activity_at=NOW - 86400, last_activity_description=""),
            _row("finished", title="Subagent:  Weekly   report", started_at=NOW - 3600, ended_at=NOW - 3000),
            _row("opened", title="Just opened", started_at=NOW - 7200),
        )
        _write_db(
            self.hermes / "profiles" / "creator-watch" / "state.db",
            _row("ancient", title="Long ago", started_at=NOW - 40 * 86400, ended_at=NOW - 40 * 86400 + 60),
        )
        bots = self._scan()["bots"]
        self.assertEqual(
            bots["default"],
            {"working": False, "work": [], "last_active_at": NOW - 3000, "last_title": "Weekly report"},
        )
        self.assertEqual(bots["creator-watch"], _idle())

    def test_titles_and_labels_are_one_line_and_cut(self):
        _write_db(
            self.hermes / "state.db",
            _row("a", title="Subagent:   Find\n the   biggest\tdownloads ", last_activity_at=NOW - 1,
                 last_activity_description="  executing tool:\n terminal  "),
            _row("b", title="word " * 100, last_activity_at=NOW - 2, last_activity_description="x" * 300),
            _row("c", title="   ", last_activity_at=NOW - 3, last_activity_description="starting API call #1"),
        )
        first, second, third = self._scan()["bots"]["default"]["work"]
        self.assertEqual((first["title"], first["activity"]), ("Find the biggest downloads", "executing tool: terminal"))
        self.assertEqual(second["title"], ("word " * 32).rstrip() + "…")
        self.assertEqual(second["activity"], "x" * 120 + "…")
        self.assertIsNone(third["title"])

    def test_an_older_schema_without_activity_labels_still_reports_last_active(self):
        _write_db(
            self.hermes / "state.db",
            {"id": "old", "source": "tui", "title": "Before labels", "started_at": NOW - 500, "last_activity_at": NOW - 60},
            schema="id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, ended_at REAL, last_activity_at REAL",
        )
        other = self.hermes / "profiles" / "research-librarian" / "state.db"
        other.parent.mkdir(parents=True)
        conn = sqlite3.connect(other)
        conn.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        bots = self._scan()["bots"]
        self.assertEqual(
            bots["default"],
            {"working": False, "work": [], "last_active_at": NOW - 60, "last_title": "Before labels"},
        )
        self.assertEqual(bots["research-librarian"], _idle())

    def test_missing_home_is_empty(self):
        self.assertEqual(
            bot_activity.build_activity(hermes_root=self.hermes / "nope", now=1.0),
            {"scanned_at": 1.0, "working_window_seconds": 180, "bots": {}},
        )

    def test_cached_activity_is_short_and_kept_per_home(self):
        built = []

        def fake_build(*, now):
            built.append(os.environ["HERMES_HOME"])
            return {"scanned_at": now, "working_window_seconds": 180, "bots": {}}

        self.assertEqual(bot_activity._CACHE.ttl_seconds, 3.0)
        other = str(self.hermes / "other")
        with patch.object(bot_activity, "build_activity", fake_build):
            first = bot_activity.cached_activity()
            self.assertIs(bot_activity.cached_activity(), first)
            with patch.dict(os.environ, {"HERMES_HOME": other}):
                bot_activity.cached_activity()
            bot_activity.clear_cache()
            bot_activity.cached_activity()
        self.assertEqual(built, [str(self.hermes), other, str(self.hermes)])


class BotActivityRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hermes = Path(self.tmp.name) / ".hermes"
        self.env = patch.dict(os.environ, {"HERMES_HOME": str(self.hermes)}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        bot_activity.clear_cache()
        self.addCleanup(bot_activity.clear_cache)
        app = FastAPI()
        app.include_router(router, prefix="/api/plugins/hermes-pwa")
        self.client = TestClient(app)

    def test_requires_auth_and_answers_what_each_bot_is_doing(self):
        now = time.time()
        _write_db(self.hermes / "state.db")
        _write_db(
            self.hermes / "profiles" / "router" / "state.db",
            _row("sub", source="subagent", title="Subagent: Check the inbox", profile_name="gmail-connector",
                 parent_session_id="ask", started_at=now - 60, last_activity_at=now - 5,
                 last_activity_description="executing tool: terminal"),
        )
        self.assertEqual(self.client.get(URL).status_code, 401)
        response = self.client.get(URL, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        body = response.json()
        self.assertEqual(body["working_window_seconds"], 180)
        self.assertEqual(list(body["bots"]), ["default", "router", "gmail-connector"])
        self.assertEqual(body["bots"]["router"], _idle())
        gmail = body["bots"]["gmail-connector"]
        self.assertTrue(gmail["working"])
        self.assertEqual(
            {key: gmail["work"][0][key] for key in ("kind", "title", "requested_by", "session_id")},
            {"kind": "delegated", "title": "Check the inbox", "requested_by": "router", "session_id": "sub"},
        )

    def test_a_failed_scan_answers_an_empty_payload(self):
        def broken():
            raise sqlite3.DatabaseError("database disk image is malformed")

        with patch("dashboard.plugin_api.bot_activity_cached", broken):
            with self.assertLogs("hermes_pwa.files", level="WARNING") as logs:
                response = self.client.get(URL, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(
            {key: body[key] for key in ("working_window_seconds", "bots", "error")},
            {"working_window_seconds": 180, "bots": {}, "error": "scan failed"},
        )
        self.assertIsInstance(body["scanned_at"], float)
        self.assertIn("bot activity scan failed", logs.output[0])


if __name__ == "__main__":
    unittest.main()
