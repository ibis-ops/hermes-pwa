#!/usr/bin/env python3
"""Runner C: the bot itself, with its LLM, on read-only prompts drawn from the Runner B tasks.

Each prompt goes to `hermes -p <profile> -z "<prompt>" --usage-file <file>`, run from the empty
folder /tmp/hermes-work/run with NODE_ENV (and HERMES_HOME) unset. The run is timed, then the bot's
newest oneshot session is read from ~/.hermes/profiles/<profile>/state.db, read-only, to count model
turns, tool calls by tool name, chrome calls and steps per chrome call, and tokens. A prompt passes
when the final answer matches the task's pattern and the bot used its browser (an answer from memory
says nothing about the connector). The bot drives its own Chrome (its connector), not the bench one.
Only the final answer and counts are kept; tool outputs and the system prompt are not copied.

    PY=/Users/seanwoodward/.hermes/installs/a054e8eb893639fa/environments/144c13c0849643c59ebdb1c3c7f7f488/venv/bin/python
    $PY runner_c.py --smoke                        # one prompt (books_product)
    $PY runner_c.py --tasks hn_front,wiki_article  # chosen prompts
    $PY runner_c.py --all --repeat 2 --round 5     # every prompt
    $PY runner_c.py --reanalyze 1                  # rescore round 1 from state.db (no new bot calls)

Results: /tmp/hermes-work/bench/round-<N>-bot.json, scorecard on stdout. A full run takes minutes:
start it in the background and read the log.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import live_tasks as L  # noqa: E402

RUN_DIR = Path("/tmp/hermes-work/run")
HERMES = shutil.which("hermes") or str(Path.home() / ".local" / "bin" / "hermes")
# Some answers are in the model's training data (a book price, a birth date): without this the bot
# may answer from memory, which says nothing about the connector. A pass also needs a chrome call.
PROMPT_SUFFIX = " Use your browser to check the live page; do not answer from memory."
SESSION_COLS = ("id, started_at, ended_at, end_reason, model, message_count, tool_call_count, api_call_count, "
                "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd")


def state_db(profile: str) -> Path:
    return Path.home() / ".hermes" / "profiles" / profile / "state.db"


def ensure_run_dir() -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    extra = [p.name for p in RUN_DIR.iterdir() if p.name != ".DS_Store"]
    if extra:
        raise SystemExit(f"{RUN_DIR} must be empty (the bot loads AGENTS.md and rules from its folder); it holds: {extra[:5]}")


def read_session(db: Path, since: float = 0.0, session_id: str = "") -> Optional[dict]:
    """The session `session_id`, or else the newest oneshot session that started after `since`, with
    its messages. Read-only."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        if session_id:
            row = con.execute(f"SELECT {SESSION_COLS} FROM sessions WHERE id = ?", (session_id,)).fetchone()
        else:
            row = con.execute(f"SELECT {SESSION_COLS} FROM sessions WHERE source = 'oneshot' AND started_at >= ? "
                              "ORDER BY started_at DESC LIMIT 1", (since - 2,)).fetchone()
        if row is None:
            return None
        msgs = con.execute("SELECT role, tool_calls, tool_name, content FROM messages WHERE session_id = ? ORDER BY id",
                           (row["id"],)).fetchall()
        return {"session": dict(row), "messages": [dict(m) for m in msgs]}
    finally:
        con.close()


def analyze(messages: list[dict]) -> dict:
    """Model turns, tool calls by name, chrome calls with their step counts, failed chrome calls."""
    tools: Counter = Counter()
    chrome_steps: list[int] = []
    chrome_failed = 0
    turns = 0
    final = ""
    for m in messages:
        if m["role"] == "assistant":
            turns += 1
            try:
                calls = json.loads(m["tool_calls"]) if m["tool_calls"] else []
            except ValueError:
                calls = []
            for c in calls:
                fn = c.get("function") or {}
                name = fn.get("name") or c.get("name") or "?"
                tools[name] += 1
                if name == "chrome":
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    chrome_steps.append(C.count_steps(args.get("steps")) if isinstance(args, dict) else 0)
            if m.get("content") and not calls:
                final = m["content"]
        elif m["role"] == "tool" and m.get("tool_name") == "chrome" and "chrome: FAILED" in str(m.get("content") or "")[:600]:
            chrome_failed += 1  # the header line, possibly inside an untrusted-result wrapper
    return {"turns": turns, "tool_calls": dict(tools), "tool_calls_total": sum(tools.values()),
            "chrome_calls": tools.get("chrome", 0), "chrome_steps": chrome_steps,
            "steps_per_chrome_call": round(statistics.mean(chrome_steps), 2) if chrome_steps else None,
            "chrome_failed_calls": chrome_failed, "final_from_db": final}


