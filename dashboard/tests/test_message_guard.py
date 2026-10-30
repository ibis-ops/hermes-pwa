import unittest
from unittest.mock import patch

import message_guard as mg


def term(cmd):
    return mg.classify("terminal", {"command": cmd})


class SendsNeedSeansYesTests(unittest.TestCase):
    def test_shell_sends(self):
        G = "python /Users/x/.hermes/profiles/gmail-connector/skills/productivity/google-workspace/scripts/google_api.py"
        for cmd in (f"{G} gmail send --to a@b.com --subject hi --body hello",
                    f"{G} gmail reply --message-id 123 --body ok",
                    f"{G} calendar create --title Call --start 2026-10-30T10:00 --attendees client@x.com",
                    f"{G} drive share --file-id 1 --email someone@x.com",
                    "signal-cli -a +1555 send -m hi +1666",
                    "curl -s -X POST http://127.0.0.1:8091/api/v1/rpc -d '{\"jsonrpc\":\"2.0\",\"method\":\"send\",\"params\":{}}'",
                    "osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"x\"'",
                    "echo hi | mail -s subject a@b.com",
                    "curl -X POST https://hooks.slack.com/services/T/B/C -d '{}'",
                    "python ~/.hermes/profiles/signal-connector/skills/x/scripts/signal_send.py --to x --text hi",
                    "python - <<'EOF'\nimport smtplib\nEOF"):
            self.assertIsNotNone(term(cmd), cmd)

    def test_tools_that_send(self):
        self.assertIsNotNone(mg.classify("send_message", {"target": "signal:+1555", "message": "hi"}))
        self.assertIsNotNone(mg.classify("react_to_message", {"emoji": "x"}))
        self.assertIsNotNone(mg.classify("mcp__signal_bridge__send_message", {"to": "x"}))
        self.assertIsNotNone(mg.classify("cronjob_manage", {"action": "create", "deliver": "signal:+1555"}))
        self.assertIsNotNone(mg.classify("execute_code", {"code": "service.users().messages().send(userId='me', body=b)"}))
        self.assertIsNotNone(mg.classify("chrome", {"steps": "allow send\ngo kahunas.io/x\nclick Yes"}))
        self.assertIsNotNone(mg.classify("chrome", {"steps": [{"allow": "send"}, {"click": "Send"}]}))
        self.assertIsNotNone(mg.classify("browser_click", {"ref": "e1", "element": "Send button"}))
        self.assertIsNotNone(mg.classify("browser_exec", {"code": "page.click('text=Send')"}))
        self.assertIsNone(mg.classify("browser_exec", {"code": "async def send(ws, method):\n    await ws.send(m)\nclick(x)"}))

    def test_screen_control_in_a_messaging_app(self):
        with patch.object(mg, "_frontmost_app", return_value="Messages"):
            self.assertIsNotNone(mg.classify("computer_use", {"action": "type", "text": "hi"}))
        with patch.object(mg, "_frontmost_app", return_value="Finder"):
            self.assertIsNone(mg.classify("computer_use", {"action": "type", "text": "hi"}))
        self.assertIsNone(mg.classify("computer_use", {"action": "screenshot"}))


class EverythingElsePassesTests(unittest.TestCase):
    def test_reads_drafts_and_internal_tools(self):
        G = "python google_api.py"
        for cmd in (f"{G} gmail search 'is:unread'", f"{G} calendar create --title Gym --start 2026-10-30T07:00",
                    f'{G} calendar create --title x --attendees ""', f"{G} calendar list --days 2",
                    "python signal_read.py status", "python hubtool.py hub_session_send '{}' --yes",
                    "osascript -e 'tell application \"System Events\" to get name of first process whose frontmost is true'",
                    "ls ~/Desktop", "python new_uploads.py --since 3d"):
            self.assertIsNone(term(cmd), cmd)
        self.assertIsNone(mg.classify("message_agent", {"to": "router", "text": "hi"}))
        self.assertIsNone(mg.classify("mcp__claude_hub__hub_session_send", {"chat": "code:x"}))
        self.assertIsNone(mg.classify("chrome", {"steps": "go kahunas.io/coach/clients/all\nread text"}))
        self.assertIsNone(mg.classify("cronjob_manage", {"action": "create", "deliver": "local"}))
        self.assertIsNone(mg.classify("read_file", {"path": "/x"}))


class HookTests(unittest.TestCase):
    def test_a_send_goes_to_the_approval_gate_keyed_to_the_exact_call(self):
        with patch.object(mg, "_approvals_bypassed", return_value=False):
            a = mg.on_pre_tool_call(tool_name="send_message", args={"message": "one"})
            b = mg.on_pre_tool_call(tool_name="send_message", args={"message": "two"})
        self.assertEqual(a["action"], "approve")
        self.assertIn("explicit yes", a["message"])
        self.assertNotEqual(a["rule_key"], b["rule_key"])

    def test_blocked_outright_when_approvals_are_off(self):
        with patch.object(mg, "_approvals_bypassed", return_value=True):
            r = mg.on_pre_tool_call(tool_name="send_message", args={"message": "x"})
        self.assertEqual(r["action"], "block")

    def test_reads_are_left_alone_and_errors_fail_closed_only_for_send_tools(self):
        self.assertIsNone(mg.on_pre_tool_call(tool_name="read_file", args={"path": "/x"}))
        with patch.object(mg, "classify", side_effect=RuntimeError("boom")), \
                patch.object(mg, "_approvals_bypassed", return_value=False):
            self.assertEqual(mg.on_pre_tool_call(tool_name="send_message", args={})["action"], "approve")
            self.assertIsNone(mg.on_pre_tool_call(tool_name="read_file", args={}))


if __name__ == "__main__":
    unittest.main()
