import json
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from dashboard.plugin_api import router
from push_common import endpoint_hash, record_pending_approval

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
            root = Path(dist)
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

    def test_authenticated_metadata_routes_remain_available(self):
        self.assertEqual(self.client.get("/install-info").status_code, 200)
        self.assertEqual(self.client.get("/diagnostics").status_code, 200)
        self.assertEqual(self.client.get("/health").status_code, 200)

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
        )
        response = self.client.get("/actions/pending?profile=default")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["items"][0]["kind"], "approval")
        self.assertEqual(data["items"][0]["session_id"], "telegram:123")

    def test_test_push_requires_available_sender(self):
        response = self.client.post("/push/test", json={"id": "missing"})
        self.assertEqual(response.status_code, 503)


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
