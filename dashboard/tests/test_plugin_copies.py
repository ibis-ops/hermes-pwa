import tempfile
import unittest
from pathlib import Path

import plugin_copies

OLD = "9cd0a2ad1ff15397d6d53f7c4c753bb13686a6cb"
NEW = "1cd26a02b46fa931dc5be044ab5f5f6240a690c4"


def checkout(folder: Path, sha: str, *, packed: bool = False, detached: bool = False) -> Path:
    """A plugin folder whose .git says it has ``sha`` checked out, the way git writes it."""
    git = folder / ".git"
    (git / "refs" / "heads").mkdir(parents=True, exist_ok=True)
    if detached:
        (git / "HEAD").write_text(sha + "\n", encoding="utf-8")
        return folder
    (git / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    if packed:
        (git / "packed-refs").write_text(f"# pack-refs with: peeled fully-peeled sorted\n{sha} refs/heads/main\n", encoding="utf-8")
    else:
        (git / "refs" / "heads" / "main").write_text(sha + "\n", encoding="utf-8")
    return folder


class GitHeadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_reads_a_branch_a_packed_branch_and_a_detached_head(self):
        self.assertEqual(plugin_copies.git_head(checkout(self.root / "a", NEW)), NEW)
        self.assertEqual(plugin_copies.git_head(checkout(self.root / "b", OLD, packed=True)), OLD)
        self.assertEqual(plugin_copies.git_head(checkout(self.root / "c", NEW, detached=True)), NEW)

    def test_follows_a_worktree_pointer(self):
        real = checkout(self.root / "real", NEW)
        linked = self.root / "linked"
        linked.mkdir()
        (linked / ".git").write_text(f"gitdir: {real / '.git'}\n", encoding="utf-8")
        self.assertEqual(plugin_copies.git_head(linked), NEW)

    def test_unknown_when_not_a_checkout_or_odd(self):
        plain = self.root / "plain"
        plain.mkdir()
        self.assertIsNone(plugin_copies.git_head(plain))
        odd = checkout(self.root / "odd", NEW)
        (odd / ".git" / "HEAD").write_text("ref: ../../../etc/passwd\n", encoding="utf-8")
        self.assertIsNone(plugin_copies.git_head(odd))
        (odd / ".git" / "HEAD").write_text("not a sha\n", encoding="utf-8")
        self.assertIsNone(plugin_copies.git_head(odd))


class StaleBotsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = checkout(self.root / "plugins" / "hermes-pwa", NEW)

    def profile_copy(self, name: str, sha: str | None) -> None:
        folder = self.root / "profiles" / name / "plugins" / "hermes-pwa"
        folder.mkdir(parents=True)
        if sha:
            checkout(folder, sha)

    def test_lists_bots_whose_own_copy_is_at_another_commit(self):
        self.profile_copy("manager", OLD)
        self.profile_copy("gmail-connector", NEW)
        self.profile_copy("signal-connector", OLD)
        (self.root / "profiles" / "no-copy").mkdir(parents=True)  # uses the root's copy
        self.profile_copy("not-git", None)  # cannot tell: left out
        self.assertEqual(plugin_copies.stale_bots(self.root, self.reference), ["manager", "signal-connector"])

    def test_a_copy_that_is_the_reference_itself_is_not_stale(self):
        link = self.root / "profiles" / "router" / "plugins"
        link.mkdir(parents=True)
        (link / "hermes-pwa").symlink_to(self.reference, target_is_directory=True)
        self.assertEqual(plugin_copies.stale_bots(self.root, self.reference), [])

    def test_nothing_when_the_reference_commit_is_unknown_or_no_profiles(self):
        self.assertEqual(plugin_copies.stale_bots(self.root, self.reference), [])
        self.profile_copy("manager", OLD)
        self.assertEqual(plugin_copies.stale_bots(self.root, self.root / "elsewhere"), [])


class UpdateCommandTests(unittest.TestCase):
    def test_one_bot_or_several(self):
        self.assertEqual(plugin_copies.update_command([]), "")
        self.assertEqual(plugin_copies.update_command(["manager"]), "hermes -p manager plugins update hermes-pwa")
        self.assertEqual(
            plugin_copies.update_command(["manager", "kahunas-connector"]),
            'for bot in manager kahunas-connector; do hermes -p "$bot" plugins update hermes-pwa; done',
        )

    def test_never_puts_an_odd_name_in_the_command(self):
        self.assertEqual(plugin_copies.update_command(["x; rm -rf ~", "Manager"]), "")


if __name__ == "__main__":
    unittest.main()
