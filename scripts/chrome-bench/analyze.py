#!/usr/bin/env python3
"""Look inside Runner C rounds (the bot's sessions, read-only from its state.db) and across rounds.

    python3 analyze.py fails 12              # FAILED steps and tools other than chrome, with the calls
    python3 analyze.py split 12 [bot-s55]    # where the time went: chrome vs model and Hermes (core 14)
    python3 analyze.py overhead 12           # chrome calls whose time is not in their steps
    python3 analyze.py big 12                # the biggest chrome replies, map vs steps and reads
    python3 analyze.py trend 2 16            # A, B and bot scorecards per round

The second argument of fails/split/overhead/big is the round, the third the kind (default bot)."""
from __future__ import annotations

import json
import re
import sqlite3
import statistics
import sys
from pathlib import Path

OUT = Path("/tmp/hermes-work/bench")
CORE = {"wiki_second", "heroku_dynamic", "heroku_checkboxes", "heroku_dropdown", "heroku_prompt", "heroku_upload",
        "heroku_download", "todomvc", "github_repo", "books_page2", "quotes_js", "mdn_search", "ikea_cookie", "flights"}


def _round(n: str, kind: str) -> dict:
    return json.loads((OUT / f"round-{n}-{kind}.json").read_text())


def _db(data: dict) -> sqlite3.Connection:
    db = Path.home() / ".hermes/profiles" / data["profile"] / "state.db"
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def fails(n: str, kind: str = "bot") -> None:
    data = _round(n, kind)
    con = _db(data)
    for rec in data["prompts"]:
        if not rec.get("failed_steps") and not rec.get("other_tools"):
            continue
        print(f"== {rec['name']} r{rec['run']} failed={rec.get('failed_steps')} other={rec.get('other_tools')}")
        for role, calls, content in con.execute("select role, tool_calls, content from messages where session_id = ? "
                                                "order by id", (rec["session"],)):
            if calls:
                for c in json.loads(calls):
                    fn = c.get("function", {})
                    print(f"   CALL {fn.get('name')}: {fn.get('arguments', '')[:300]}")
            elif role == "tool":
                for line in str(content or "").splitlines():
                    if "FAILED" in line or "BLOCKED" in line:
                        print(f"      {line[:300]}")


def split(n: str, kind: str = "bot") -> None:
    data = _round(n, kind)
    con = _db(data)
    chrome, rest, per_call = [], [], []
    for rec in data["prompts"]:
        if rec["name"] not in CORE:
            continue
        rows = con.execute("select content from messages where session_id = ? and role = 'tool' and tool_name = 'chrome'",
                           (rec["session"],)).fetchall()
        c = sum(float(m.group(1)) for (b,) in rows for m in [re.search(r"steps? in ([\d.]+)s", str(b or ""))] if m)
        chrome.append(c)
        rest.append(rec["turn_s"] - c)
        if rec.get("api_calls"):
            per_call.append((rec["turn_s"] - c) / rec["api_calls"])
    print(f"round {n} {kind} core: {len(chrome)} turns; chrome median {statistics.median(chrome):.2f}s, model and Hermes "
          f"median {statistics.median(rest):.2f}s, {statistics.median(per_call):.2f}s per model call")


def overhead(n: str, kind: str = "bot") -> None:
    data = _round(n, kind)
    con = _db(data)
    out = []
    for rec in data["prompts"]:
        rows = con.execute("select content from messages where session_id = ? and role = 'tool' and tool_name = 'chrome' "
                           "order by id", (rec["session"],)).fetchall()
        for i, (body,) in enumerate(rows, 1):
            m = re.search(r"chrome: (?:FAILED, )?\d+ steps? in ([\d.]+)s", str(body or ""))
            if m:
                steps = sum(float(x) for x in re.findall(r"^\s*\d+\. .*\(([\d.]+)s[,)]", str(body), re.M))
                out.append((float(m.group(1)) - steps, float(m.group(1)), rec["name"], rec["run"], i))
    out.sort(reverse=True)
    for o in out[:12]:
        print(f"overhead {o[0]:5.2f}s of {o[1]:5.2f}s  {o[2]} r{o[3]} call {o[4]}")


def big(n: str, kind: str = "bot") -> None:
    data = _round(n, kind)
    con = _db(data)
    out = []
    for rec in data["prompts"]:
        for (body,) in con.execute("select content from messages where session_id = ? and role = 'tool' and "
                                   "tool_name = 'chrome'", (rec["session"],)):
            body = str(body or "")
            cut = body.find("\nPage: ")
            out.append((len(body), cut if cut >= 0 else len(body), rec["name"], rec["run"]))
    out.sort(reverse=True)
    for o in out[:12]:
        print(f"{o[0]:6} chars (steps and reads {o[1]:6}, map {o[0] - o[1]:6})  {o[2]} r{o[3]}")


def trend(first: str = "2", last: str = "99") -> None:
    def load(n: int, kind: str):
        p = OUT / f"round-{n}-{kind}.json"
        return json.loads(p.read_text()) if p.exists() else None
    print("round | A acc stab median p90 tests | B acc stab median p90 | bot core acc stab median p90 calls tokens failed "
          "| bot all median p90 failed")
    for n in range(int(first), int(last) + 1):
        a, b, c = load(n, "direct"), load(n, "live"), load(n, "bot")
        if not (a or b or c):
            continue
        sa, sb = (a or {}).get("summary") or {}, (b or {}).get("summary") or {}
        cs = (c or {}).get("core_summary") or (c or {}).get("summary") or {}
        al = (c or {}).get("summary") if (c or {}).get("core_summary") else None
        row = [f"{n:>2}", f"A {sa.get('accuracy')} {sa.get('stability')} {sa.get('median_s')} {sa.get('p90_s')} {sa.get('tests')}",
               f"B {sb.get('accuracy')} {sb.get('stability')} {sb.get('median_s')} {sb.get('p90_s')}",
               f"C {cs.get('accuracy')} {cs.get('stability')} {cs.get('median_s')} {cs.get('p90_s')} "
               f"{cs.get('median_api_calls')} {cs.get('median_input_tokens')} {cs.get('failed_steps')}"]
        if al:
            row.append(f"all {al.get('median_s')} {al.get('p90_s')} {al.get('failed_steps')}")
        print(" | ".join(row))


if __name__ == "__main__":
    cmds = {"fails": fails, "split": split, "overhead": overhead, "big": big, "trend": trend}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        raise SystemExit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
