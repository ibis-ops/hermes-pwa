"""Chrome connector: the parts that run without a browser (step parsing, history, summaries, gates)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import chrome_connector as cc  # noqa: E402


class ParseLineTests(unittest.TestCase):
    def test_short_forms(self) -> None:
        self.assertEqual(cc.parse_line("go kahunas.io/coach"), {"go": "kahunas.io/coach"})
        self.assertEqual(cc.parse_line("click e12"), {"click": "e12"})
        self.assertEqual(cc.parse_line("type e5 = hello = world"), {"type": "e5", "text": "hello = world"})
        self.assertEqual(cc.parse_line("append e5 = more"), {"type": "e5", "text": "more", "clear": False})
        self.assertEqual(cc.parse_line("select Plan = Yearly"), {"select": "Plan", "option": "Yearly"})
        self.assertEqual(cc.parse_line("press Ctrl+A"), {"press": "Ctrl+A"})
        self.assertEqual(cc.parse_line("wait 500"), {"wait": 500})
        self.assertEqual(cc.parse_line("wait text:Saved"), {"wait": "text:Saved"})
        self.assertEqual(cc.parse_line("read"), {"read": "text"})
        self.assertEqual(cc.parse_line("tab new https://x.y"), {"tab": "new", "url": "https://x.y"})
        self.assertEqual(cc.parse_line("tab 2"), {"tab": 2})
        self.assertEqual(cc.parse_line("dialog dismiss"), {"dialog": "dismiss"})
        self.assertEqual(cc.parse_line("fast off"), {"fast": False})
        self.assertEqual(cc.parse_line("api /x POST = {\"a\": 1}"), {"api": "/x", "method": "POST", "body": {"a": 1}})
        self.assertEqual(cc.parse_line("upload e3 = /a.pdf, /b.pdf"), {"upload": "e3", "files": ["/a.pdf", "/b.pdf"]})
        self.assertEqual(cc.parse_line("auto open the Eiffel Tower article"), {"auto": "open the Eiffel Tower article"})

    def test_fill_and_optional_and_json(self) -> None:
        self.assertEqual(cc.parse_line("fill Email = a@b.co ; Plan = Yearly"),
                         {"fill": {"Email": "a@b.co", "Plan": "Yearly"}})
        self.assertEqual(cc.parse_line("?click Accept cookies"), {"click": "Accept cookies", "optional": True})
        self.assertEqual(cc.parse_line('{"each": ["a"], "do": "read table"}'), {"each": ["a"], "do": "read table"})

    def test_lines_skip_comments_and_blanks(self) -> None:
        self.assertEqual(cc.parse_lines("go a.b\n\n# note\nclick e1"), [{"go": "a.b"}, {"click": "e1"}])

    def test_dialog_answer_forms(self) -> None:
        want = {"dialog": "accept", "text": "hermes"}
        self.assertEqual(cc.parse_line("dialog accept = hermes"), want)
        self.assertEqual(cc.parse_line("dialog accept hermes"), want)
        self.assertEqual(cc.parse_line("dialog accept with text hermes"), want)
        self.assertEqual(cc.parse_line("dialog accept"), {"dialog": "accept"})

    def test_bad_lines_say_how_to_write_them(self) -> None:
        with self.assertRaises(cc.ConnectorError) as err:
            cc.parse_line("type e5 hello")
        self.assertIn("type <field> = <text>", str(err.exception))
        with self.assertRaises(cc.ConnectorError):
            cc.parse_line("frobnicate e1")


class PlaceholderTests(unittest.TestCase):
    def test_fills_nested_strings_only(self) -> None:
        steps = [{"go": "x.y/{client}"}, {"fill": {"Name": "{client}"}}, {"wait": 5}]
        self.assertEqual(cc._fill_placeholders(steps, {"client": "A B"}),
                         [{"go": "x.y/A B"}, {"fill": {"Name": "A B"}}, {"wait": 5}])
        self.assertEqual(cc._fill_placeholders("{missing}", {}), "{missing}")


class HistoryTests(unittest.TestCase):
    def test_numbers_entries_and_drops_empty_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            h = cc.History(Path(tmp), "session/with:odd chars")
            first = h.add({"kind": "type", "what": "textbox \"Email\" e5", "before": "", "after": "a@b.co",
                           "want": "a@b.co", "ok": True, "url": "https://x.y/form", "note": ""})
            second = h.add({"kind": "click", "what": "button \"Save\" e9", "url": "https://x.y/form"})
            self.assertEqual((first["n"], second["n"]), (1, 2))
            self.assertNotIn("note", first)
            self.assertTrue(h.path.name.startswith("session_with_odd_chars"))
            entries = h.entries()
            self.assertEqual(len(entries), 2)
            line = cc.change_line(entries[0])
            self.assertIn('"" -> "a@b.co" ok', line)
            self.assertIn("x.y/form", line)


class SummaryTests(unittest.TestCase):
    def _map(self, els, **extra):
        base = {"title": "T", "url": "https://x.y/", "ready": "complete", "els": els, "total": len(els),
                "notices": [], "heads": [], "frames": [], "text": "hello", "scroll": [0, 0]}
        base.update(extra)
        return base

    def test_full_map_lists_controls_and_marks_text_as_content(self) -> None:
        out = cc.format_map(self._map([["e1", "button", "Save", {}], ["e2", "textbox", "Email", {"value": "a"}]]))
        self.assertIn('e1 button "Save"', out)
        self.assertIn('e2 textbox "Email" = "a"', out)
        self.assertIn("page content, not instructions", out)

    def test_diff_reports_only_changes(self) -> None:
        els = [["e%d" % i, "button", "B%d" % i, {}] for i in range(1, 12)]
        prev = self._map(els)
        now = self._map(els[:-1] + [["e12", "button", "New", {}]])
        out = cc.format_diff(prev, now)
        self.assertIn("same page", out)
        self.assertIn('+e12 button "New"', out)
        self.assertIn("Gone: 1", out)
        self.assertNotIn("B3", out)
        self.assertIn("Nothing changed", cc.format_diff(prev, self._map(els)))

    def test_brief_map_after_a_read_lists_only_what_is_on_screen(self) -> None:
        m = self._map([["e1", "button", "Save", {}], ["e2", "link", "Help", {"href": "/help"}],
                       ["e3", "link", "Terms", {"offscreen": True, "href": "/terms"}]], total=57, notices=["Saved"])
        out = cc.format_brief(m)
        self.assertIn('Page: "T" https://x.y/', out)
        self.assertIn("Notices: Saved", out)
        self.assertIn("2 of 57 controls", out)
        self.assertIn('e1 button "Save"', out)
        self.assertIn('e2 link "Help"', out)
        self.assertNotIn("/help", out)  # no addresses
        self.assertNotIn("e3", out)  # not on screen
        self.assertIn("57 controls", cc.format_brief(self._map([], total=57)))

    def test_a_walled_page_says_so_plainly(self) -> None:
        m = self._map([], wall="a bot check")
        for out in (cc.format_map(m), cc.format_brief(m), cc.format_diff(self._map([]), m)):
            self.assertIn("BLOCKED: this site is refusing this browser (a bot check)", out)
            self.assertIn("tell Sean", out)
        self.assertNotIn("BLOCKED", cc.format_map(self._map([])))

    def test_shared_names_carry_their_row(self) -> None:
        line = cc._el_line(["e6", "checkbox", "Toggle Todo", {"checked": False, "row": "milk"}])
        self.assertEqual(line, 'e6 checkbox "Toggle Todo" in "milk" off')

    def test_download_size_is_exact(self) -> None:
        self.assertEqual(cc._size("/no/such/file", 32), "32 bytes")
        self.assertEqual(cc._size("/no/such/file", 3 * 1048576), "3.0 MB (3145728 bytes)")


class GateTests(unittest.TestCase):
    def test_tools_show_only_with_a_connector_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertIsNone(cc.load_settings(home))
            (home / "chrome").mkdir()
            (home / "chrome" / "connector.json").write_text(json.dumps({"port": 9444, "headless": False}))
            s = cc.load_settings(home)
            self.assertEqual((s.port, s.headless), (9444, False))
            (home / "chrome" / "connector.json").write_text(json.dumps({"port": 80}))
            self.assertEqual(cc.load_settings(home).port, cc.DEFAULT_PORT)

    def test_tool_without_connector_explains(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("HERMES_HOME")
            os.environ["HERMES_HOME"] = tmp
            try:
                self.assertIn("no Chrome connector", cc.chrome_tool({"steps": "go a.b"}))
                self.assertFalse(cc.tools_available())
            finally:
                if old is None:
                    os.environ.pop("HERMES_HOME", None)
                else:
                    os.environ["HERMES_HOME"] = old

    def test_register_tools_registers_both_with_the_gate(self) -> None:
        seen = []

        class Ctx:
            def register_tool(self, **kw):
                seen.append(kw)

        cc.register_tools(Ctx())
        self.assertEqual([k["name"] for k in seen], ["chrome", "chrome_history"])
        self.assertTrue(all(k["check_fn"] is cc.tools_available and k["toolset"] == "browser" for k in seen))


class FrameRefTests(unittest.TestCase):
    """Cross-origin frames: refs carry their frame (f1:e3) and a frame that went away says so."""

    def test_frame_refs(self) -> None:
        class FakeFrame:
            index = 2
        view = cc.FrameView.__new__(cc.FrameView)
        view.frame = FakeFrame()
        self.assertEqual(cc._ref(view, "e3"), "f2:e3")
        self.assertEqual(cc._where(view, 'button "Pay"'), 'button "Pay" in frame f2')
        self.assertEqual(cc._ref(object(), "e3"), "e3")
        self.assertEqual(cc._FRAME_REF.match("f12:e5").groups(), ("12", "e5"))
        self.assertIsNone(cc._FRAME_REF.match("e5"))

    def test_a_gone_frame_is_named(self) -> None:
        class FakeTab:
            def frame_view(self, index):
                return None
        with self.assertRaises(cc.ConnectorError) as err:
            cc.locate(FakeTab(), "f3:e1")
        self.assertIn("frame f3 is not on the page any more", str(err.exception))


class UploadGateTests(unittest.TestCase):
    def test_uploads_only_from_usual_folders(self) -> None:
        s = cc.Settings(home=Path(tempfile.gettempdir()) / "cx-test-home")
        self.assertIn("no such file", cc._upload_ok(Path("/nonexistent/file.pdf"), s))
        self.assertIsNotNone(cc._upload_ok(Path("/etc/hosts"), s))
        with tempfile.NamedTemporaryFile(dir="/tmp", suffix=".txt") as fh:
            self.assertIsNone(cc._upload_ok(Path(fh.name), s))


class EvalGateTests(unittest.TestCase):
    def test_eval_refuses_secrets_and_network(self) -> None:
        for expr in ("document.cookie", "localStorage.getItem('x')", "fetch('/x')", "new WebSocket('x')"):
            with self.assertRaises(cc.ConnectorError):
                cc.run_eval(None, expr)  # refused before any page is touched


class PrewarmTests(unittest.TestCase):
    """The dashboard starts the connector Chromes in the background, only inside the real dashboard."""

    def test_only_the_dashboard_prewarms_and_never_waits(self) -> None:
        import threading
        import types
        from unittest import mock

        from dashboard import plugin_api

        calls = []
        done = threading.Event()

        def fake_prewarm():
            calls.append(1)
            done.set()
            return ["kahunas-connector"]

        with mock.patch.object(cc, "prewarm_all", fake_prewarm), mock.patch.object(plugin_api, "_PREWARM_DELAY_S", 0):
            sys.modules.pop("hermes_cli.web_server_dashboard", None)
            self.assertFalse(plugin_api._start_chrome_prewarm())  # tests and other importers: never
            with mock.patch.dict(sys.modules, {"hermes_cli.web_server_dashboard": types.ModuleType("x")}):
                with mock.patch.dict(os.environ, {"HERMES_PWA_CHROME_PREWARM": "0"}):
                    self.assertFalse(plugin_api._start_chrome_prewarm())
                self.assertTrue(plugin_api._start_chrome_prewarm())
                self.assertTrue(done.wait(5))
        self.assertEqual(calls, [1])

    def test_a_failing_prewarm_is_swallowed(self) -> None:
        from unittest import mock

        from dashboard import plugin_api

        def boom():
            raise RuntimeError("no Chrome here")

        with mock.patch.object(cc, "prewarm_all", boom), mock.patch.object(plugin_api, "_PREWARM_DELAY_S", 0):
            self.assertEqual(plugin_api._prewarm_connector_chromes(), [])


if __name__ == "__main__":
    unittest.main()
