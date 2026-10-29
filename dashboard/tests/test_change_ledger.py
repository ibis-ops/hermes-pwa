import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import change_ledger as cl


def shell(cmd):
    return cl.classify("terminal", {"command": cmd}, "")


class ReadsAreNotChangesTests(unittest.TestCase):
    def test_read_tools_and_read_commands(self):
        self.assertIsNone(cl.classify("read_file", {"path": "/x"}, ""))
        self.assertIsNone(cl.classify("search_files", {"pattern": "x"}, ""))
        for cmd in ("ls -la ~/Desktop/General", "grep -c '>' notes.md", "awk '$1>=5' f",
                    "sqlite3 -readonly ~/.hermes/state.db \"select * from sessions where started_at > 5\"",
                    "python3 - <<'EOF'\nif a > 5: print(1)\nEOF", "launchctl list | grep hermes",
                    "osascript -e 'tell application \"System Events\" to get name of first process'",
                    "python ~/.hermes/profiles/x/scripts/new_uploads.py --since 3d", "ls 2>/dev/null >/dev/null",
                    "python hubq.py search 'kahunas'"):
            self.assertIsNone(shell(cmd), cmd)

    def test_chrome_without_changes_and_screenshots(self):
        self.assertIsNone(cl.classify("chrome", {"steps": "go kahunas.io/dashboard\nread text"}, "chrome: 2 steps in 1.2 s"))
        self.assertIsNone(cl.classify("computer_use", {"action": "screenshot"}, ""))
        self.assertIsNone(cl.classify("mcp__claude_hub__hub_sessions", {}, ""))


class ChangesAreRecordedTests(unittest.TestCase):
    def test_file_tools(self):
        e = cl.classify("write_file", {"path": "~/Desktop/General/Hermes/x.md", "content": "abc"}, "")
        self.assertEqual((e["kind"], e["target"], e["detail"]), ("file", ["~/Desktop/General/Hermes/x.md"], "wrote 3 chars"))
        e = cl.classify("patch", {"path": "/a/SOUL.md", "old_string": "one", "new_string": "two"}, "")
        self.assertIn("one => two", e["detail"])
        e = cl.classify("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: /a/b.py\n@@\n-x\n+y\n"}, "")
        self.assertEqual(e["target"], ["/a/b.py"])

    def test_shell_writes(self):
        for cmd, why in (("echo hi > ~/Desktop/General/x.md", "redirect"), ("hermes gateway restart", "hermes gateway restart"),
                         ("cat <<'EOF' > ~/notes.md\nhello > there\nEOF", "redirect"), ("sed -i '' 's/a/b/' f", "sed -i"),
                         ("launchctl bootout gui/501/com.x", "launchctl bootout"), ("git -C repo commit -m x", "git -C repo commit"),
                         ("python google_api.py calendar create --title x", ".py calendar create"),
                         ("python hubtool.py hub_session_send '{}' --yes", "--yes"),
                         ("osascript -e 'tell application \"Messages\" to send \"x\" to buddy \"y\"'", "osascript"),
                         ("curl -s -X POST http://127.0.0.1:8091/api/v1/rpc -d '{}'", "curl")):
            e = shell(cmd)
            self.assertIsNotNone(e, cmd)
            self.assertTrue(any(w.startswith(why) for w in e["why"]), (cmd, e["why"]))
            self.assertNotIn("scratch", e)

    def test_scratch_output_is_marked(self):
        e = shell("sqlite3 -readonly a.db 'select 1' > /tmp/a.json")
        self.assertTrue(e["scratch"])
        self.assertNotIn("scratch", shell("cp a /tmp/b > /tmp/log"))

    def test_code_chrome_screen_mcp_and_settings(self):
        self.assertIsNotNone(cl.classify("execute_code", {"code": "open(p, 'w').write(x)"}, ""))
        self.assertIsNone(cl.classify("execute_code", {"code": "for ln in lines: print(ln.replace('a', 'b'))"}, ""))
        e = cl.classify("chrome", {"steps": "go kahunas.io/coach/clients/all\nclick Save"}, "chrome: 2 steps\nChanges made in this call: 2 (all ...)")
        self.assertEqual(e["kind"], "web")
        self.assertIn("kahunas.io/coach/clients/all", e["target"])
        self.assertEqual(cl.classify("computer_use", {"action": "left_click", "coordinate": [1, 2]}, "")["kind"], "screen")
        for tool in ("mcp__claude_hub__hub_session_send", "mcp__claude_hub__hub_save_handoff", "mcp__signal_bridge__send_message"):
            self.assertEqual(cl.classify(tool, {"chat": "code:x"}, "")["kind"], "mcp", tool)
        for tool, kind in (("memory", "memory"), ("skill_manage", "skill"), ("cronjob_manage", "schedule")):
            self.assertEqual(cl.classify(tool, {"action": "add"}, "")["kind"], kind)

    def test_secrets_are_masked(self):
        e = shell("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' -X POST https://x.io -d '{}'")
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz123456", e["detail"])
        e = shell("echo 'api_key=sk-ant-REDACTEDREDACTEDREDACTED' > ~/.cfg")
        self.assertNotIn("sk-ant-REDACTEDREDACTEDREDACTED", e["detail"])


class LedgerFileTests(unittest.TestCase):
    def test_record_appends_and_reads_back_in_order(self):
        with tempfile.TemporaryDirectory() as d, patch.object(cl, "ledger_dir", return_value=Path(d)):
            self.assertIsNone(cl.record("read_file", {"path": "/x"}, "", bot="router"))
            a = cl.record("write_file", {"path": "/a", "content": "1"}, "", session_id="s1", bot="router")
            b = cl.record("terminal", {"command": "rm /b"}, "", session_id="s2", task_id="t2", status="error", error="no such file", bot="default")
            lines = [json.loads(x) for f in Path(d).glob("*.jsonl") for x in f.read_text().splitlines()]
            self.assertEqual([x["id"] for x in lines], [a["id"], b["id"]])
            self.assertEqual((b["bot"], b["task"], b["status"], b["error"]), ("default", "t2", "error", "no such file"))
            self.assertEqual([e["id"] for e in cl.read_entries()], sorted([a["id"], b["id"]]))
            self.assertEqual([e["id"] for e in cl.read_entries(since_id=a["id"])], [b["id"]])

    def test_hook_never_raises(self):
        with patch.object(cl, "record", side_effect=OSError("disk full")):
            cl.on_post_tool_call(tool_name="write_file", args={"path": "/a"}, result="")
        cl.on_post_tool_call()


if __name__ == "__main__":
    unittest.main()
