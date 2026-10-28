#!/usr/bin/env python3
"""Runner C: the bot itself (its LLM and its own connector Chrome) on read-only tasks that need real
browsing and interaction (bot_tasks.py).

Each task is one bot turn built the way a CLI chat builds it (bot_turn.py under Hermes's own runtime,
HERMES_HOME = the bot's profile), run from the empty folder /tmp/hermes-work/run. `hermes -z` is not
used: its local gateway surface leaves plugin tools out, so it cannot test the connector. Then the
turn's session is read from the profile's state.db, read-only, for model turns, tool calls by name,
chrome calls and steps per call, tool output size, failed steps, tokens and cost, and the bot's chrome
change history is checked where the task needs proof that an action happened. Only answers, counts
and the bot's own tool arguments are kept; tool outputs and the system prompt are not copied.

    PY=/Users/seanwoodward/.hermes/installs/a054e8eb893639fa/environments/144c13c0849643c59ebdb1c3c7f7f488/venv/bin/python
    $PY runner_c.py --all --repeat 2 --workers 2 --round 3 --baseline 2
    $PY runner_c.py --tasks heroku_upload,heroku_download --repeat 1
    $PY runner_c.py --all --model claude-haiku-5.5      # one-turn override, the profile is not changed

Results: /tmp/hermes-work/bench/round-<N>-bot.json and a scorecard on stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bot_tasks as T  # noqa: E402
import common as C  # noqa: E402

RUN_DIR = Path("/tmp/hermes-work/run")
TURN = Path(__file__).resolve().parent / "bot_turn.py"
HERMES_AGENT = Path.home() / ".hermes" / "hermes-agent"
LAUNCHER = HERMES_AGENT / ".hermes" / "bin" / "hermes"
OWN_TOOLS = {"chrome", "chrome_history"}
SESSION_COLS = ("id, started_at, ended_at, end_reason, model, message_count, tool_call_count, api_call_count, "
                "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd")


def hermes_python() -> str:
    """The interpreter Hermes's own launcher runs (same runtime, site dirs and bootstrap as `hermes`)."""
    text = LAUNCHER.read_text(encoding="utf-8")
    m = re.search(r"^exec (\S+python3?\S*)", text, re.M)
    if not m:
        raise SystemExit(f"cannot find Hermes's python in {LAUNCHER}")
    return m.group(1)


def turn_cmd(prompt: str, out_json: Path, model: str = "", reasoning: str = "") -> list[str]:
    boot = ("import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); "
            "os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, %r); sys._hermes_pin_default_home = True; "
            "import hermes_bootstrap; sys.argv = [sys.argv[1]] + sys.argv[2:]; runpy.run_path(sys.argv[0], run_name='__main__')"
            % str(HERMES_AGENT))
    cmd = [hermes_python(), "-I", "-c", boot, str(TURN), prompt, "--json", str(out_json)]
    if model:
        cmd += ["--model", model]
    if reasoning:
        cmd += ["--reasoning", reasoning]
    return cmd


def profile_home(profile: str) -> Path:
    return Path.home() / ".hermes" / "profiles" / profile


def ensure_run_dir() -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    extra = [p.name for p in RUN_DIR.iterdir() if p.name != ".DS_Store"]
    if extra:
        raise SystemExit(f"{RUN_DIR} must be empty (the bot loads AGENTS.md and rules from its folder); it holds: {extra[:5]}")


