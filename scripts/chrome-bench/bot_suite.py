#!/usr/bin/env python3
"""The bot suite: read-only questions across Sean's Hermes team, one CLI turn each (bot_turn.py, like Runner C), with
answers checked against a truth taken at run time (vault counts from the files, Kahunas counts from kahunas_truth.py,
public pages from fixed text). Records time, model calls, tokens, cost and tools (a routed turn's child sessions
included). Saves every test as it ends (iter-<N>-bots.partial.jsonl) and resumes; results in iter-<N>-bots.json.

    hpy bot_suite.py --iter 3                 # every test once
    hpy bot_suite.py --iter 3 --only kahunas-active,default-web
    hpy bot_suite.py --list

Read-only: no test sends, posts or changes anything; Kahunas tests are reads; answers that could name a client are
counts only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner_c as R  # noqa: E402

OUT = Path("/tmp/hermes-work/bench")
VAULT = Path.home() / "Desktop/General"
HERMES = Path.home() / ".hermes"


def home_of(profile: str) -> Path:
    return HERMES if profile == "default" else HERMES / "profiles" / profile


def md_count(rel: str) -> int:
    return sum(1 for p in (VAULT / rel).iterdir() if p.is_file() and p.suffix == ".md")


def dir_count(rel: str) -> int:
    return sum(1 for p in (VAULT / rel).iterdir() if p.is_dir() and not p.name.startswith("."))


def router_routes() -> int:
    text = (HERMES / "profiles/router/config.yaml").read_text(encoding="utf-8")
    block = text[text.index("      profiles:"):]
    names = re.findall(r"(?m)^        - name: (\S+)", block.split("\n      default:")[0])
    return len(names)


_KAHUNAS: dict = {}


def kahunas() -> dict:
    if not _KAHUNAS:
        here = Path(__file__).resolve().parent
        env = {**os.environ, "HERMES_HOME": str(HERMES / "profiles/kahunas-connector")}
        env.pop("NODE_ENV", None)
        out = subprocess.run([str(here / "hpy"), str(here / "kahunas_truth.py")], capture_output=True, text=True,
                             timeout=300, env=env, cwd="/tmp/hermes-work/run").stdout
        line = [ln for ln in out.splitlines() if ln.startswith("{")][-1:]
        _KAHUNAS.update(json.loads(line[0]) if line else {"error": "no truth line"})
    return _KAHUNAS


def number(truth: Callable[[], Any], what: str):
    def check(answer: str, _t: Any) -> tuple:
        want = truth()
        ok = re.search(rf"(?<![\d.,]){want}(?![\d]|[.,]\d)", answer) is not None
        return ok, f"{what} {want}" if ok else f"expected {what} {want}"
    return check


def text(pattern: str, what: str):
    def check(answer: str, _t: Any) -> tuple:
        ok = re.search(pattern, answer, re.I) is not None
        return ok, what if ok else f"expected {what}"
    return check


def any_number(what: str):
    """For questions whose truth this bench cannot read (Gmail, Calendar): a plain number, no refusal or error."""
    def check(answer: str, _t: Any) -> tuple:
        bad = re.search(r"\b(error|could ?n.?t|unable|not available|no access|failed)\b", answer, re.I)
        ok = bool(re.search(r"\b\d+\b", answer)) and not bad
        return ok, f"{what} (a number; truth not readable here)" if ok else f"expected {what}, a number"
    return check


@dataclass
class Test:
    id: str
    profile: str
    prompt: str
    check: Callable[[str, Any], tuple]
    route_to: str = ""            # the profile a routed turn should hand the task to
    must_use: str = "chrome"      # a tool the turn must use ("" = none required)
    note: str = ""


TESTS: list[Test] = [
    Test("default-web", "default", "Open https://example.com and tell me the page's main heading. Reply with the heading only.",
         text(r"Example Domain", "Example Domain")),
    Test("default-books", "default", "On https://books.toscrape.com, go to page 2 of the catalogue and tell me the title of "
         "the first book listed there. Reply with the title only.", text(r"In Her Wake", "In Her Wake")),
    Test("manager-web", "manager", "Open https://www.iana.org/help/example-domains and tell me the page's main heading. "
         "Reply with the heading only.", text(r"Example Domains", "Example Domains")),
    Test("router-routes", "router", "How many bots can you hand work to? Count the profiles in your delegation routes. "
         "Reply with the number only.", number(router_routes, "routes"), must_use=""),
    Test("router-web", "router", "Open https://example.com and tell me the page's main heading. Reply with the heading only.",
         text(r"Example Domain", "Example Domain"), route_to="", must_use="chrome"),
    Test("clientprep-folders", "client-prep", "How many folders are directly inside the vault's Clients folder? Count every "
         "folder, including ones whose name starts with _. No names. Reply with the number only.",
         number(lambda: dir_count("Clients"), "folders"), must_use=""),
    Test("clientprep-clients", "client-prep", "How many client folders are directly inside the vault's Clients folder, not "
         "counting folders whose name starts with _? No names. Reply with the number only.",
         number(lambda: sum(1 for p in (VAULT / "Clients").iterdir() if p.is_dir() and not p.name.startswith(("_", "."))),
                "client folders"), must_use=""),
    Test("research-count", "research-librarian", "How many notes (.md files) are directly in the vault folder wiki/Research, "
         "top level only? Reply with the number only.", number(lambda: md_count("wiki/Research"), "notes"), must_use=""),
    Test("research-sub", "research-librarian", "Have your emerging-compounds sub-researcher open "
         "https://en.wikipedia.org/wiki/Retatrutide and tell me which company develops retatrutide. Reply with the "
         "company name only.", text(r"Eli Lilly", "Eli Lilly"), route_to="emerging-compounds"),
    Test("vault-wiki", "obsidian-vault-manager", "How many notes (.md files) are directly in the vault folder wiki, top "
         "level only? Reply with the number only.", number(lambda: md_count("wiki"), "notes"), must_use=""),
    Test("content-count", "content-studio", "How many notes (.md files) are directly in the vault folder wiki/Content, top "
         "level only? Reply with the number only.", number(lambda: md_count("wiki/Content"), "notes"), must_use=""),
    Test("creators-count", "creator-watch", "How many notes (.md files) are directly in the vault folder wiki/Creators, top "
         "level only? Reply with the number only.", number(lambda: md_count("wiki/Creators"), "notes"), must_use=""),
    Test("kahunas-active", "kahunas-connector", "In Kahunas, how many active clients are there? Read only. Reply with the "
         "number only.", number(lambda: kahunas()["active"], "active clients")),
    Test("kahunas2-archived", "kahunas-connector-2", "In Kahunas, how many archived clients are there? Read only. Reply "
         "with the number only.", number(lambda: kahunas()["archived"], "archived clients")),
    Test("kahunas3-supps", "kahunas-connector-3", "On Kahunas, open the first client on the client list "
         "(kahunas.io/coach/clients/all) and tell me how many supplements are in their supplement plan. Read only. Reply "
         "with the number only, without naming the client.", number(lambda: kahunas()["supplements_first"], "supplements")),
    Test("default-dropdown", "default", "On https://the-internet.herokuapp.com/dropdown choose Option 2 in the dropdown, "
         "then tell me which option the page shows as selected. Reply with the option text only.",
         text(r"Option 2", "Option 2")),
    Test("content-table", "content-studio", "On https://the-internet.herokuapp.com/tables, sort the first table by Last Name "
         "(click its header), then tell me the email in the first row. Reply with the email only.",
         text(r"fbach@yahoo\.com", "fbach@yahoo.com")),
    Test("manager-wikisearch", "manager", "Use the search box on https://en.wikipedia.org to search for Tirzepatide, open "
         "the article, and tell me which company makes it. Reply with the company name only.",
         text(r"Eli Lilly", "Eli Lilly")),
    Test("calendar-count", "google-calander", "How many events are on Sean's Google Calendar for tomorrow? Read only. "
         "Reply with the number only.", any_number("tomorrow's event count"), must_use=""),
    Test("gmail-unread", "gmail-connector", "How many unread emails are in Sean's Gmail inbox right now? Read only. Reply "
         "with the number only.", any_number("unread count"), must_use=""),
]


def run_one(t: Test, it: int) -> dict:
    home = home_of(t.profile)
    out_json = OUT / "logs" / f"iter-{it}-{t.id}.turn.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.unlink(missing_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in ("NODE_ENV", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    env["HERMES_HOME"] = str(home)
    t0 = time.monotonic()
    try:
        subprocess.run(R.turn_cmd(t.prompt, out_json), cwd=R.RUN_DIR, capture_output=True, text=True, timeout=600, env=env)
    except subprocess.TimeoutExpired:
        pass
    wall = time.monotonic() - t0
    turn = json.loads(out_json.read_text(encoding="utf-8")) if out_json.is_file() else {}
    sid = turn.get("session_id") or ""
    found = None
    for _ in range(10):
        found = R.read_session(home / "state.db", sid) if sid else None
        if found:
            break
        time.sleep(0.5)
    children = R.read_children(home / "state.db", sid) if sid else []
    msgs = (found["messages"] if found else []) + [m for c in children for m in c["messages"]]
    stats = R.analyze(msgs, frozenset(R.OWN_TOOLS | {"delegate_task"}))
    sess = dict(found["session"]) if found else {}
    for c in children:
        for key in ("api_call_count", "input_tokens", "cache_read_tokens", "cache_write_tokens", "estimated_cost_usd"):
            sess[key] = (sess.get(key) or 0) + (c["session"].get(key) or 0)
    answer = str(turn.get("response") or "").strip()
    try:
        ok, why = t.check(answer, None)
    except Exception as exc:
        ok, why = False, f"bench error in the check: {type(exc).__name__}: {exc}"
    tools = stats.get("tool_calls") or {}
    used = (not t.must_use) or tools.get(t.must_use, 0) > 0
    routed = [str(c["session"].get("profile_name")) for c in children]
    route_ok = (not t.route_to) or t.route_to in routed
    passed = bool(ok and used and route_ok)
    if ok and not used:
        why += f" (but no {t.must_use} call)"
    if not route_ok:
        why += f" (not handed to {t.route_to}: {routed or 'no child'})"
    return {"id": t.id, "profile": t.profile, "pass": passed, "answer_ok": ok, "why": why,
            "answer": answer[:200], "wall_s": round(wall, 2), "turn_s": turn.get("seconds"),
            "api_calls": sess.get("api_call_count"), "tools": tools, "routed_to": routed,
            "input_tokens": (sess.get("input_tokens") or 0) + (sess.get("cache_read_tokens") or 0)
            + (sess.get("cache_write_tokens") or 0) if sess else None,
            "cost_usd": sess.get("estimated_cost_usd"), "failed_steps": stats.get("failed_steps"),
            "chrome_calls": stats.get("chrome_calls"), "error": turn.get("error") or ""}


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="The bot suite: read-only questions across the team.")
    ap.add_argument("--iter", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    if args.list:
        for t in TESTS:
            print(f"{t.id:<20}{t.profile:<24}{t.prompt[:70]}")
        return 0
    tests = [t for t in TESTS if not args.only or t.id in args.only.split(",")]
    R.ensure_run_dir()
    it = args.iter or int(time.strftime("%H%M"))
    partial = OUT / f"iter-{it}-bots.partial.jsonl"
    done = {}
    if partial.is_file():
        for line in partial.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                done[rec["id"]] = rec
            except (ValueError, KeyError):
                pass
    if any(t.profile.startswith("kahunas") for t in tests if t.id not in done):
        kahunas()  # the truth before any bot touches Kahunas
    print(f"bot suite iteration {it}: {len(tests)} tests ({len(done)} kept from earlier), {args.workers} at a time",
          flush=True)
    records = [done[t.id] for t in tests if t.id in done]
    queue = [t for t in tests if t.id not in done]
    lock = threading.Lock()

    def worker() -> None:
        while True:
            with lock:
                if not queue:
                    return
                t = queue.pop(0)
            rec = run_one(t, it)
            with lock:
                records.append(rec)
                with open(partial, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + "\n")
                print(f"{'PASS' if rec['pass'] else 'FAIL'} {rec['id']:<20} {rec['wall_s']:>6}s calls {rec['api_calls']} "
                      f"tools {rec['tools']} | {rec['why'][:90]}", flush=True)

    threads = [threading.Thread(target=worker) for _ in range(max(1, args.workers))]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    order = {t.id: i for i, t in enumerate(TESTS)}
    records.sort(key=lambda r: order.get(r["id"], 99))
    walls = [r["wall_s"] for r in records]
    summary = {"tests": len(records), "passed": sum(r["pass"] for r in records),
               "median_s": round(statistics.median(walls), 2) if walls else None,
               "p90_s": sorted(walls)[max(0, int(0.9 * len(walls)) - 1)] if walls else None,
               "cost_usd": round(sum(r.get("cost_usd") or 0 for r in records), 3),
               "failed": [r["id"] for r in records if not r["pass"]]}
    (OUT / f"iter-{it}-bots.json").write_text(json.dumps({"iter": it, "summary": summary, "tests": records}, indent=1),
                                               encoding="utf-8")
    partial.unlink(missing_ok=True)
    print(f"passed {summary['passed']}/{summary['tests']}, median {summary['median_s']} s, p90 {summary['p90_s']} s, "
          f"${summary['cost_usd']}; failed: {', '.join(summary['failed']) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
