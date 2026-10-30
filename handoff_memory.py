"""Shared memory for hand-offs.

Hermes builds every delegated child (a hand-off from the router, the manager or any bot) with ``skip_memory=True``:
the bot that does the work never sees the shared MEMORY.md and USER.md that every top-level chat gets, so lessons
the team has learned (where things are, which tool works, what Sean wants) are missing exactly where the work
happens. A child's own ``pre_llm_call`` hooks do not reach it either (it runs under the target bot's scope inside
the parent's worker, where the plugin is not loaded; measured 2026-10-29), so the memory goes in from the parent's
side: a ``pre_tool_call`` hook adds it to the context of every task in a ``delegate_task`` call, which Hermes puts in
the child's system prompt.

Only what fits the task goes in. Everything about Sean (USER.md: short, and it applies to any work) and the MEMORY.md
notes that share the most distinctive words with the task, its context and the target bot's role on the team map, up
to NOTES_BUDGET characters, then a pointer to the full file for anything else. The whole memory in every hand-off
would cost each child about 3,700 tokens.

The memory is the one shared folder every profile links to (<Hermes root>/memories, which points at the vault's
Hermes/Memory). Read-only: nothing here writes memory.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

try:  # Loaded as part of the plugin package (the gateway's hooks).
    from . import bot_graph  # type: ignore
    from .bot_graph import _root_hermes_home  # type: ignore
except ImportError:  # Loaded on its own (the tests).
    import bot_graph  # type: ignore
    from bot_graph import _root_hermes_home  # type: ignore

DELIMITER = "\n§\n"
MARK = "SHARED MEMORY (the notes every Hermes bot keeps"
NOTES_BUDGET = 4000  # characters of MEMORY.md notes per hand-off (the whole file is about 11,000)
MAX_NOTES = 8
# Notes about Hermes's own tools that every bot uses in a hand-off (write_file overwrites; clarify never reaches Sean
# from a subagent) go to every hand-off, whatever the topic.
ALWAYS = re.compile(r"\b(?:subagent|write_file)\b", re.I)

# Names decide relevance, not ordinary words: in a long hand-off brief nearly every note shares some plain word with
# the task ("check", "read", "send"), and with only a few dozen notes a plain word that happens to appear once looks
# rare. A name is a code-like token (write_file, kahunas.io, hubq.py), a capitalised word inside a sentence (Kahunas,
# Gmail, Claude Hub), a short acronym (CDP, TCC) or a lone &; for notes, also the words of a leading "Topic:" label.
_TOKEN = re.compile(r"[A-Za-z0-9&#~][A-Za-z0-9&_./#~'-]*")
_CODE = re.compile(r"[_./#~]")
_GENERIC = frozenset("""
    sean hermes herme mac oct nov dec jan feb mar apr may jun jul aug sep sept mon tue wed thu fri sat sun the this that
    these those when where what which who never always only every each any all also and but for with from into onto
    over under use used uses using via per not none no yes ok api url cli app apps tool tools profile profiles system
    bot bots task tasks work job jobs lesson lessons fix fixes check checks read reads write writes run runs entire full
    real default new old first last long short local global main other same such more most less least many much some one
    two three four five six seven eight nine ten if then else than so as at by in on of to or an a is are was were be
    been user open item data general root index desktop document resource pro ram opt send show code exit max maximum now
    started activity set order e.g http page web save login home json agent query total cost internal stop limited
    export integration connection space ids config yaml enter allowed log blocked denied withdrawn file entity html
    gotcha vital protocol thing things way part parts
