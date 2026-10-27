import importlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from dashboard import plugin_api

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


class UpdateCheckTests(unittest.TestCase):
    def setUp(self):
        plugin_api._clear_update_check_cache()
        self.addCleanup(plugin_api._clear_update_check_cache)

    def test_semver_detects_newer_patch(self):
        self.assertTrue(plugin_api._is_newer_version("0.1.1", "0.1.0"))
        self.assertTrue(plugin_api._is_newer_version("v0.2.0", "0.1.9"))

    def test_semver_equal_or_older_is_not_update(self):
        self.assertFalse(plugin_api._is_newer_version("0.1.0", "0.1.0"))
        self.assertFalse(plugin_api._is_newer_version("0.0.9", "0.1.0"))
        self.assertFalse(plugin_api._is_newer_version(None, "0.1.0"))

    def test_current_version_reads_package_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(json.dumps({"version": "0.1.7"}), encoding="utf-8")
            with patch.object(plugin_api, "_PLUGIN_ROOT", root):
                self.assertEqual(plugin_api._read_package_version(), "0.1.7")

    def test_detect_install_method_from_npm_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".hermes-pwa-install.json").write_text(
                json.dumps({"install_method": "npm", "package": "hermes-pwa"}),
                encoding="utf-8",
            )
            with patch.object(plugin_api, "_PLUGIN_ROOT", root):
                self.assertEqual(plugin_api._detect_install_method(), "npm")

    def test_detect_install_method_from_git_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            with patch.object(plugin_api, "_PLUGIN_ROOT", root):
                self.assertEqual(plugin_api._detect_install_method(), "git")

    def test_build_update_response_requires_manual_instructions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(json.dumps({"version": "0.1.0"}), encoding="utf-8")
            with patch.object(plugin_api, "_PLUGIN_ROOT", root):
                body = plugin_api._build_update_check_response(fetch_latest=lambda: "0.1.1")

        self.assertTrue(body["ok"])
        self.assertEqual(body["current"], "0.1.0")
        self.assertEqual(body["latest"], "0.1.1")
        self.assertTrue(body["update_available"])
        self.assertFalse(body["can_apply"])
        self.assertTrue(body["manual_required"])
        instructions = cast(list[dict[str, object]], body["instructions"])
        self.assertEqual([item["id"] for item in instructions], ["web-ui-force-reinstall", "npx-force-reinstall"])
        npx = next(item for item in instructions if item["id"] == "npx-force-reinstall")
        self.assertEqual(npx["command"], "npx -y hermes-pwa@latest install --force")

    def test_build_update_response_empty_when_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(json.dumps({"version": "0.1.0"}), encoding="utf-8")
            with patch.object(plugin_api, "_PLUGIN_ROOT", root):
                body = plugin_api._build_update_check_response(fetch_latest=lambda: "0.1.0")

        self.assertTrue(body["ok"])
        self.assertFalse(body["update_available"])
        self.assertFalse(body["manual_required"])
        self.assertEqual(body["instructions"], [])

    def test_build_update_response_gracefully_handles_registry_failure(self):
        def fail():
            raise RuntimeError("network down")

        body = plugin_api._build_update_check_response(fetch_latest=fail)

        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], "check-failed")
        self.assertFalse(body["update_available"])
        self.assertEqual(body["instructions"], [])

    def test_update_check_route_returns_manual_update_notification(self):
        app = FastAPI()
        app.include_router(plugin_api.router)
        client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})

        # Use a version clearly newer than any real package version (incl. prereleases
        # like 0.1.1-beta) so this test does not depend on the current package.json.
        with patch.object(plugin_api, "_fetch_npm_latest_version", return_value="99.0.0"):
            response = client.get("/update/check")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["update_available"])
        self.assertFalse(body["can_apply"])
        self.assertTrue(body["manual_required"])
        self.assertFalse(body["cached"])

    def test_update_check_is_cached_for_hours_and_failures_for_minutes(self):
        calls = []

        def fetch():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("registry down")
            return "99.0.0"

        first = plugin_api._cached_update_check(fetch_latest=fetch, now=1000.0)
        self.assertFalse(first["ok"])
        self.assertFalse(first["cached"])
        # The failure is reused for a while, then retried.
        second = plugin_api._cached_update_check(fetch_latest=fetch, now=1000.0 + 60)
        self.assertTrue(second["cached"])
        self.assertEqual(len(calls), 1)
        third = plugin_api._cached_update_check(fetch_latest=fetch, now=1000.0 + plugin_api.UPDATE_CHECK_FAILURE_CACHE_SECONDS)
        self.assertTrue(third["ok"])
        self.assertFalse(third["cached"])
        self.assertEqual(len(calls), 2)
        # A good answer is kept for the long window: no registry call per connect.
        base = 1000.0 + plugin_api.UPDATE_CHECK_FAILURE_CACHE_SECONDS
        for offset in (1, 3600, plugin_api.UPDATE_CHECK_CACHE_SECONDS - 1):
            again = plugin_api._cached_update_check(fetch_latest=fetch, now=base + offset)
            self.assertTrue(again["cached"], offset)
            self.assertEqual(again["latest"], "99.0.0")
        self.assertEqual(len(calls), 2)
        self.assertFalse(plugin_api._cached_update_check(fetch_latest=fetch, now=base + plugin_api.UPDATE_CHECK_CACHE_SECONDS)["cached"])
        self.assertEqual(len(calls), 3)

    def test_update_check_route_calls_the_registry_once(self):
        app = FastAPI()
        app.include_router(plugin_api.router)
        client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})

        with patch.object(plugin_api, "_fetch_npm_latest_version", return_value="99.0.0") as fetch:
            first = client.get("/update/check").json()
            second = client.get("/update/check").json()

        self.assertEqual(fetch.call_count, 1)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["latest"], "99.0.0")

    def test_update_check_route_requires_dashboard_auth(self):
        app = FastAPI()
        app.include_router(plugin_api.router)
        client = TestClient(app)

        response = client.get("/update/check")

        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
