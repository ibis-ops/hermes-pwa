import json
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from dashboard import plugin_api
from dashboard.plugin_api import router
from push_common import endpoint_hash, record_pending_approval, upsert_push_subscription

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


class PluginPushApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(
            os.environ,
            {
                "HERMES_HOME": self.tmp.name,
                "HERMES_PWA_VAPID_PRIVATE_KEY": "",
                "HERMES_PWA_VAPID_PUBLIC_KEY": "",
                # Tests use push.example endpoints; production only accepts browser push hosts.
                "HERMES_PWA_PUSH_ALLOW_ANY_ENDPOINT": "1",
            },
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        plugin_api._clear_update_check_cache()
        self.addCleanup(plugin_api._clear_update_check_cache)
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})

    def test_sensitive_routes_require_dashboard_auth(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        self.assertEqual(client.get("/push/status").status_code, 401)
        self.assertEqual(client.get("/actions/pending").status_code, 401)
        self.assertEqual(client.get("/sessions/messaging-bindings").status_code, 401)
        self.assertEqual(client.get("/backups").status_code, 401)
        self.assertEqual(client.get("/diagnostics").status_code, 401)
        self.assertEqual(client.get("/install-info").status_code, 401)
        self.assertEqual(client.get("/update/check").status_code, 401)

    def test_public_app_routes_remain_open(self):
        with tempfile.TemporaryDirectory() as dist:
            # Resolved: on macOS the temp dir lives under /private, and the
            # route resolves candidates before the containment check.
            root = Path(dist).resolve()
            (root / "index.html").write_text("<!doctype html><title>Hermes Mobile</title>", encoding="utf-8")
            with patch("dashboard.plugin_api._DIST_ROOT", root):
                app = FastAPI()
                app.include_router(router)
                client = TestClient(app)

                self.assertEqual(client.get("/app/").status_code, 200)

    def test_health_route_is_public_for_external_monitors(self):
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        response = client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], True)
        self.assertNotIn("cross-origin-resource-policy", response.headers)

    def test_authenticated_metadata_routes_remain_available(self):
        self.assertEqual(self.client.get("/install-info").status_code, 200)
        self.assertEqual(self.client.get("/diagnostics").status_code, 200)
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_data_routes_carry_isolation_headers(self):
        for path in (
            "/install-info",
            "/diagnostics",
            "/backups",
            "/sessions/messaging-bindings",
            "/actions/pending",
            "/push/status",
        ):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"], path)
            self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin", path)
            self.assertEqual(response.headers["x-content-type-options"], "nosniff", path)
            self.assertEqual(response.headers["cache-control"], "private, no-store", path)
        with patch("dashboard.plugin_api._fetch_npm_latest_version", return_value="0.0.1"):
            response = self.client.get("/update/check")
        self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")
        response = self.client.post("/push/unsubscribe", json={"id": "nope"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")

    def test_oversized_json_bodies_are_refused(self):
        big = {"subscription": {"endpoint": "https://push.example/sub/1", "keys": {"p256dh": "p", "auth": "a"}}, "pad": "x" * (plugin_api.MAX_JSON_BODY_BYTES + 1)}
        response = self.client.post("/push/subscribe", json=big)
        self.assertEqual(response.status_code, 413)
        # A lying Content-Length is refused on the header alone.
        response = self.client.post(
            "/push/unsubscribe",
            content=b"{}",
            headers={"content-type": "application/json", "content-length": str(plugin_api.MAX_JSON_BODY_BYTES + 1)},
        )
        self.assertEqual(response.status_code, 413)
        store = Path(self.tmp.name) / "plugins" / "hermes-pwa" / "push_subscriptions.json"
        self.assertFalse(store.exists())
        ok = self.client.post("/push/unsubscribe", json={"id": "x" * 1000})
        self.assertEqual(ok.status_code, 200)

    def test_push_status_gracefully_unavailable_without_sender_or_vapid(self):
        response = self.client.get("/push/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["available"])
        self.assertNotIn("HERMES_PWA_VAPID_PRIVATE_KEY", data)
        self.assertEqual(data["subscriptions"], [])

    def test_subscribe_returns_safe_record_and_persists_raw_endpoint_locally(self):
        response = self.client.post(
            "/push/subscribe?profile=default",
            json={
                "label": "iPhone",
                "subscription": {
                    "endpoint": "https://push.example/sub/1",
                    "keys": {"p256dh": "p256", "auth": "auth"},
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], endpoint_hash("https://push.example/sub/1"))
        self.assertNotIn("endpoint", data["subscription"])
        self.assertNotIn("keys", data["subscription"])

        store = Path(self.tmp.name) / "plugins" / "hermes-pwa" / "push_subscriptions.json"
        self.assertTrue(store.exists())
        self.assertIn("https://push.example/sub/1", store.read_text(encoding="utf-8"))

    def test_unsubscribe_is_idempotent(self):
        sub = {
            "endpoint": "https://push.example/sub/1",
            "keys": {"p256dh": "p256", "auth": "auth"},
        }
        self.client.post("/push/subscribe", json={"subscription": sub})
        response = self.client.post("/push/unsubscribe", json={"endpoint": sub["endpoint"]})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        again = self.client.post("/push/unsubscribe", json={"endpoint": sub["endpoint"]})
        self.assertEqual(again.status_code, 200)

    def test_push_status_is_profile_scoped(self):
        self.client.post(
            "/push/subscribe?profile=default",
            json={"subscription": {"endpoint": "https://push.example/sub/default", "keys": {"p256dh": "p", "auth": "a"}}},
        )
        self.client.post(
            "/push/subscribe?profile=work",
            json={"subscription": {"endpoint": "https://push.example/sub/work", "keys": {"p256dh": "p", "auth": "a"}}},
        )

        response = self.client.get("/push/status?profile=default")

        self.assertEqual(response.status_code, 200)
        subscriptions = response.json()["subscriptions"]
        self.assertEqual([sub["profile"] for sub in subscriptions], ["default"])

    def test_push_test_cannot_target_another_profile_subscription(self):
        self.client.post(
            "/push/subscribe?profile=work",
            json={"subscription": {"endpoint": "https://push.example/sub/work", "keys": {"p256dh": "p", "auth": "a"}}},
        )
        sub_id = endpoint_hash("https://push.example/sub/work")

        with patch("dashboard.plugin_api._push_availability", return_value=(True, None)):
            response = self.client.post("/push/test?profile=default", json={"id": sub_id})

        self.assertEqual(response.status_code, 404)

    def test_unsubscribe_cannot_disable_another_profile_subscription(self):
        self.client.post(
            "/push/subscribe?profile=work",
            json={"subscription": {"endpoint": "https://push.example/sub/work", "keys": {"p256dh": "p", "auth": "a"}}},
        )
        sub_id = endpoint_hash("https://push.example/sub/work")

        response = self.client.post("/push/unsubscribe?profile=default", json={"id": sub_id})

        self.assertEqual(response.status_code, 404)
        store = Path(self.tmp.name) / "plugins" / "hermes-pwa" / "push_subscriptions.json"
        records = json.loads(store.read_text(encoding="utf-8"))
        self.assertTrue(records[0]["enabled"])

    def test_push_test_persists_sanitized_last_error(self):
        self.client.post(
            "/push/subscribe?profile=default",
            json={"subscription": {"endpoint": "https://push.example/sub/default-secret-token", "keys": {"p256dh": "p", "auth": "a"}}},
        )
        sub_id = endpoint_hash("https://push.example/sub/default-secret-token")

        with patch("dashboard.plugin_api._push_availability", return_value=(True, None)):
            with patch(
                "dashboard.plugin_api._send_push_record",
                side_effect=RuntimeError("failed https://push.example/sub/default-secret-token token=abc"),
            ):
                response = self.client.post("/push/test?profile=default", json={"id": sub_id})

        self.assertEqual(response.status_code, 502)
        store = Path(self.tmp.name) / "plugins" / "hermes-pwa" / "push_subscriptions.json"
        records = json.loads(store.read_text(encoding="utf-8"))
        self.assertNotIn("https://push.example", records[0]["last_error"])
        self.assertNotIn("abc", records[0]["last_error"])

    def test_pending_actions_returns_persisted_approvals(self):
        record_pending_approval(
            session_key="telegram:123",
            command="rm -rf /tmp/example",
            description="delete in temp",
            pattern_key="rm-rf",
            profile="default",
            request_id="req-9",
        )
        response = self.client.get("/actions/pending?profile=default")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["items"][0]["kind"], "approval")
        self.assertEqual(data["items"][0]["session_id"], "telegram:123")
        self.assertEqual(data["items"][0]["request_id"], "req-9")

    def test_push_test_status_write_keeps_a_subscription_added_during_the_send(self):
        self.client.post(
            "/push/subscribe?profile=default",
            json={"subscription": {"endpoint": "https://push.example/sub/first", "keys": {"p256dh": "p", "auth": "a"}}},
        )
        first_id = endpoint_hash("https://push.example/sub/first")

        def send(record, payload):
            # Another device registers while the push service is being waited on.
            upsert_push_subscription(
                {"endpoint": "https://push.example/sub/second", "keys": {"p256dh": "p", "auth": "a"}}, profile="default"
            )

        with patch("dashboard.plugin_api._push_availability", return_value=(True, None)):
            with patch("dashboard.plugin_api._send_push_record", side_effect=send):
                response = self.client.post("/push/test?profile=default", json={"id": first_id})

        self.assertEqual(response.status_code, 200)
        store = Path(self.tmp.name) / "plugins" / "hermes-pwa" / "push_subscriptions.json"
        records = {record["endpoint"]: record for record in json.loads(store.read_text(encoding="utf-8"))}
        self.assertEqual(set(records), {"https://push.example/sub/first", "https://push.example/sub/second"})
        self.assertIsNotNone(records["https://push.example/sub/first"]["last_success_at"])
        self.assertTrue((store.parent / "push_subscriptions.json.lock").exists())

    def test_test_push_requires_available_sender(self):
        response = self.client.post("/push/test", json={"id": "missing"})
        self.assertEqual(response.status_code, 503)


class BackupSizeCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # HOME too: the listing also globs ~/hermes-backup-*.zip.
        self.env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name, "HOME": self.tmp.name}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        plugin_api._tree_size_cache.clear()
        self.addCleanup(plugin_api._tree_size_cache.clear)

    def test_backup_directory_sizes_are_walked_once_per_minute(self):
        backup = Path(self.tmp.name) / "backups" / "2026-10-26"
        backup.mkdir(parents=True)
        (backup / "a.bin").write_bytes(b"x" * 10)
        (backup / "nested").mkdir()
        (backup / "nested" / "b.bin").write_bytes(b"y" * 5)

        with patch("dashboard.plugin_api._walk_tree_size", wraps=plugin_api._walk_tree_size) as walk:
            first = plugin_api._backup_entries()
            second = plugin_api._backup_entries()
        self.assertEqual([entry["bytes"] for entry in first], [15])
        self.assertEqual(second, first)
        self.assertEqual(walk.call_count, 1)

        # A changed directory (new mtime) is walked again; so is an expired entry.
        (backup / "c.bin").write_bytes(b"z" * 3)
        os.utime(backup, (backup.stat().st_atime, backup.stat().st_mtime + 10))
        with patch("dashboard.plugin_api._walk_tree_size", wraps=plugin_api._walk_tree_size) as walk:
            self.assertEqual(plugin_api._backup_entries()[0]["bytes"], 18)
            for key, (stamp, size) in list(plugin_api._tree_size_cache.items()):
                plugin_api._tree_size_cache[key] = (stamp - plugin_api.TREE_SIZE_CACHE_SECONDS - 1, size)
            self.assertEqual(plugin_api._backup_entries()[0]["bytes"], 18)
        self.assertEqual(walk.call_count, 2)

    def test_archive_sizes_come_from_stat(self):
        backups = Path(self.tmp.name) / "backups"
        backups.mkdir()
        (backups / "snap.zip").write_bytes(b"PK" * 4)
        with patch("dashboard.plugin_api._walk_tree_size") as walk:
            entries = plugin_api._backup_entries()
        self.assertEqual([(e["kind"], e["bytes"]) for e in entries], [("archive", 8)])
        walk.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class PublicUrlOriginTests(unittest.TestCase):
    """Phone-facing links prefer dashboard.public_url when the tab is opened on loopback."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        app = FastAPI()
        app.include_router(router)
        self.app = app

    def _write_config(self, text: str) -> None:
        Path(self.tmp.name, "config.yaml").write_text(text, encoding="utf-8")

    def _diagnostics(self, base_url: str) -> dict:
        client = TestClient(self.app, base_url=base_url, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        response = client.get("/diagnostics")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_loopback_request_uses_configured_public_url(self):
        self._write_config("dashboard:\n  public_url: https://mac.example.ts.net\n")
        body = self._diagnostics("http://127.0.0.1:9119")
        self.assertEqual(body["origin"], "http://127.0.0.1:9119")
        self.assertEqual(
            body["app_url"],
            "https://mac.example.ts.net/dashboard-plugins/hermes-pwa/dist/mobile/index.html",
        )
        self.assertTrue(body["app_scope"].startswith("https://mac.example.ts.net/"))

    def test_public_request_keeps_its_own_origin(self):
        self._write_config("dashboard:\n  public_url: https://mac.example.ts.net\n")
        body = self._diagnostics("https://other.example.com")
        self.assertEqual(
            body["app_url"],
            "https://other.example.com/dashboard-plugins/hermes-pwa/dist/mobile/index.html",
        )

    def test_loopback_or_invalid_public_url_is_ignored(self):
        for text in (
            "dashboard:\n  public_url: http://localhost:9119\n",
            "dashboard:\n  public_url: hermes.local\n",
            "dashboard:\n  public_url: ''\n",
            "dashboard: []\n",
            "not: yaml: [\n",
        ):
            self._write_config(text)
            body = self._diagnostics("http://127.0.0.1:9119")
            self.assertEqual(
                body["app_url"],
                "http://127.0.0.1:9119/dashboard-plugins/hermes-pwa/dist/mobile/index.html",
                text,
            )

    def test_missing_config_falls_back_to_request_origin(self):
        body = self._diagnostics("http://localhost:9119")
        self.assertEqual(body["origin"], "http://localhost:9119")
        self.assertTrue(body["app_url"].startswith("http://localhost:9119/"))

    def test_env_var_wins_over_config(self):
        self._write_config("dashboard:\n  public_url: https://from-config.example\n")
        with patch.dict(os.environ, {"HERMES_DASHBOARD_PUBLIC_URL": "https://from-env.example/hermes/"}):
            body = self._diagnostics("http://127.0.0.1:9119")
        self.assertEqual(
            body["app_url"],
            "https://from-env.example/hermes/dashboard-plugins/hermes-pwa/dist/mobile/index.html",
        )

    def test_config_is_readable_without_a_yaml_parser(self):
        from dashboard import plugin_api

        text = (
            "# comment\n"
            "gateway:\n"
            "  public_url: https://wrong-section.example\n"
            "dashboard:\n"
            "  bind: 127.0.0.1\n"
            "  public_url: 'https://mac.example.ts.net'  # phone reaches this\n"
            "other:\n"
            "  public_url: https://also-wrong.example\n"
        )
        self.assertEqual(plugin_api._public_url_from_config_text(text), "https://mac.example.ts.net")
        self.assertIsNone(plugin_api._public_url_from_config_text("dashboard:\n  bind: 0.0.0.0\n"))
        self.assertIsNone(plugin_api._public_url_from_config_text("dashboard:\n  public_url: ''\n"))

        self._write_config(text)
        with patch.dict("sys.modules", {"yaml": None}):
            body = self._diagnostics("http://127.0.0.1:9119")
        self.assertEqual(
            body["app_url"],
            "https://mac.example.ts.net/dashboard-plugins/hermes-pwa/dist/mobile/index.html",
        )
