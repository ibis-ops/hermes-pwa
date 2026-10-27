"""Which bots run an older copy of this plugin than the dashboard does.

Hermes gives a profile its own copy of each plugin when the profile is cloned,
and ``hermes plugins update`` only updates the copy of the profile it runs for.
A bot whose copy falls behind runs old hooks: it does not see the team map, and
a router bot does not get Jev's notes. Each copy is a git checkout of the same
install source, so comparing the commit each one has checked out is enough.
Read-only: nothing here changes a copy, a profile or Hermes's configuration.
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path

PLUGIN_NAME = "hermes-pwa"
_SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_REF_RE = re.compile(r"^refs/[A-Za-z0-9._/-]+$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def git_head(folder: Path) -> str | None:
    """The commit checked out in ``folder``, read from its ``.git`` files; None when unknown."""
    git = folder / ".git"
    try:
        if git.is_file():  # a linked worktree: ".git" names the real git folder
            text = git.read_text(encoding="utf-8").strip()
            if not text.startswith("gitdir:"):
                return None
            git = (folder / text[len("gitdir:") :].strip()).resolve()
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not head.startswith("ref:"):
        return head if _SHA_RE.match(head) else None
    ref = head[len("ref:") :].strip()
    if not _REF_RE.match(ref) or ".." in ref:
        return None
    try:
        value = (git / ref).read_text(encoding="utf-8").strip()
        if _SHA_RE.match(value):
            return value
    except (OSError, UnicodeDecodeError):
        pass
    try:
        for line in (git / "packed-refs").read_text(encoding="utf-8").splitlines():
            sha, _, name = line.partition(" ")
            if name.strip() == ref and _SHA_RE.match(sha):
                return sha
    except (OSError, UnicodeDecodeError):
        pass
    return None


def stale_bots(root: Path, reference: Path) -> list[str]:
    """Profiles under ``root/profiles`` with their own copy of the plugin checked out at another
    commit than ``reference`` (the copy the dashboard runs). A profile without its own copy uses
    the root's, so it is never stale. Empty when the reference commit cannot be read."""
    expected = git_head(reference)
    if expected is None:
        return []
    try:
        entries = sorted((root / "profiles").iterdir())
    except OSError:
        return []
    try:
        reference_real = reference.resolve()
    except OSError:
        return []
    stale: list[str] = []
    for entry in entries:
        if not _PROFILE_RE.match(entry.name):
            continue
        copy = entry / "plugins" / PLUGIN_NAME
        try:
            if not copy.is_dir() or copy.resolve() == reference_real:
                continue
        except OSError:
            continue
        head = git_head(copy)
        if head is not None and head != expected:
            stale.append(entry.name)
    return stale


def update_command(bots: list[str]) -> str:
    """Terminal command that updates each bot's own copy from the place it was installed from."""
    names = [name for name in bots if _PROFILE_RE.match(name)]
    if not names:
        return ""
    if len(names) == 1:
        return f"hermes -p {shlex.quote(names[0])} plugins update {PLUGIN_NAME}"
    return f'for bot in {" ".join(shlex.quote(name) for name in names)}; do hermes -p "$bot" plugins update {PLUGIN_NAME}; done'
