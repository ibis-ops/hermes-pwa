import unittest
from unittest.mock import patch

import hub_status


class HubQuestionTests(unittest.TestCase):
    def test_hub_questions_are_recognised(self):
        for text in ("What is Claude hub working in right now", "what's claude-hub doing?",
                     "is anything running in the hub", "status of the hub", "what are my claude code chats doing"):
            self.assertTrue(hub_status.is_hub_question(text), text)

    def test_writes_and_other_questions_are_left_alone(self):
        for text in ("Tell the Claude Hub chat code:abc this exactly: hi", "save a handoff in claude hub",
                     "How many events are on my calendar tomorrow?", "check kahunas", "", "x" * 500):
            self.assertFalse(hub_status.is_hub_question(text), text)

    def test_message_with_parts(self):
        self.assertTrue(hub_status.is_hub_question([{"type": "text", "text": "what is claude hub doing"}]))


class HubContextTests(unittest.TestCase):
    def test_only_the_router_and_claude_bot_top_level_chats_get_the_digest(self):
        with patch.object(hub_status, "_run", return_value="Claude Hub 9:00 PM: 2 running") as run:
            with patch.object(hub_status, "_profile_name", return_value="router"):
                ctx = hub_status.hub_context("s1", "what is claude hub doing")
                self.assertIn("2 running", ctx)
                self.assertIn("without calling a tool", ctx)
                self.assertIsNone(hub_status.hub_context("s1", "what is claude hub doing", parent_session_id="p1"))
                self.assertIsNone(hub_status.hub_context("s1", "how many unread emails"))
            with patch.object(hub_status, "_profile_name", return_value="kahunas-connector"):
                self.assertIsNone(hub_status.hub_context("s1", "what is claude hub doing"))
            run.assert_called_once_with(["brief"])


class HubCommandTests(unittest.TestCase):
    def test_arguments_pick_the_view(self):
        with patch.object(hub_status, "_run", side_effect=lambda args: " ".join(args)):
            self.assertEqual(hub_status.hub_command(""), "brief")
            self.assertEqual(hub_status.hub_command("all"), "now --all")
            self.assertEqual(hub_status.hub_command("chat code:abc 5"), "chat code:abc 5")
            self.assertEqual(hub_status.hub_command("round 28"), "search round 28")

    def test_a_missing_script_still_answers(self):
        with patch.object(hub_status, "HUBQ", hub_status.HUBQ.with_name("missing.py")):
            out = hub_status.hub_command("")
        self.assertTrue(out)


if __name__ == "__main__":
    unittest.main()
