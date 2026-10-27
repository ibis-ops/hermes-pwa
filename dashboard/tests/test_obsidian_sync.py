import importlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import obsidian_sync
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


class FakeMac:
    """pgrep and open, with Obsidian appearing a few checks after it is opened."""

    def __init__(self, running=False, starts_after=2):
        self.running = running
        self.starts_after = starts_after
        self.calls = []
        self._opened = False
        self._checks_since_open = 0

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if argv[0] == "/usr/bin/open":
            self._opened = True
            return SimpleNamespace(returncode=0)
        if self._opened and not self.running:
            self._checks_since_open += 1
            if self._checks_since_open > self.starts_after:
                self.running = True
        return SimpleNamespace(returncode=0 if self.running else 1)


class EnsureOpenTests(unittest.TestCase):
    def setUp(self):
        installed = patch.object(obsidian_sync, "installed", return_value=True)
        installed.start()
        self.addCleanup(installed.stop)

    def test_leaves_a_running_obsidian_alone(self):
        mac = FakeMac(running=True)
        self.assertEqual(obsidian_sync.ensure_open(run=mac, sleep=lambda s: None), {"available": True, "running": True, "started": False})
        self.assertEqual(mac.calls, [["/usr/bin/pgrep", "-x", "Obsidian"]])

    def test_opens_it_in_the_background_and_waits_for_it(self):
        mac = FakeMac(running=False, starts_after=2)
        result = obsidian_sync.ensure_open(run=mac, sleep=lambda s: None)
        self.assertEqual(result, {"available": True, "running": True, "started": True})
        self.assertIn(["/usr/bin/open", "-g", "-a", "Obsidian"], mac.calls)

    def test_says_so_when_it_never_comes_up(self):
        mac = FakeMac(running=False, starts_after=99)
        self.assertEqual(obsidian_sync.ensure_open(run=mac, sleep=lambda s: None), {"available": True, "running": False, "started": True})

    def test_not_on_this_computer(self):
        with patch.object(obsidian_sync, "installed", return_value=False):
            self.assertEqual(obsidian_sync.ensure_open(run=FakeMac()), {"available": False, "running": False, "started": False})


class RouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.anonymous = TestClient(app)

    def test_requires_auth_and_rescans_after_syncing(self):
        self.assertIn(self.anonymous.post("/obsidian/sync").status_code, (401, 403))
        with patch.object(obsidian_sync, "ensure_open", return_value={"available": True, "running": True, "started": True}), patch(
            "dashboard.plugin_api.obsidian_clear_cache"
        ) as cleared:
            response = self.client.post("/obsidian/sync")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"available": True, "running": True, "started": True})
        cleared.assert_called_once()
        cross = self.client.post("/obsidian/sync", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(cross.status_code, 403)


if __name__ == "__main__":
    unittest.main()
