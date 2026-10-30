import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import handoff_memory as hm


class HandoffMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "memories").mkdir()
        (self.tmp / "memories" / "MEMORY.md").write_text("Kahunas URL is kahunas.io/dashboard.\n§\nUse the chrome tool.", encoding="utf-8")
        (self.tmp / "memories" / "USER.md").write_text("Sean wants tables for lists.", encoding="utf-8")
        hm.forget_seen()

    def test_a_hand_off_gets_the_shared_memory_once(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            first = hm.handoff_memory_context("child-1", parent_session_id="parent-1")
            again = hm.handoff_memory_context("child-1", parent_session_id="parent-1")
        self.assertIn("- Kahunas URL is kahunas.io/dashboard.", first)
        self.assertIn("- Use the chrome tool.", first)
        self.assertIn("About Sean:\n- Sean wants tables for lists.", first)
        self.assertIsNone(again)

    def test_top_level_chats_are_left_to_hermes(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            self.assertIsNone(hm.handoff_memory_context("chat-1", parent_session_id=""))

    def test_no_memory_files_means_nothing_added(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp / "nowhere"):
            self.assertIsNone(hm.handoff_memory_context("child-2", parent_session_id="parent-1"))

    def test_long_memory_is_capped(self):
        (self.tmp / "memories" / "MEMORY.md").write_text("x" * 40000, encoding="utf-8")
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp):
            out = hm.handoff_memory_context("child-3", parent_session_id="p")
        self.assertLessEqual(len(out), hm.MAX_CHARS)


if __name__ == "__main__":
    unittest.main()