def build_record(task: C.Test, run_no: int, prompt: str, stdout: str, code: Any, stderr: str, wall: float,
                 found: Optional[dict], usage: Optional[dict], allow_no_browser: bool) -> dict:
    stats = analyze(found["messages"]) if found else {}
    sess = found["session"] if found else {}
    answer = (stdout or "").strip() or stats.get("final_from_db", "")
    answer_ok = bool(re.search(task.meta["answer"], answer))
    used_chrome = (stats.get("chrome_calls") or 0) > 0
    # state.db counts uncached input only; the usage file (or the cache columns) give the full prompt size.
    cached = (sess.get("cache_read_tokens") or 0) + (sess.get("cache_write_tokens") or 0)
    total_in = (usage or {}).get("input_tokens")
    if total_in is None and sess:
        total_in = (sess.get("input_tokens") or 0) + cached
    return {
        "name": task.name, "run": run_no, "prompt": prompt, "pass": answer_ok and (used_chrome or allow_no_browser),
        "answer_ok": answer_ok, "used_chrome": used_chrome, "expected": task.meta["answer"],
        "answer": C.cut(answer, 600), "exit": code, "stderr_tail": C.cut(stderr[-600:], 600) if stderr else "",
        "wall_s": round(wall, 2), "session": sess.get("id"), "model": sess.get("model"),
        "turns": stats.get("turns"), "api_calls": sess.get("api_call_count"),
        "tool_calls": stats.get("tool_calls"), "tool_calls_total": stats.get("tool_calls_total"),
        "chrome_calls": stats.get("chrome_calls"), "chrome_steps": stats.get("chrome_steps"),
        "steps_per_chrome_call": stats.get("steps_per_chrome_call"), "chrome_failed_calls": stats.get("chrome_failed_calls"),
        "input_tokens": total_in, "uncached_input_tokens": sess.get("input_tokens"),
        "output_tokens": sess.get("output_tokens"), "cache_read_tokens": sess.get("cache_read_tokens"),
        "cache_write_tokens": sess.get("cache_write_tokens"), "reasoning_tokens": sess.get("reasoning_tokens"),
        "cost_usd": sess.get("estimated_cost_usd"), "usage": usage,
    }