""".split())
# Words in bot names that say nothing about the topic (gmail-connector, obsidian-vault-manager).
_PROFILE_GENERIC = frozenset({"connector", "manager", "driver", "librarian", "studio", "watch", "prep", "monitor", "default"})


def _memory_dir() -> Path:
    return _root_hermes_home() / "memories"


def _entries(name: str) -> list[str]:
    try:
        text = (_memory_dir() / name).read_text(encoding="utf-8")
    except OSError:
        return []
    return [e.strip() for e in text.split(DELIMITER) if e.strip()]


def _norm(word: str) -> str:
    w = word.lower().strip("./-_#~'")
    w = w[:-2] if w.endswith("'s") else w
    return w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w


def _parts(word: str) -> set[str]:
    """A name and its pieces (kahunas.io: kahunas.io, kahuna, io), without generic words, numbers and two-letter
    bits."""
    whole = _norm(word)
    out = {whole} | {_norm(p) for p in re.split(r"[_./#~-]+", whole) if p}
    return {p for p in out if p == "&" or (len(p) >= 3 and not p.isdigit() and p not in _GENERIC)}


def _names(text: str, label: bool = False) -> set[str]:
    out: set[str] = set()
    if label and ":" in text[:70]:  # "Kahunas select2 food search: ..." names its topic
        for w in _TOKEN.findall(text.split(":", 1)[0]):
            out |= _parts(w)
    for m in _TOKEN.finditer(text):
        w = m.group(0)
        before = text[:m.start()].rstrip(" \"'`(")
        sentence_start = not before or before[-1] in ".:;!?\n"
        code = bool(_CODE.search(w.strip("./'"))) or (any(c.isdigit() for c in w) and any(c.isalpha() for c in w))
        capital = (w[:1].isupper() and not sentence_start) or (w.isupper() and 2 <= len(w) <= 5)
        backticked = m.start() > 0 and text[m.start() - 1] == "`"
        if code or capital or backticked or w == "&":
            out |= _parts(w)
    return out


def _role(profile: str) -> str:
    try:
        node = ((bot_graph.load() or {}).get("nodes") or {}).get(profile) or {}
        return str(node.get("role") or "")
    except Exception:
        return ""


def pick_notes(notes: list[str], task_text: str, profile: str = "", budget: int = NOTES_BUDGET) -> list[str]:
    """The notes that fit a task, in file order: the ALWAYS notes, then the notes sharing the most names with the task,
    its context and the target bot (its name and its role on the team map), each name weighted by how few notes
    carry it; at most MAX_NOTES notes and ``budget`` characters."""
    if not notes:
        return []
    wanted = _names(task_text)
    if profile:
        wanted |= {p for w in profile.split("-") for p in _parts(w)} - _PROFILE_GENERIC
        wanted |= _names(_role(profile))
    sets = [_names(n, label=True) for n in notes]
    df = Counter(t for s in sets for t in s)
    n = len(notes)
    scored = []
    for i, s in enumerate(sets):
        score = sum(math.log((n + 1) / (df[t] + 0.5)) for t in s & wanted) + (100.0 if ALWAYS.search(notes[i]) else 0.0)
        if score >= 1.0:
            scored.append((score, i))
    chosen, used = [], 0
    for _, i in sorted(scored, key=lambda x: (-x[0], x[1])):
        if len(chosen) < MAX_NOTES and used + len(notes[i]) <= budget:
            chosen.append(i)
            used += len(notes[i])
    return [notes[i] for i in sorted(chosen)]


def memory_text(task_text: str = "", profile: str = "") -> str | None:
    """The shared memory for one hand-off: all of USER.md, the MEMORY.md notes that fit the task, and where the rest
    is."""
    notes, user = _entries("MEMORY.md"), _entries("USER.md")
    if not notes and not user:
        return None
    picked = pick_notes(notes, task_text, profile)
    parts = [MARK + "; a hand-off does not load them by itself, so here are the ones for this task). Follow them like "
             "your own memory; your SOUL and the task come first where they differ."]
    if user:
        parts.append("About Sean:\n" + "\n".join(f"- {e}" for e in user))
    if picked:
        parts.append("How to work (the notes that fit this task):\n" + "\n".join(f"- {e}" for e in picked))
    if len(picked) < len(notes):
        parts.append(f"{len(notes) - len(picked)} more notes are in {_memory_dir() / 'MEMORY.md'} (entries separated "
                     "by §); read it when the task touches something not covered here.")
    return "\n\n".join(parts)


def _with_memory(task: dict[str, Any]) -> dict[str, Any] | None:
    context = str(task.get("context") or "")
    if MARK in context:
        return None
    block = memory_text(f"{task.get('goal') or ''}\n{context}", str(task.get("profile") or ""))
    return {**task, "context": (context + "\n\n" + block).strip()} if block else None


def delegate_with_memory(**kwargs: Any) -> dict[str, Any] | None:
    """pre_tool_call: give every task of a delegate_task call the shared memory that fits it, in its context (once)."""
    if kwargs.get("tool_name") != "delegate_task":
        return None
    args = kwargs.get("args")
    if not isinstance(args, dict):
        return None
    try:
        tasks = args.get("tasks")
        if isinstance(tasks, str):  # small models send the list as a JSON string; Hermes accepts either
            try:
                tasks = json.loads(tasks)
            except ValueError:
                return None
        if isinstance(tasks, list) and tasks:
            out = [(_with_memory(t) or t) if isinstance(t, dict) else t for t in tasks]
            return {"action": "modify", "args": {"tasks": out}} if out != tasks else None
        if args.get("goal"):  # the legacy single-goal shape
            task = _with_memory({"goal": args.get("goal"), "context": args.get("context")})
            return {"action": "modify", "args": {"context": task["context"]}} if task else None
    except Exception:
        return None
    return None
