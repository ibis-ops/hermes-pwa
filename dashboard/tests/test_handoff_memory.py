import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import handoff_memory as hm


class HandoffMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "memories").mkdir()
        self.write("Kahunas URL is kahunas.io/dashboard.\n§\nUse the chrome tool.", "Sean wants tables for lists.")
        hm.forget_seen()

    def write(self, memory, user):
        (self.tmp / "memories" / "MEMORY.md").write_text(memory, encoding="utf-8")
        (self.tmp / "memories" / "USER.md").write_text(user, encoding="utf-8")

    def test_a_hand_off_gets_the_shared_memory_once(self):
        hooks = hm.part_hooks()
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            first = [h(session_id="child-1", parent_session_id="parent-1") for h in hooks]
            again = [h(session_id="child-1", parent_session_id="parent-1") for h in hooks]
        text = first[0]["context"]
        self.assertIn("- Kahunas URL is kahunas.io/dashboard.", text)
        self.assertIn("About Sean:\n- Sean wants tables for lists.", text)
        self.assertEqual(first[1:], [None, None])  # small memory: one piece
        self.assertEqual(again, [None, None, None])

    def test_top_level_chats_are_left_to_hermes(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            self.assertIsNone(hm.part_hooks()[0](session_id="chat-1", parent_session_id=""))

    def test_large_memory_splits_into_pieces_under_the_hook_limit(self):
        entries = [f"Lesson {i}: " + "x" * 600 for i in range(40)]  # about 25,000 characters
        self.write("\n§\n".join(entries), "Sean wants tables.")
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            pieces = [h(session_id="child-2", parent_session_id="p") for h in hm.part_hooks()]
        texts = [p["context"] for p in pieces if p]
        self.assertGreaterEqual(len(texts), 3)
        self.assertTrue(all(len(t) <= hm.PART_MAX for t in texts), [len(t) for t in texts])
        joined = "\n".join(texts)
        self.assertIn("Lesson 0:", joined)
        self.assertIn("Sean wants tables.", joined)

    def test_no_memory_files_means_nothing_added(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp / "nowhere"):
            self.assertIsNone(hm.part_hooks()[0](session_id="child-3", parent_session_id="p"))


if __name__ == "__main__":
    unittest.main()


class DelegateWithMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "memories").mkdir()
        (self.tmp / "memories" / "MEMORY.md").write_text("Kahunas URL is kahunas.io/dashboard.", encoding="utf-8")
        (self.tmp / "memories" / "USER.md").write_text("Sean wants tables.", encoding="utf-8")

    def test_every_task_gets_the_memory_once(self):
        args = {"tasks": [{"goal": "a", "context": "ctx a", "profile": "kahunas-connector"}, {"goal": "b"}]}
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            r = hm.delegate_with_memory(tool_name="delegate_task", args=args)
            tasks = r["args"]["tasks"]
            self.assertEqual(r["action"], "modify")
            self.assertTrue(tasks[0]["context"].startswith("ctx a\n\n" + hm.MARK))
            self.assertIn("- Kahunas URL is kahunas.io/dashboard.", tasks[1]["context"])
            self.assertEqual(tasks[0]["profile"], "kahunas-connector")
            self.assertIsNone(hm.delegate_with_memory(tool_name="delegate_task", args={"tasks": tasks}))

    def test_legacy_goal_shape_and_other_tools(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            r = hm.delegate_with_memory(tool_name="delegate_task", args={"goal": "x"})
            self.assertIn(hm.MARK, r["args"]["context"])
            self.assertIsNone(hm.delegate_with_memory(tool_name="terminal", args={"command": "ls"}))