def read_session(db: Path, session_id: str) -> Optional[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(f"SELECT {SESSION_COLS} FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        msgs = con.execute("SELECT role, tool_calls, tool_name, content FROM messages WHERE session_id = ? ORDER BY id",
                           (session_id,)).fetchall()
        return {"session": dict(row), "messages": [dict(m) for m in msgs]}
    finally:
        con.close()


_FAILED_STEP = re.compile(r"(?m)^\s*[\w.-]*\d+\. (?:FAILED|stopped)")


def analyze(messages: list[dict]) -> dict:
    """Model turns, tool calls by name, chrome calls with their steps, output sizes, failed steps."""
    tools: Counter = Counter()
    chrome_steps: list[int] = []
    chrome_chars: list[int] = []
    tool_chars = 0
    chrome_failed = failed_steps = shots = 0
    turns = 0
    chrome_args: list[str] = []
    other_args: list[str] = []
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
                if name not in OWN_TOOLS:
                    other_args.append(f"{name}: {C.cut(fn.get('arguments') or '', 160)}")
                if name == "chrome":
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    steps = args.get("steps") if isinstance(args, dict) else None
                    chrome_steps.append(C.count_steps(steps))
                    text = steps if isinstance(steps, str) else json.dumps(steps, ensure_ascii=False)
                    chrome_args.append(C.cut(text, 300))
                    shots += len(re.findall(r"(?m)(?:^|\")\s*screenshot", text or ""))
        elif m["role"] == "tool":
            content = str(m.get("content") or "")
            tool_chars += len(content)
            if m.get("tool_name") == "chrome":
                chrome_chars.append(len(content))
                if "chrome: FAILED" in content[:600]:
                    chrome_failed += 1
                failed_steps += len(_FAILED_STEP.findall(content))
    other = {k: v for k, v in tools.items() if k not in OWN_TOOLS}
    return {"turns": turns, "tool_calls": dict(tools), "tool_calls_total": sum(tools.values()),
            "chrome_calls": tools.get("chrome", 0), "chrome_steps": chrome_steps,
            "steps_per_chrome_call": round(statistics.mean(chrome_steps), 2) if chrome_steps else None,
            "chrome_chars": sum(chrome_chars), "max_chrome_chars": max(chrome_chars, default=0),
            "tool_chars": tool_chars, "chrome_failed_calls": chrome_failed, "failed_steps": failed_steps,
            "screenshots": shots, "other_tools": other, "chrome_args": chrome_args, "other_args": other_args[:6]}


def history_entries(profile: str, session_id: str, since: float) -> list[dict]:
    """The bot's chrome change history for this turn (files keyed by session, written after `since`)."""
    folder = profile_home(profile) / "chrome" / "history"
    out: list[dict] = []
    if not folder.is_dir():
        return out
    for p in folder.glob("*.jsonl"):
        try:
            if p.stat().st_mtime < since - 1:
                continue
            if session_id and session_id not in p.stem:
                continue
            for line in p.read_text(encoding="utf-8").splitlines():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            continue
    return out


def run_task(task: T.BotTask, profile: str, n: int, run_no: int, timeout: int, truth: Any, model: str,
             reasoning: str, tag: str = "") -> dict:
    out_json = C.OUT_DIR / "logs" / f"round-{n}-bot{tag}-{task.name}-r{run_no}.turn.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.unlink(missing_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in ("NODE_ENV", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    env["HERMES_HOME"] = str(profile_home(profile))
    since = time.time()
    t0 = time.monotonic()
    code: Any = 0
    try:
        proc = subprocess.run(turn_cmd(task.prompt, out_json, model, reasoning), cwd=RUN_DIR, capture_output=True,
                              text=True, timeout=timeout, env=env)
        code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        raw = exc.stdout
        code, stdout, stderr = "timeout", raw.decode("utf-8", "replace") if isinstance(raw, bytes) else (raw or ""), ""
    wall = time.monotonic() - t0
    try:
        turn = json.loads(out_json.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        turn = {}
    sid = turn.get("session_id") or ""
    found = None
    for _ in range(10):  # the session row can land a moment after the process exits
        found = read_session(profile_home(profile) / "state.db", sid) if sid else None
        if found:
            break
        time.sleep(0.5)
    stats = analyze(found["messages"]) if found else {}
    sess = found["session"] if found else {}
    answer = str(turn.get("response") or "").strip() or (stdout or "").split("STATS ")[0].strip()
    stale = isinstance(truth, dict) and truth.get("stale")
    ok, why = task.check(answer, truth) if not stale else (False, f"stale task: {truth['stale']}")
    hist_ok, hist_why = True, ""
    if task.history is not None and ok:
        hist_ok, hist_why = task.history(history_entries(profile, sid, since))
    used_chrome = (stats.get("chrome_calls") or 0) > 0
    passed = bool(ok and hist_ok and used_chrome)
    if ok and not used_chrome:
        why += " (but no chrome call: answered without the connector)"
    cached = (sess.get("cache_read_tokens") or 0) + (sess.get("cache_write_tokens") or 0)
    return {
        "name": task.name, "run": run_no, "pass": passed, "stale": bool(stale), "answer_ok": ok,
        "history_ok": hist_ok, "why": why + (f"; {hist_why}" if hist_why else ""), "answer": C.cut(answer, 400),
        "exit": code, "error": turn.get("error") or "",
        "stderr_tail": C.cut(stderr[-400:], 400) if stderr and code != 0 else "",
        "wall_s": round(wall, 2), "turn_s": turn.get("seconds"), "session": sid, "model": sess.get("model"),
        "api_calls": sess.get("api_call_count") or turn.get("api_calls"), **stats,
        "input_tokens": (sess.get("input_tokens") or 0) + cached if sess else None,
        "output_tokens": sess.get("output_tokens"), "reasoning_tokens": sess.get("reasoning_tokens"),
        "cache_read_tokens": sess.get("cache_read_tokens"), "cost_usd": sess.get("estimated_cost_usd"),
    }


def _med(vals: list) -> Any:
    vals = [v for v in vals if isinstance(v, (int, float))]
    return round(statistics.median(vals), 2) if vals else None


def _p90(vals: list) -> Any:
    vals = sorted(v for v in vals if isinstance(v, (int, float)))
    return round(vals[max(0, math.ceil(0.9 * len(vals)) - 1)], 2) if vals else None


def summarize(records: list[dict]) -> dict:
    names = list(dict.fromkeys(r["name"] for r in records))
    scored = [n for n in names if not any(r["stale"] for r in records if r["name"] == n)]
    first = {n: min((r for r in records if r["name"] == n), key=lambda r: r["run"]) for n in names}
    recs = [r for r in records if r["name"] in scored]
    steps = [s for r in recs for s in (r.get("chrome_steps") or [])]
    same = [n for n in scored if len({r["pass"] for r in records if r["name"] == n}) == 1]
    crashes = [f"{r['name']} r{r['run']}" for r in recs if r["exit"] not in (0, None) or r.get("error")]
    unrecovered = sorted({r["name"] for r in recs if not r["pass"] and (r.get("failed_steps") or 0) > 0})
    tools = sum((Counter(r.get("tool_calls") or {}) for r in recs), Counter())
    other = sum((Counter(r.get("other_tools") or {}) for r in recs), Counter())
    return {
        "tasks": len(scored), "runs": max((r["run"] for r in records), default=0),
        "passed": sum(1 for n in scored if first[n]["pass"]),
        "accuracy": round(100.0 * sum(1 for n in scored if first[n]["pass"]) / len(scored), 1) if scored else 0.0,
        "pass_rate_all_runs": round(100.0 * sum(1 for r in recs if r["pass"]) / len(recs), 1) if recs else 0.0,
        "stability": round(100.0 * len(same) / len(scored), 1) if scored else 0.0,
        "flaky": [n for n in scored if n not in same], "stale": [n for n in names if n not in scored],
        "failed": sorted({r["name"] for r in recs if not r["pass"]}), "crashes": crashes,
        "unrecovered": unrecovered,
        "median_s": _med([r["wall_s"] for r in recs]), "p90_s": _p90([r["wall_s"] for r in recs]),
        "median_api_calls": _med([r.get("api_calls") for r in recs]),
        "median_chrome_calls": _med([r.get("chrome_calls") for r in recs]),
        "steps_per_chrome_call": round(statistics.mean(steps), 2) if steps else None,
        "median_chrome_chars": _med([r.get("chrome_chars") for r in recs]),
        "median_tool_chars": _med([r.get("tool_chars") for r in recs]),
        "max_chrome_chars": max((r.get("max_chrome_chars") or 0 for r in recs), default=0),
        "median_input_tokens": _med([r.get("input_tokens") for r in recs]),
        "median_output_tokens": _med([r.get("output_tokens") for r in recs]),
        "median_cost_usd": _med([r.get("cost_usd") for r in recs]),
        "total_cost_usd": round(sum(r.get("cost_usd") or 0 for r in recs), 3),
        "failed_steps": sum(r.get("failed_steps") or 0 for r in recs),
        "screenshots": sum(r.get("screenshots") or 0 for r in recs),
        "tools_used": dict(tools), "other_tools": dict(other),
    }


def print_scorecard(data: dict) -> None:
    s = data["summary"]
    print("=" * 100)
    print(f"Runner C (bot {data['profile']}{', model ' + data['model'] if data.get('model') else ''}"
          f"{', reasoning ' + data['reasoning'] if data.get('reasoning') else ''}): round {data['round']}, "
          f"{data['started']} to {data['finished']}, plugin {data['connector'].get('installed')}")
    print(f"accuracy    {s['passed']}/{s['tasks']} = {s['accuracy']}% on run 1 (all runs {s['pass_rate_all_runs']}%)")
    print(f"reliability same result on every run {s['stability']}%"
          + (f" (flaky: {', '.join(s['flaky'])})" if s["flaky"] else "")
          + f"; crashes {len(s['crashes'])}; tasks failed with FAILED steps {len(s['unrecovered'])}"
          + (f" ({', '.join(s['unrecovered'])})" if s["unrecovered"] else ""))
    print(f"speed       median {s['median_s']}s, p90 {s['p90_s']}s per task; model calls median {s['median_api_calls']}; "
          f"chrome calls median {s['median_chrome_calls']}, steps per call {s['steps_per_chrome_call']}")
    print(f"output      chrome output median {s['median_chrome_chars']} chars per task (largest call {s['max_chrome_chars']}); "
          f"all tool output median {s['median_tool_chars']}")
    print(f"tokens      median input {s['median_input_tokens']} (incl. cache), output {s['median_output_tokens']}; "
          f"cost median ${s['median_cost_usd']}, total ${s['total_cost_usd']}")
    print(f"tools       {s['tools_used']}; not chrome: {s['other_tools'] or 'none'}; "
          f"FAILED steps {s['failed_steps']}; screenshots {s['screenshots']}")
    if s["stale"]:
        print(f"stale       {', '.join(s['stale'])} (the live page changed under the task; not scored)")
    k = data.get("core_summary")
    if k:
        print(f"core 14     accuracy {k['passed']}/{k['tasks']} = {k['accuracy']}%, stable {k['stability']}%, median "
              f"{k['median_s']}s, p90 {k['p90_s']}s, model calls {k['median_api_calls']}, chrome output "
              f"{k['median_chrome_chars']}, input tokens {k['median_input_tokens']}, FAILED steps {k['failed_steps']}")
    print("-" * 100)
    for r in data["prompts"]:
        print(f"{'PASS' if r['pass'] else 'FAIL'} {r['name']:<18} r{r['run']} {r['wall_s']:>6}s calls {r.get('api_calls')} "
              f"chrome {r.get('chrome_calls')} steps {r.get('chrome_steps')} out {r.get('chrome_chars')} "
              f"tok {r.get('input_tokens')}/{r.get('output_tokens')}"
              + (f" other {r['other_tools']}" if r.get("other_tools") else "")
              + (f" failed-steps {r['failed_steps']}" if r.get("failed_steps") else ""))
        if not r["pass"]:
            print(f"     answer: {C.cut(r['answer'], 160)} | {r['why']}")
            if r.get("error") or r["exit"] not in (0, None):
                print(f"     exit {r['exit']} {r.get('error', '')} {r.get('stderr_tail', '')[-200:]}")
    print("=" * 100)


def print_compare(data: dict, base_round: int, kind: str = "bot") -> None:
    p = C.round_path(kind, base_round)
    try:
        base = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print(f"no baseline {p}")
        return
    pairs = []
    if bool(base.get("core_summary")) == bool(data.get("core_summary")):
        pairs.append(("all tasks", base["summary"], data["summary"]))
    if data.get("core_summary"):
        pairs.append(("core 14", base.get("core_summary") or base["summary"], data["core_summary"]))
    for label, a, b in pairs:
        print(f"compared with round {base_round} ({base['started']}), {label}:")
        for key in ("accuracy", "stability", "median_s", "p90_s", "median_api_calls", "median_chrome_calls",
                    "steps_per_chrome_call", "median_chrome_chars", "median_input_tokens", "median_output_tokens",
                    "median_cost_usd", "failed_steps"):
            va, vb = a.get(key), b.get(key)
            if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
                print(f"  {key:<22} {va:>10} -> {vb:<10} ({vb - va:+.3g})")
        fa, fb = set(a.get("failed", [])), set(b.get("failed", []))
        print(f"  now passing: {', '.join(sorted(fa - fb)) or 'none'}; now failing: {', '.join(sorted(fb - fa)) or 'none'}")


def installed_head(profile: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(profile_home(profile) / "plugins" / "hermes-pwa"), "log", "-1",
                               "--format=%h %s"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Runner C: the bot (LLM + its Chrome) on read-only interactive tasks.")
    ap.add_argument("--profile", default="kahunas-connector")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--tasks", default="", help="comma-separated task names from bot_tasks.py")
    group.add_argument("--all", action="store_true", help="every core task (with --extra, the extra ones too)")
    ap.add_argument("--extra", action="store_true", help="with --all: also the tasks added in round 8")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--workers", type=int, default=2, help="bot turns at a time (each has its own tab)")
    ap.add_argument("--round", type=int, default=0)
    ap.add_argument("--baseline", type=int, default=0)
    ap.add_argument("--timeout", type=int, default=420, help="seconds per task")
    ap.add_argument("--model", default="", help="model for these turns only (the profile is not changed)")
    ap.add_argument("--reasoning", default="", help="reasoning effort for these turns only")
    ap.add_argument("--tag", default="", help="suffix of the results kind: round-N-bot<tag>.json")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    if args.list:
        for t in T.TASKS:
            print(f"{t.name:<18}{t.about}")
        return 0
    if args.all:
        tasks = [t for t in T.TASKS if t.group == "core" or args.extra]
    elif args.tasks:
        want = [x.strip() for x in args.tasks.split(",") if x.strip()]
        unknown = [w for w in want if w not in {t.name for t in T.TASKS}]
        if unknown:
            raise SystemExit(f"unknown task(s): {', '.join(unknown)}")
        tasks = [t for t in T.TASKS if t.name in want]
    else:
        ap.error("choose --tasks a,b or --all")
    if not (profile_home(args.profile) / "state.db").is_file():
        raise SystemExit(f"no state.db for profile {args.profile}")
    ensure_run_dir()
    T.write_files()
    kind = "bot" + args.tag
    n = args.round or C.next_round(kind)
    started = C.now()
    truths: dict[str, Any] = {}
    for t in tasks:
        if t.truth is not None:
            try:
                truths[t.name] = t.truth()
            except Exception as exc:
                truths[t.name] = {"error": f"{type(exc).__name__}: {exc}"}
    print(f"Runner C round {n}: {len(tasks)} task(s) x {args.repeat}, {args.workers} at a time, bot {args.profile} "
          f"({installed_head(args.profile)})", flush=True)
    records: list[dict] = []
    lock = threading.Lock()
    for run_no in range(1, args.repeat + 1):
        # A task and the tasks that must follow it (download after upload) go to one worker, in order.
        chains: list[list[T.BotTask]] = []
        for t in tasks:
            prev = next((c for c in chains if c[-1].name == t.after), None) if t.after else None
            if prev is not None:
                prev.append(t)
            else:
                chains.append([t])
        queue = list(chains)

        def worker() -> None:
            while True:
                with lock:
                    if not queue:
                        return
                    chain = queue.pop(0)
                for t in chain:
                    rec = run_task(t, args.profile, n, run_no, args.timeout, truths.get(t.name), args.model,
                                   args.reasoning, args.tag)
                    with lock:
                        records.append(rec)
                        print(f"[run {run_no}] {'PASS' if rec['pass'] else 'FAIL'} {t.name:<18} {rec['wall_s']:>6}s "
                              f"calls {rec.get('api_calls')} chrome {rec.get('chrome_calls')} out {rec.get('chrome_chars')} "
                              f"| {C.cut(rec['answer'], 90)}" + ("" if rec["pass"] else f" | {C.cut(rec['why'], 120)}"),
                              flush=True)

        threads = [threading.Thread(target=worker) for _ in range(max(1, args.workers))]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
    order = {t.name: i for i, t in enumerate(T.TASKS)}
    records.sort(key=lambda r: (r["run"], order.get(r["name"], 99)))
    core = {t.name for t in T.TASKS if t.group == "core"}
    data = {"runner": "bot", "round": n, "profile": args.profile, "model": args.model, "reasoning": args.reasoning,
            "started": started, "finished": C.now(),
            "connector": {**C.fingerprint(), "installed": installed_head(args.profile)},
            "truths": truths, "summary": summarize(records), "prompts": records}
    if any(r["name"] not in core for r in records):
        # The 14 core tasks alone, comparable with the rounds before the extra tasks were added.
        data["core_summary"] = summarize([r for r in records if r["name"] in core])
    path = C.write_round(kind, n, data)
    print_scorecard(data)
    if args.baseline:
        print_compare(data, args.baseline, kind)
    print(f"results: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
