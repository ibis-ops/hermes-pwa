import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import handoff_memory as hm

NOTES = [
    "Kahunas (kahunas.io): no API or connector. Edit Sean's open Chrome tab only through AppleScript.",
    "Kahunas select2 food search: type the name, wait, ArrowDown, Enter.",
    "Google Workspace (Gmail, Calendar, Drive) as the Hermes Agent project. The google_api.py calendar create wrapper "
    "sends timed events only.",
    "Signal: the gateway replies only to numbers on SIGNAL_ALLOWED_USERS.",
    "write_file replaces a file's ENTIRE content, no merge. Read first; use patch for edits.",
    "If the clarify tool comes back unanswered, proceed and flag it. Clarify inside a delegated subagent run is always "
    "undelivered.",
    "Screenshots: terminal `screencapture` fails; use computer_use action=capture.",
]


def picked(task, profile=""):
    return [NOTES.index(n) for n in hm.pick_notes(NOTES, task, profile)]


class PickNotesTests(unittest.TestCase):
    def test_names_in_the_task_pick_their_notes(self):
        self.assertEqual(picked("Update the meal plan in Kahunas and read back each change."), [0, 1, 4, 5])
        self.assertEqual(picked("How many events are on Google Calendar today?"), [2, 4, 5])
        self.assertEqual(picked("Take a screenshot with `screencapture` and show it."), [4, 5, 6])

    def test_plain_words_pick_nothing_but_the_always_notes(self):
        # Every note shares some plain word with a long brief; only names count.
        self.assertEqual(picked("check whether the send report was read, and answer the question about the change"), [4, 5])

    def test_the_target_bot_counts(self):
        self.assertEqual(picked("Who is waiting on a reply?", "signal-connector"), [3, 4, 5])
        self.assertEqual(picked("What is on today?", "google-calander"), [2, 4, 5])
        graph = {"nodes": {"client-prep": {"role": "Prepares client check-ins from their vault folder and Kahunas."}}}
        with patch.object(hm.bot_graph, "load", return_value=graph):
            self.assertEqual(picked("Write the brief for tomorrow.", "client-prep"), [0, 1, 4, 5])

    def test_budget_and_note_cap(self):
        many = [f"Kahunas lesson {i}: " + "x" * 300 for i in range(20)]
        chosen = hm.pick_notes(many, "Kahunas work", budget=1000)
        self.assertLessEqual(sum(map(len, chosen)), 1000)
        self.assertLessEqual(len(hm.pick_notes(many, "Kahunas work", budget=100000)), hm.MAX_NOTES)


class DelegateWithMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "memories").mkdir()
        (self.tmp / "memories" / "MEMORY.md").write_text("\n§\n".join(NOTES), encoding="utf-8")
        (self.tmp / "memories" / "USER.md").write_text("Sean wants tables.\n§\nTerse replies.", encoding="utf-8")
        self.home = patch.object(hm, "_root_hermes_home", return_value=self.tmp)
        self.home.start()
        self.addCleanup(self.home.stop)

    def test_every_task_gets_its_own_notes_once(self):
        args = {"tasks": [{"goal": "Fix the Kahunas meal plan", "context": "ctx a", "profile": "kahunas-connector"},
                          {"goal": "Count the Gmail threads from today", "profile": "gmail-connector"}]}
        r = hm.delegate_with_memory(tool_name="delegate_task", args=args)
        self.assertEqual(r["action"], "modify")
        a, b = r["args"]["tasks"]
        self.assertTrue(a["context"].startswith("ctx a\n\n" + hm.MARK))
        self.assertIn("About Sean:\n- Sean wants tables.\n- Terse replies.", a["context"])
        self.assertIn("Kahunas select2 food search", a["context"])
        self.assertNotIn("Google Workspace", a["context"])
        self.assertIn("Google Workspace", b["context"])
        self.assertNotIn("Kahunas select2", b["context"])
        self.assertIn("3 more notes are in", a["context"])
        self.assertEqual(a["profile"], "kahunas-connector")
        self.assertIsNone(hm.delegate_with_memory(tool_name="delegate_task", args={"tasks": [a, b]}))

    def test_tasks_sent_as_a_json_string(self):
        r = hm.delegate_with_memory(tool_name="delegate_task", args={"tasks": json.dumps([{"goal": "Kahunas check"}])})
        self.assertIn(hm.MARK, r["args"]["tasks"][0]["context"])

    def test_legacy_goal_shape_and_other_tools(self):
        r = hm.delegate_with_memory(tool_name="delegate_task", args={"goal": "x", "context": "y"})
        self.assertTrue(r["args"]["context"].startswith("y\n\n" + hm.MARK))
        self.assertIsNone(hm.delegate_with_memory(tool_name="terminal", args={"command": "ls"}))
        self.assertIsNone(hm.delegate_with_memory(tool_name="delegate_task", args="not a dict"))

    def test_no_memory_files_means_nothing_added(self):
        with patch.object(hm, "_root_hermes_home", return_value=self.tmp / "nowhere"):
            self.assertIsNone(hm.delegate_with_memory(tool_name="delegate_task", args={"tasks": [{"goal": "x"}]}))


if __name__ == "__main__":
    unittest.main()