def run_prompt(task: C.Test, profile: str, n: int, run_no: int, timeout: int, allow_no_browser: bool) -> dict:
    prompt = task.meta["prompt"] + PROMPT_SUFFIX
    usage_path = C.OUT_DIR / f"round-{n}-bot-{task.name}-r{run_no}.usage.json"
    usage_path.unlink(missing_ok=True)
    cmd = ["env", "-u", "NODE_ENV", "-u", "HERMES_HOME", HERMES, "-p", profile, "-z", prompt, "--usage-file", str(usage_path)]
    since = time.time()
    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, cwd=RUN_DIR, capture_output=True, text=True, timeout=timeout)
        code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        partial = exc.stdout
        code, stdout, stderr = "timeout", partial.decode("utf-8", "replace") if isinstance(partial, bytes) else (partial or ""), ""
    wall = time.monotonic() - t0
    try:
        usage = json.loads(usage_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        usage = None
    found = None
    for _ in range(10):  # the session row can land a moment after the process exits
        found = read_session(state_db(profile), since, (usage or {}).get("session_id") or "")
        if found:
            break
        time.sleep(0.5)
    return build_record(task, run_no, prompt, stdout, code, stderr, wall, found, usage, allow_no_browser)


def reanalyze(n: int, allow_no_browser: bool) -> dict:
    """Rescore a recorded round from state.db with the current rules (no new bot calls)."""
    data = json.loads(C.round_path("bot", n).read_text(encoding="utf-8"))
    tasks = {t.name: t for t in L.TASKS}
    records = []
    for r in data["prompts"]:
        found = read_session(state_db(data["profile"]), session_id=r.get("session") or "") if r.get("session") else None
        records.append(build_record(tasks[r["name"]], r["run"], r["prompt"], r["answer"], r["exit"], r.get("stderr_tail", ""),
                                    r["wall_s"], found, r.get("usage"), allow_no_browser))
    data.update({"prompts": records, "summary": summarize(records), "rescored": C.now()})
    return data


def _med(vals: list) -> Any:
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(statistics.median(vals), 2) if vals else None


def summarize(records: list[dict]) -> dict:
    names = list(dict.fromkeys(r["name"] for r in records))
    first = {n: next(r for r in records if r["name"] == n) for n in names}
    steps = [s for r in records for s in (r.get("chrome_steps") or [])]
    return {
        "prompts": len(names), "runs": max((r["run"] for r in records), default=0),
        "passed": sum(1 for n in names if first[n]["pass"]),
        "accuracy": round(100.0 * sum(1 for n in names if first[n]["pass"]) / len(names), 1) if names else 0.0,
        "stability": round(100.0 * sum(1 for n in names if len({r["pass"] for r in records if r["name"] == n}) == 1)
                           / len(names), 1) if names else 0.0,
        "no_browser": sorted({r["name"] for r in records if not r.get("used_chrome")}),
        "median_s": _med([r["wall_s"] for r in records]), "median_turns": _med([r["turns"] for r in records]),
        "median_tool_calls": _med([r["tool_calls_total"] for r in records]),
        "median_chrome_calls": _med([r["chrome_calls"] for r in records]),
        "steps_per_chrome_call": round(statistics.mean(steps), 2) if steps else None,
        "median_input_tokens": _med([r["input_tokens"] for r in records]),
        "median_output_tokens": _med([r["output_tokens"] for r in records]),
        "median_cache_read_tokens": _med([r["cache_read_tokens"] for r in records]),
        "median_cost_usd": _med([r["cost_usd"] for r in records]),
        "tools_used": dict(sum((Counter(r.get("tool_calls") or {}) for r in records), Counter())),
    }


def print_scorecard(data: dict) -> None:
    s = data["summary"]
    print("=" * 100)
    print(f"Runner C (bot {data['profile']}): round {data['round']}, {data['started']} to {data['finished']}"
          + (f" (rescored {data['rescored']})" if data.get("rescored") else ""))
    print(f"accuracy    {s['passed']}/{s['prompts']} = {s['accuracy']}% on run 1 (answer matched and the browser was used); "
          f"stability {s['stability']}%")
    if s["no_browser"]:
        print(f"no browser  {', '.join(s['no_browser'])}: answered without a chrome call (from memory)")
    print(f"time        median {s['median_s']}s per prompt; model turns median {s['median_turns']}")
    print(f"tools       median {s['median_tool_calls']} calls per prompt, chrome calls median {s['median_chrome_calls']}, "
          f"steps per chrome call {s['steps_per_chrome_call']}")
    print(f"tokens      median input {s['median_input_tokens']} (incl. cache), output {s['median_output_tokens']}, "
          f"cache read {s['median_cache_read_tokens']}; cost median ${s['median_cost_usd']}")
    print(f"tools used  {s['tools_used']}")
    print("-" * 100)
    for r in data["prompts"]:
        print(f"{'PASS' if r['pass'] else 'FAIL'} {r['name']:<16} r{r['run']} {r['wall_s']:>7}s turns {r['turns']} "
              f"tools {r['tool_calls']} chrome steps {r['chrome_steps']} tokens in/out {r['input_tokens']}/{r['output_tokens']}")
        note = "" if r["pass"] else ("   (no chrome call)" if r.get("answer_ok") else f"   (expected /{r['expected']}/)")
        print(f"     answer: {C.cut(r['answer'], 200)}{note}")
        if r["exit"] not in (0, None):
            print(f"     exit {r['exit']}: {r['stderr_tail'][-300:]}")
    print("=" * 100)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Runner C: the bot (LLM + its Chrome) on read-only live prompts.")
    ap.add_argument("--profile", default="kahunas-connector")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--smoke", action="store_true", help="one prompt only (the task marked smoke)")
    group.add_argument("--tasks", default="", help="comma-separated task names from live_tasks.py")
    group.add_argument("--all", action="store_true", help="every live task")
    group.add_argument("--reanalyze", type=int, default=0, help="rescore this round from state.db, no new bot calls")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--round", type=int, default=0)
    ap.add_argument("--timeout", type=int, default=900, help="seconds per prompt")
    ap.add_argument("--allow-no-browser", action="store_true", help="count a matching answer as a pass without a chrome call")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    if args.list:
        for t in L.TASKS:
            print(f"{t.name:<18}{t.meta['prompt']}")
        return 0
    if args.reanalyze:
        data = reanalyze(args.reanalyze, args.allow_no_browser)
        path = C.write_round("bot", args.reanalyze, data)
        print_scorecard(data)
        print(f"results: {path}")
        return 0
    if args.smoke:
        tasks = [t for t in L.TASKS if t.meta.get("smoke")][:1]
    elif args.all:
        tasks = list(L.TASKS)
    elif args.tasks:
        tasks = C.select(L.TASKS, args.tasks)
    else:
        ap.error("choose --smoke, --tasks a,b, --all or --reanalyze N")
    if not state_db(args.profile).is_file():
        raise SystemExit(f"no state.db for profile {args.profile}")
    ensure_run_dir()
    L.write_files()
    n = args.round or C.next_round("bot")
    started = C.now()
    print(f"Runner C round {n}: {len(tasks)} prompt(s) x {args.repeat} to the {args.profile} bot from {RUN_DIR}", flush=True)
    records = []
    for run_no in range(1, args.repeat + 1):
        for t in tasks:
            rec = run_prompt(t, args.profile, n, run_no, args.timeout, args.allow_no_browser)
            records.append(rec)
            print(f"[run {run_no}] {'PASS' if rec['pass'] else 'FAIL'} {t.name} {rec['wall_s']}s turns {rec['turns']} "
                  f"chrome {rec['chrome_calls']} answer: {C.cut(rec['answer'], 120)}", flush=True)
    data = {"runner": "bot", "round": n, "profile": args.profile, "started": started, "finished": C.now(),
            "connector": C.fingerprint(), "summary": summarize(records), "prompts": records}
    path = C.write_round("bot", n, data)
    print_scorecard(data)
    print(f"results: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
