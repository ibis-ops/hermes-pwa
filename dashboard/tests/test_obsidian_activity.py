import importlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import obsidian_activity
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


def _make_state_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL NOT NULL)")
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            timestamp REAL NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def _call(name: str, arguments: dict) -> str:
    return json.dumps([{"id": "t", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}])


class ObsidianActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.vault = self.home / "Desktop" / "General"
        (self.vault / "Clients" / "Ann Lee").mkdir(parents=True)
        (self.vault / ".obsidian").mkdir()
        (self.vault / "Business & Ops").mkdir()
        registry = self.home / "Library" / "Application Support" / "obsidian"
        registry.mkdir(parents=True)
        registry.joinpath("obsidian.json").write_text(
            json.dumps({"vaults": {"abc": {"path": str(self.vault), "open": True}}}), encoding="utf-8"
        )
        # The phone keeps its copy of the vault in iCloud under its own name.
        phone = self.home / "Library" / "Mobile Documents" / "iCloud~md~obsidian" / "Documents" / "Vault 1"
        (phone / "Clients").mkdir(parents=True)
        (phone / "Business & Ops").mkdir()
        (phone / ".obsidian").mkdir()
        self.hermes = self.home / ".hermes"
        self.env = patch.dict(
            os.environ,
            {
                "HERMES_PWA_OBSIDIAN_HOME": str(self.home),
                "HERMES_HOME": str(self.hermes),
                "HERMES_PWA_OBSIDIAN_VAULTS": "",
                "HERMES_PWA_OBSIDIAN_PHONE_VAULT": "",
            },
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        obsidian_activity.clear_cache()
        self.addCleanup(obsidian_activity.clear_cache)

    def _write_note(self, relative: str, text: str = "# note") -> Path:
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_discovers_desktop_vault_and_its_phone_name(self):
        vaults = obsidian_activity.discover_vaults(self.home)
        self.assertEqual([v.name for v in vaults], ["General"])
        self.assertEqual(vaults[0].path, str(self.vault))
        self.assertEqual(vaults[0].phone_name, "Vault 1")
        self.assertTrue(vaults[0].is_open)

    def test_phone_name_override_wins(self):
        with patch.dict(os.environ, {"HERMES_PWA_OBSIDIAN_PHONE_VAULT": "Notes"}):
            vaults = obsidian_activity.discover_vaults(self.home)
        self.assertEqual(vaults[0].phone_name, "Notes")

    def test_vault_override_replaces_registry(self):
        other = self.home / "Obsidian" / "Work"
        other.mkdir(parents=True)
        with patch.dict(os.environ, {"HERMES_PWA_OBSIDIAN_VAULTS": str(other)}):
            vaults = obsidian_activity.discover_vaults(self.home)
        self.assertEqual([(v.name, v.source) for v in vaults], [("Work", "config")])

    def test_new_note_edit_and_shell_write_are_classified(self):
        new_note = self._write_note("Clients/Ann Lee/Ann Lee.md")
        old_note = self._write_note("Business & Ops/Orders — MOC.md")
        shell_note = self._write_note("Inbox/Dictation.md")
        self._write_note("Clients/Gone.md").unlink()  # written by the agent, deleted since
        conn = _make_state_db(self.hermes / "state.db")
        t0 = 1_700_000_000.0
        rows = [
            ("s1", t0 + 10, _call("write_file", {"path": str(new_note), "content": "---\ncreated: 2026-10-23\n---\n# Ann"})),
            ("s1", t0 + 20, _call("read_file", {"path": str(old_note).replace("&", "&amp;")})),
            ("s1", t0 + 30, _call("patch", {"path": str(old_note).replace("&", "&amp;"), "old_string": "a", "new_string": "b"})),
            ("s1", t0 + 40, _call("terminal", {"command": f'cat <<EOF > "{shell_note}"\nhi\nEOF'})),
            ("s1", t0 + 50, _call("write_file", {"path": str(self.vault / "Clients" / "Gone.md"), "content": "x"})),
            ("s1", t0 + 60, _call("write_file", {"path": str(self.vault / ".obsidian" / "app.json"), "content": "{}"})),
            ("s1", t0 + 70, _call("write_file", {"path": str(self.home / "Desktop" / "elsewhere.md"), "content": "x"})),
        ]
        conn.executemany("INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?, 'assistant', ?, ?)", [(s, c, t) for s, t, c in rows])
        conn.commit()
        conn.close()

        result = obsidian_activity.build_activity(home=self.home, hermes_root=self.hermes, days=30, now=t0 + 100)
        self.assertTrue(result["available"])
        self.assertEqual(result["profiles"], ["default"])
        by_path = {entry["path"]: entry for entry in result["notes"]}
        self.assertEqual(set(by_path), {"Clients/Ann Lee/Ann Lee.md", "Business & Ops/Orders — MOC.md", "Inbox/Dictation.md"})
        ann = by_path["Clients/Ann Lee/Ann Lee.md"]
        self.assertEqual(ann["action"], "created")
        self.assertEqual(ann["name"], "Ann Lee")
        self.assertEqual(ann["folder"], "Clients/Ann Lee")
        self.assertEqual(ann["vault"], "General")
        self.assertEqual(ann["phone_vault"], "Vault 1")
        self.assertEqual(ann["profile"], "default")
        self.assertEqual(ann["at"], t0 + 10)
        orders = by_path["Business & Ops/Orders — MOC.md"]
        self.assertEqual(orders["action"], "edited")
        self.assertIsNone(orders["created_at"])
        self.assertEqual(orders["edited_at"], t0 + 30)
        self.assertEqual(by_path["Inbox/Dictation.md"]["action"], "edited")
        # Newest first.
        self.assertEqual([entry["path"] for entry in result["notes"]][0], "Inbox/Dictation.md")

    def test_rewrite_of_a_file_the_session_read_is_an_edit(self):
        note = self._write_note("Clients/Bo/Bo.md")
        conn = _make_state_db(self.hermes / "state.db")
        t0 = 1_700_000_000.0
        conn.execute(
            "INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s1', 'assistant', ?, ?)",
            (_call("read_file", {"path": str(note)}), t0 + 1),
        )
        conn.execute(
            "INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s1', 'assistant', ?, ?)",
            (_call("write_file", {"path": str(note), "content": "new"}), t0 + 2),
        )
        conn.commit()
        conn.close()
        result = obsidian_activity.build_activity(home=self.home, hermes_root=self.hermes, days=30, now=t0 + 10)
        self.assertEqual(result["notes"][0]["action"], "edited")

    def test_profiles_are_scanned_and_named(self):
        note = self._write_note("Research/Paper.md")
        conn = _make_state_db(self.hermes / "profiles" / "obsidian-vault-manager" / "state.db")
        conn.execute(
            "INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('p1', 'assistant', ?, ?)",
            (_call("write_file", {"path": str(note), "content": "x"}), 1_700_000_000.0),
        )
        conn.commit()
        conn.close()
        result = obsidian_activity.build_activity(home=self.home, hermes_root=self.hermes, days=30, now=1_700_000_100.0)
        self.assertEqual(result["profiles"], ["obsidian-vault-manager"])
        self.assertEqual(result["notes"][0]["profile"], "obsidian-vault-manager")

    def test_old_events_are_outside_the_window(self):
        note = self._write_note("Research/Old.md")
        conn = _make_state_db(self.hermes / "state.db")
        conn.execute(
            "INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s', 'assistant', ?, ?)",
            (_call("write_file", {"path": str(note), "content": "x"}), 1_600_000_000.0),
        )
        conn.commit()
        conn.close()
        result = obsidian_activity.build_activity(home=self.home, hermes_root=self.hermes, days=30, now=1_700_000_000.0)
        self.assertEqual(result["notes"], [])
        self.assertEqual(result["total"], 0)

    def test_no_vault_reports_unavailable(self):
        with patch.dict(os.environ, {"HERMES_PWA_OBSIDIAN_HOME": str(self.home / "nope")}):
            result = obsidian_activity.build_activity(home=self.home / "nope", hermes_root=self.hermes)
        self.assertFalse(result["available"])
        self.assertEqual(result["notes"], [])

    def test_rest_api_writes_land_in_the_open_vault(self):
        note = self._write_note("Inbox/Idea.md")
        conn = _make_state_db(self.hermes / "state.db")
        conn.execute(
            "INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES ('s', 'assistant', ?, ?)",
            (
                _call("terminal", {"command": 'curl -s -X PUT -H "Content-Type: text/markdown" --data-binary @/tmp/n.md "http://127.0.0.1:27124/vault/Inbox/Idea.md"'}),
                1_700_000_000.0,
            ),
        )
        conn.commit()
        conn.close()
        result = obsidian_activity.build_activity(home=self.home, hermes_root=self.hermes, days=30, now=1_700_000_100.0)
        self.assertEqual([(n["path"], n["action"]) for n in result["notes"]], [("Inbox/Idea.md", "created")])
        self.assertTrue(note.exists())

    def test_read_note_serves_only_notes_inside_the_vault(self):
        self._write_note("Clients/Ann Lee/Ann Lee.md", "---\ntags: [client]\n---\n# Ann\n")
        (self.home / "Desktop" / "secret.md").write_text("no", encoding="utf-8")
        payload = obsidian_activity.read_note("General", "Clients/Ann Lee/Ann Lee.md", home=self.home)
        self.assertEqual(payload["name"], "Ann Lee")
        self.assertEqual(payload["phone_vault"], "Vault 1")
        self.assertTrue(payload["text"].startswith("---\ntags"))
        for vault, path, status in [
            ("General", "../secret.md", 400),
            ("General", "Clients/../../secret.md", 400),
            ("General", ".obsidian/app.json", 400),
            ("General", "Clients/Ann Lee/photo.png", 400),
            ("General", "Clients/Missing.md", 404),
            ("Nope", "Clients/Ann Lee/Ann Lee.md", 404),
        ]:
            with self.assertRaises(obsidian_activity.NoteAccessError) as ctx:
                obsidian_activity.read_note(vault, path, home=self.home)
            self.assertEqual(ctx.exception.status, status, (vault, path))
        link = self.vault / "Clients" / "Link.md"
        link.symlink_to(self.home / "Desktop" / "secret.md")
        with self.assertRaises(obsidian_activity.NoteAccessError) as ctx:
            obsidian_activity.read_note("General", "Clients/Link.md", home=self.home)
        self.assertEqual(ctx.exception.status, 403)

    def test_shell_write_targets(self):
        targets = obsidian_activity.shell_write_targets(
            'echo hi > "/v/Business & Ops/a.md" && cat b >>/v/c.md; tee -a /v/d.md < in; mv /tmp/x.md "/v/e.md"\ncp a.md /v/f.md | grep x; touch /v/g.md /v/h.md'
        )
        self.assertEqual(targets, ["/v/Business & Ops/a.md", "/v/c.md", "/v/d.md", "/v/e.md", "/v/f.md", "/v/g.md", "/v/h.md"])


class ObsidianActivityRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router, prefix="/api/plugins/hermes-pwa")
        self.client = TestClient(app)
        obsidian_activity.clear_cache()
        self.addCleanup(obsidian_activity.clear_cache)

    def test_requires_dashboard_auth(self):
        response = self.client.get("/api/plugins/hermes-pwa/obsidian/activity")
        self.assertEqual(response.status_code, 401)

    def test_note_route_maps_access_errors(self):
        with patch("dashboard.plugin_api.obsidian_read_note", side_effect=obsidian_activity.NoteAccessError(403, "outside the vault")):
            response = self.client.get(
                "/api/plugins/hermes-pwa/obsidian/note?vault=General&path=x.md",
                headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
            )
        self.assertEqual(response.status_code, 403)
        with patch("dashboard.plugin_api.obsidian_read_note", return_value={"name": "x", "text": "# x"}):
            response = self.client.get(
                "/api/plugins/hermes-pwa/obsidian/note?vault=General&path=x.md",
                headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "# x")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(self.client.get("/api/plugins/hermes-pwa/obsidian/note?vault=General&path=x.md").status_code, 401)

    def test_returns_payload_and_clamps_parameters(self):
        seen = {}

        def fake(days, limit):
            seen["days"] = days
            seen["limit"] = limit
            return {"available": True, "vaults": [], "profiles": [], "notes": [], "total": 0}

        with patch("dashboard.plugin_api.obsidian_cached_activity", fake):
            response = self.client.get(
                "/api/plugins/hermes-pwa/obsidian/activity?days=99999&limit=0",
                headers={_SESSION_HEADER_NAME: _SESSION_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["available"], True)
        self.assertEqual(seen, {"days": 3650, "limit": 1})
        self.assertEqual(response.headers["cache-control"], "private, no-store")


if __name__ == "__main__":
    unittest.main()
