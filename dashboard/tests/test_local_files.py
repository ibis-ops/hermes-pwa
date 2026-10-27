import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import local_files
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")


class LocalFilePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.desktop = self.home / "Desktop"
        self.cache = self.home / ".hermes" / "cache" / "images"
        self.cache.mkdir(parents=True)
        self.desktop.mkdir(parents=True)
        (self.home / "secret.txt").write_text("not served", encoding="utf-8")
        (self.desktop / "shot.png").write_bytes(b"\x89PNG fake")
        (self.desktop / "notes.md").write_text("# notes", encoding="utf-8")
        (self.desktop / "page.html").write_text("<script>alert(1)</script>", encoding="utf-8")
        (self.desktop / "logo.svg").write_text("<svg onload='alert(1)'/>", encoding="utf-8")
        (self.desktop / ".env").write_text("SECRET=1", encoding="utf-8")
        (self.desktop / ".git").mkdir()
        (self.desktop / ".git" / "config").write_text("x", encoding="utf-8")
        (self.cache / "computer_use.png").write_bytes(b"\x89PNG cache")
        self.env = patch.dict(
            os.environ,
            {"HERMES_PWA_FILE_HOME": str(self.home), "HERMES_PWA_FILE_ROOTS": ""},
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def _resolve(self, path):
        return local_files.resolve_served_file(path)

    def test_default_roots_are_the_hermes_dirs_and_user_folders(self):
        roots = {r.name for r in local_files.allowed_roots()}
        self.assertEqual(roots, {"cache", "Desktop"})  # only the dirs that exist

    def test_serves_files_inside_roots(self):
        served = self._resolve(str(self.desktop / "shot.png"))
        self.assertTrue(served.inline)
        self.assertEqual(served.media_type, "image/png")
        self.assertEqual(served.download_name, "shot.png")
        cached = self._resolve(str(self.cache / "computer_use.png"))
        self.assertTrue(cached.inline)

    def test_tilde_paths_expand_to_the_home(self):
        served = self._resolve("~/Desktop/shot.png")
        self.assertEqual(served.path, Path(os.path.realpath(self.desktop / "shot.png")))

    def test_refuses_files_outside_roots(self):
        for raw in (
            str(self.home / "secret.txt"),
            str(self.desktop / ".." / "secret.txt"),
            str(self.home / ".hermes" / "config.yaml"),
            "/etc/passwd",
            str(self.desktop),  # the root itself is not a file
        ):
            with self.assertRaises(local_files.FileAccessError, msg=raw) as ctx:
                self._resolve(raw)
            self.assertIn(ctx.exception.status, (403, 404), raw)

    def test_refuses_empty_paths(self):
        for raw in ("", "   "):
            with self.assertRaises(local_files.FileAccessError) as ctx:
                self._resolve(raw)
            self.assertEqual(ctx.exception.status, 400, raw)

    def test_relative_paths_resolve_against_the_hermes_home(self):
        attachments = self.home / ".hermes" / "attachments"
        attachments.mkdir(parents=True)
        (attachments / "photo.jpg").write_bytes(b"jpg")
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home / ".hermes")}):
            served = self._resolve("attachments/photo.jpg")
            self.assertEqual(served.path, Path(os.path.realpath(attachments / "photo.jpg")))
            # Relative paths cannot reach outside the roots either.
            for raw in ("config.yaml", "../Desktop/shot.png", "Desktop/shot.png"):
                with self.assertRaises(local_files.FileAccessError, msg=raw):
                    self._resolve(raw)
        with self.assertRaises(local_files.FileAccessError) as ctx:
            self._resolve(str(self.desktop / "a\x00b.png"))
        self.assertEqual(ctx.exception.status, 400)

    def test_symlink_escape_is_refused(self):
        link = self.desktop / "escape.txt"
        link.symlink_to(self.home / "secret.txt")
        with self.assertRaises(local_files.FileAccessError) as ctx:
            self._resolve(str(link))
        self.assertEqual(ctx.exception.status, 403)

    def test_hidden_files_and_dirs_inside_roots_are_refused(self):
        for raw in (str(self.desktop / ".env"), str(self.desktop / ".git" / "config")):
            with self.assertRaises(local_files.FileAccessError) as ctx:
                self._resolve(raw)
            self.assertEqual(ctx.exception.status, 403, raw)

    def test_missing_file_is_404(self):
        with self.assertRaises(local_files.FileAccessError) as ctx:
            self._resolve(str(self.desktop / "nope.png"))
        self.assertEqual(ctx.exception.status, 404)

    def test_html_and_svg_are_downloads_not_inline(self):
        for name in ("page.html", "logo.svg"):
            served = self._resolve(str(self.desktop / name))
            self.assertFalse(served.inline, name)
            self.assertEqual(served.media_type, "application/octet-stream", name)
            headers = local_files.response_headers(served)
            self.assertTrue(headers["Content-Disposition"].startswith("attachment;"), name)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertIn("sandbox", headers["Content-Security-Policy"])
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["Cross-Origin-Resource-Policy"], "same-origin")

    def test_open_served_file_hands_back_the_vetted_descriptor(self):
        served, handle = local_files.open_served_file(str(self.desktop / "shot.png"))
        try:
            self.assertEqual(served.size, 9)
            self.assertEqual(handle.read(), b"\x89PNG fake")
            # The descriptor, not the path, is what gets read: replacing the
            # file afterwards does not change what this handle serves.
            (self.desktop / "shot.png").unlink()
            (self.desktop / "shot.png").write_bytes(b"other bytes entirely")
            handle.seek(0)
            self.assertEqual(handle.read(), b"\x89PNG fake")
        finally:
            handle.close()

    def test_iter_file_stops_at_the_promised_size_and_closes(self):
        served, handle = local_files.open_served_file(str(self.desktop / "shot.png"))
        chunks = list(local_files.iter_file(handle, 4, chunk_size=3))
        self.assertEqual(b"".join(chunks), b"\x89PNG")
        self.assertTrue(handle.closed)
        served, handle = local_files.open_served_file(str(self.desktop / "shot.png"))
        self.assertEqual(b"".join(local_files.iter_file(handle, served.size + 100)), b"\x89PNG fake")
        self.assertTrue(handle.closed)

    def test_text_files_are_plain_text_inline(self):
        served = self._resolve(str(self.desktop / "notes.md"))
        self.assertTrue(served.inline)
        self.assertEqual(served.media_type, "text/plain; charset=utf-8")

    def test_size_cap(self):
        with patch.object(local_files, "MAX_FILE_BYTES", 4):
            with self.assertRaises(local_files.FileAccessError) as ctx:
                self._resolve(str(self.desktop / "shot.png"))
        self.assertEqual(ctx.exception.status, 413)

    def test_custom_roots_replace_the_defaults(self):
        extra = Path(self.tmp.name) / "share"
        extra.mkdir()
        (extra / "doc.pdf").write_bytes(b"%PDF-1.4")
        with patch.dict(os.environ, {"HERMES_PWA_FILE_ROOTS": str(extra)}):
            self.assertEqual([r.name for r in local_files.allowed_roots()], ["share"])
            self.assertTrue(self._resolve(str(extra / "doc.pdf")).inline)
            with self.assertRaises(local_files.FileAccessError):
                self._resolve(str(self.desktop / "shot.png"))

    def test_describe_marks_images(self):
        info = local_files.describe(self._resolve(str(self.desktop / "shot.png")))
        self.assertEqual(info, {"name": "shot.png", "size": 9, "mime": "image/png", "inline": True, "image": True})


class LocalFileRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.desktop = self.home / "Desktop"
        self.desktop.mkdir(parents=True)
        (self.desktop / "shot.png").write_bytes(b"\x89PNG route")
        (self.desktop / "page.html").write_text("<b>x</b>", encoding="utf-8")
        self.env = patch.dict(
            os.environ,
            {"HERMES_HOME": self.tmp.name, "HERMES_PWA_FILE_HOME": str(self.home), "HERMES_PWA_FILE_ROOTS": ""},
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        app = FastAPI()
        app.include_router(router)
        self.app = app
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})

    def test_routes_require_dashboard_auth(self):
        anonymous = TestClient(self.app)
        path = str(self.desktop / "shot.png")
        self.assertEqual(anonymous.get("/file", params={"path": path}).status_code, 401)
        self.assertEqual(anonymous.head("/file", params={"path": path}).status_code, 401)
        self.assertEqual(anonymous.get("/file/info", params={"path": path}).status_code, 401)

    def test_get_and_head_serve_the_file_with_safety_headers(self):
        path = str(self.desktop / "shot.png")
        response = self.client.get("/file", params={"path": path})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x89PNG route")
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["content-length"], "10")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertTrue(response.headers["content-disposition"].startswith("inline;"))
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        head = self.client.head("/file", params={"path": path})
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.headers["content-length"], "10")
        self.assertEqual(head.headers["content-type"], "image/png")
        self.assertEqual(head.headers["cross-origin-resource-policy"], "same-origin")
        self.assertEqual(head.content, b"")

    def test_get_streams_a_large_file_in_full(self):
        big = self.desktop / "big.bin"
        payload = bytes(range(256)) * 2048  # 512 KiB, several stream chunks
        big.write_bytes(payload)
        response = self.client.get("/file", params={"path": str(big)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-length"], str(len(payload)))
        self.assertEqual(response.content, payload)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")

    def test_html_is_downloaded_as_octet_stream(self):
        response = self.client.get("/file", params={"path": str(self.desktop / "page.html")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")
        self.assertTrue(response.headers["content-disposition"].startswith("attachment;"))

    def test_refusals_map_to_http_statuses(self):
        self.assertEqual(self.client.get("/file", params={"path": "/etc/passwd"}).status_code, 403)
        self.assertEqual(self.client.get("/file", params={"path": "relative.png"}).status_code, 403)
        self.assertEqual(self.client.get("/file", params={"path": str(self.desktop / "missing.png")}).status_code, 404)
        self.assertEqual(self.client.get("/file").status_code, 400)

    def test_info_describes_without_bytes(self):
        response = self.client.get("/file/info", params={"path": str(self.desktop / "shot.png")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"name": "shot.png", "size": 10, "mime": "image/png", "inline": True, "image": True})
