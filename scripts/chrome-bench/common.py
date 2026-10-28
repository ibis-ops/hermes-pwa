"""Shared plumbing for the Chrome connector bench (Runners A and B): the isolated Hermes home,
loading the connector against it, timed calls, parsing replies, scoring runs, round files.

The bench never touches Sean's connector: HERMES_HOME points at BENCH_HOME before chrome_connector
is imported, and guard() stops the run unless the loaded settings say port 9334 inside that home.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

REPO = Path.home() / "Developer" / "hermes-pwa"
BENCH_HOME = Path("/tmp/hermes-work/cx-bench-home")
BENCH_CHROME = BENCH_HOME / "chrome"
BENCH_PORT = 9334
SEAN_PORT = 9333
OUT_DIR = Path("/tmp/hermes-work/bench")
FILES_DIR = OUT_DIR / "files"


# ---------------------------------------------------------------------------------------------
# The isolated home and the connector
# ---------------------------------------------------------------------------------------------

def setup_home() -> None:
    """chrome/connector.json {"port": 9334, "headless": true} and an empty profile folder."""
    (BENCH_CHROME / "profile").mkdir(parents=True, exist_ok=True)
    cfg = BENCH_CHROME / "connector.json"
    want = {"port": BENCH_PORT, "headless": True}
    try:
        current = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = None
    if current != want:
        cfg.write_text(json.dumps(want) + "\n", encoding="utf-8")
    os.environ["HERMES_HOME"] = str(BENCH_HOME)


CONNECTOR_DIR = REPO


def load_connector(folder: str = ""):
    """Import chrome_connector against the bench home (never Sean's). `folder` points at a copy of
    chrome_connector.py and .js to test instead of the repo's (to try a change before applying it)."""
    global CONNECTOR_DIR
    if "chrome_connector" in sys.modules:
        raise SystemExit("bench guard: chrome_connector was imported before HERMES_HOME pointed at the bench home")
    if folder:
        CONNECTOR_DIR = Path(folder).expanduser().resolve()
    setup_home()
    sys.path.insert(0, str(CONNECTOR_DIR))
    import chrome_connector as cc  # noqa: E402
    if Path(cc.__file__).resolve().parent != CONNECTOR_DIR.resolve():
        raise SystemExit(f"bench guard: imported {cc.__file__}, expected the copy in {CONNECTOR_DIR}")
    guard(cc)
    return cc


def guard(cc) -> Any:
    s = cc.load_settings()
    if s is None or s.port != BENCH_PORT or s.port == SEAN_PORT or Path(s.home).resolve() != BENCH_CHROME.resolve():
        raise SystemExit(f"bench guard: connector settings are {s}; the bench runs only on port {BENCH_PORT} in {BENCH_CHROME}")
    return s


def clean_bench_dirs() -> None:
    """Drop what earlier runs left in the bench home (downloads, history, saved reads, screenshots).
    Call it before the first chrome call of the process: Chrome saves downloads into that folder."""
    for name in ("downloads", "history", "reads", "shots"):
        shutil.rmtree(BENCH_CHROME / name, ignore_errors=True)
    (BENCH_CHROME / "downloads").mkdir(parents=True, exist_ok=True)


def stop_bench_chrome(cc) -> str:
    """Stop the bench Chrome (port 9334 on the bench profile only) and forget the connection, as a
    fresh process would."""
    s = guard(cc)
    msg = cc.stop_chrome(s)
    with cc._BROWSERS_LOCK:
        b = cc._BROWSERS.pop(s.port, None)
    if b is not None and b.cdp is not None:
        b.cdp.close()
    cc._JS_CACHE.clear()
    t0 = time.monotonic()
    while cc.chrome_version(s.port) is not None and time.monotonic() - t0 < 10:
        time.sleep(0.1)
    return msg


def close_session(cc, key: str) -> None:
    """Close the tabs a test session opened, so every test starts on a fresh tab."""
    try:
        b = cc.browser_for(cc.load_settings())
        with b.lock:
            sess = b.sessions.pop(key, None)
        if sess is not None:
            for tab in list(sess.tabs):
                b.close_tab(tab)
    except Exception:
        pass


def sweep_tabs(cc) -> int:
    """Close http(s) tabs no session owns (a new tab a test failed to adopt, for example)."""
    try:
        b = cc.browser_for(cc.load_settings())
        if b.cdp is None or b.cdp.closed:
            return 0
        owned = {t.target_id for s in b.sessions.values() for t in s.tabs}
        n = 0
        for info in b.cdp.send("Target.getTargets", timeout=5).get("targetInfos", []):
            if info.get("type") == "page" and info.get("targetId") not in owned and re.match(r"^https?:", info.get("url", "")):
                b.cdp.send("Target.closeTarget", {"targetId": info["targetId"]}, timeout=5)
                n += 1
        return n
    except Exception:
        return 0


def fingerprint() -> dict:
    """Which connector code a round ran (file hashes and the repo HEAD)."""
    out: dict[str, str] = {}
    for ext in ("py", "js"):
        try:
            out[ext] = hashlib.sha256((CONNECTOR_DIR / f"chrome_connector.{ext}").read_bytes()).hexdigest()[:12]
        except OSError:
            out[ext] = "missing"
    if CONNECTOR_DIR != REPO:
        out["dir"] = str(CONNECTOR_DIR)
    try:
        out["git"] = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True,
                                    text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        out["git"] = ""
    return out


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------------------------
# Calls and replies
# ---------------------------------------------------------------------------------------------

def count_steps(steps: Any) -> int:
    if isinstance(steps, str):
        return sum(1 for ln in steps.split("\n") if ln.strip() and not ln.strip().startswith("#"))
    if isinstance(steps, list):
        return len(steps)
    return 1


def tool_seconds(out: str) -> Optional[float]:
    """The time the tool reports in its header line: "chrome: 3 steps in 1.2s"."""
    m = re.match(r"chrome: (?:FAILED, )?\d+ steps? in ([\d.]+)s", out)
    return float(m.group(1)) if m else None


_FAIL = re.compile(r"^\s*(?:[\w.-]*\d+\.\s+(?:FAILED|stopped)|FAILED)")


def failure_lines(out: str) -> list[str]:
    return [cut(ln, 300) for ln in out.split("\n") if _FAIL.match(ln)][:6]


def cut(s: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s if len(s) <= n else s[: n - 3] + "..."


@dataclass
class CallRec:
    steps: int
    wall: float
    tool_s: Optional[float]
    chars: int
    failures: list
    out: str


class Ctx:
    """What a test gets: timed chrome calls on its own session, plus the env (t.base, t.state...)."""

    def __init__(self, cc, session: str, env: dict) -> None:
        self.cc = cc
        self.session = session
        self.env = env
        self.calls: list[CallRec] = []

    def __getattr__(self, name: str) -> Any:
        env = self.__dict__.get("env") or {}
        if name in env:
            return env[name]
        raise AttributeError(name)

    def call(self, steps: Any, map: str = "none", **args: Any) -> str:
        payload = {"steps": steps, "map": map, **args}
        t0 = time.monotonic()
        out = self.cc.chrome_tool(payload, session_id=self.session)
        wall = time.monotonic() - t0
        self.calls.append(CallRec(count_steps(steps), wall, tool_seconds(out), len(out), failure_lines(out), out))
        return out

    def history(self, verify: bool = False) -> str:
        t0 = time.monotonic()
        out = self.cc.chrome_history_tool({"verify": verify}, session_id=self.session)
        self.calls.append(CallRec(0, time.monotonic() - t0, None, len(out), [], out))
        return out


def check(cond: Any, what: str, got: Any = None) -> tuple[bool, str]:
    """(passed, detail): the detail says what was expected and, on failure, what came back."""
    if cond:
        return True, what
    return False, f"expected {what}" + ("" if got is None else f"; got {cut(got, 400)}")


_ITEMS = re.compile(r"read (?P<spec>[^\n]*?): (?P<n>\d+) items\n(?P<body>(?:[ \t]+(?:- |\[\.\.\. )[^\n]*(?:\n|$))*)")
_TABLE = re.compile(r"read (?P<spec>table[^\n]*?): (?P<n>\d+) rows[^\n]*\n(?P<body>(?:[ \t]+[^\n]*(?:\n|$))*)")
_SAVED = re.compile(r"saved to (\S+?)\]")


def _saved_text(body: str) -> Optional[str]:
    m = _SAVED.search(body)
    if not m:
        return None
    try:
        return Path(m.group(1)).read_text(encoding="utf-8")
    except OSError:
        return None


def read_items(out: str, spec: str = "") -> list[list[str]]:
    """Item lists of the `read <spec>...: N items` steps in a reply (overflow files read back)."""
    res = []
    for m in _ITEMS.finditer(out):
        if spec and not m.group("spec").startswith(spec):
            continue
        body = _saved_text(m.group("body")) or m.group("body")
        res.append([ln.strip()[2:] for ln in body.split("\n") if ln.strip().startswith("- ")])
    return res


def read_tables(out: str) -> list[list[list[str]]]:
    """Rows (lists of cells) of the `read table...` steps in a reply (overflow files read back)."""
    res = []
    for m in _TABLE.finditer(out):
        saved = _saved_text(m.group("body"))
        lines = saved.split("\n") if saved is not None else [ln[3:] if ln.startswith("   ") else ln.strip()
                                                             for ln in m.group("body").split("\n")]
        res.append([ln.split("\t") for ln in lines if ln.strip() and not ln.startswith("[... ")])
    return res


def with_saved(out: str) -> str:
    """The reply plus the text of every overflow file it points to."""
    extra = []
    for p in _SAVED.findall(out):
        try:
            extra.append(Path(p).read_text(encoding="utf-8"))
        except OSError:
            pass
    return out + "\n" + "\n".join(extra)


def find_ref(out: str, role: str, name: str) -> Optional[str]:
    m = re.search(r"(?m)^\s*[+~]?(e\d+) " + re.escape(role) + r' "' + re.escape(name) + r'"', out)
    return m.group(1) if m else None


def downloaded(out: str) -> tuple[Optional[Path], Optional[bytes]]:
    m = re.search(r"download saved: (.+?) \(\d+ KB", out)
    if not m:
        return None, None
    p = Path(m.group(1))
    try:
        return p, p.read_bytes()
    except OSError:
        return p, None


def dict_diff(want: dict, got: Any) -> dict:
    if not isinstance(got, dict):
        return {"(nothing saved)": got}
    return {k: {"want": v, "got": got.get(k)} for k, v in want.items() if got.get(k) != v}


# ---------------------------------------------------------------------------------------------
# Tests, runs and records
# ---------------------------------------------------------------------------------------------

@dataclass
class Test:
    name: str
    scenario: str
    fn: Callable[[Ctx], Any]
    budget: Optional[float] = None
    meta: dict = field(default_factory=dict)


def registry() -> tuple[list[Test], Callable]:
    """TESTS, test = registry(); then @test("name", "scenario", budget=1.5) on each function."""
    tests: list[Test] = []

    def deco(name: str, scenario: str, budget: Optional[float] = None, **meta: Any) -> Callable:
        def wrap(fn: Callable) -> Callable:
            tests.append(Test(name, scenario, fn, budget, meta))
            return fn
        return wrap
    return tests, deco


def select(tests: list[Test], only: str = "", skip: str = "") -> list[Test]:
    want = [x.strip() for x in only.split(",") if x.strip()]
    drop = {x.strip() for x in skip.split(",") if x.strip()}
    unknown = [w for w in want + sorted(drop) if w not in {t.name for t in tests}]
    if unknown:
        raise SystemExit(f"unknown test(s): {', '.join(unknown)}")
    return [t for t in tests if (not want or t.name in want) and t.name not in drop]


def run_test(cc, test: Test, env: dict, run_no: int, tag: str, reset: Optional[Callable] = None) -> dict:
    session = f"bench-{tag}-{test.name}-r{run_no}-{os.getpid()}-{int(time.time() * 1000) % 10 ** 7}"
    ctx = Ctx(cc, session, env)
    if reset is not None:
        reset()
    t0 = time.monotonic()
    error = ""
    try:
        res = test.fn(ctx)
        passed, detail = res if isinstance(res, tuple) else (bool(res), "")
    except Exception as exc:  # a bench bug or an exception out of the connector
        passed, detail = False, f"bench error: {type(exc).__name__}: {exc}"
        error = traceback.format_exc(limit=5)
    finally:
        close_session(cc, session)
        sweep_tabs(cc)
    # A live site that walls the browser off (bot check, login wall) is "blocked": reported, not scored.
    blocked = isinstance(passed, str) and passed == "blocked"
    tool = [c.tool_s for c in ctx.calls if c.tool_s is not None]
    rec: dict[str, Any] = {
        "name": test.name, "scenario": test.scenario, "run": run_no, "pass": (not blocked) and bool(passed),
        "blocked": blocked, "detail": cut(detail, 700),
        "wall_s": round(sum(c.wall for c in ctx.calls), 3), "test_s": round(time.monotonic() - t0, 3),
        "first_call_s": round(ctx.calls[0].wall, 3) if ctx.calls else None,
        "tool_s": round(sum(tool), 2) if tool else None, "steps": sum(c.steps for c in ctx.calls),
        "calls": len(ctx.calls), "chars": sum(c.chars for c in ctx.calls),
        "failures": [f for c in ctx.calls for f in c.failures][:8],
    }
    if test.budget is not None:
        rec["budget_s"] = test.budget
        rec["over_budget"] = rec["wall_s"] > test.budget
    if error:
        rec["error"] = error
    if not rec["pass"]:
        rec["outputs"] = [c.out[:6000] for c in ctx.calls]
    return rec


def _mark(rec: dict) -> str:
    return "B" if rec.get("blocked") else ("P" if rec["pass"] else "F")


def progress(rec: dict, label: str) -> None:
    word = {"B": "BLOCKED", "P": "PASS", "F": "FAIL"}[_mark(rec)]
    line = (f"{label} {word} {rec['name']:<26} {rec['wall_s']:6.2f}s "
            f"{rec['steps']:>3} steps {rec['chars']:>6} chars")
    if rec.get("over_budget"):
        line += f" (over {rec['budget_s']}s budget)"
    if not rec["pass"]:
        line += f"  | {cut(rec['detail'], 220)}"
    print(line, flush=True)


def run_suite(cc, tests: list[Test], env: dict, repeat: int, tag: str, reset: Optional[Callable] = None) -> list[dict]:
    """Every test once per run, `repeat` full runs (run 1 is the accuracy pass, all runs the stability pass)."""
    records = []
    for run_no in range(1, repeat + 1):
        for i, t in enumerate(tests, 1):
            rec = run_test(cc, t, env, run_no, tag, reset)
            records.append(rec)
            progress(rec, f"[run {run_no}/{repeat} {i:>2}/{len(tests)}]")
    return records


def run_cold(cc, tests: list[Test], env: dict, tag: str, reset: Optional[Callable] = None) -> list[dict]:
    """Each test with the bench Chrome stopped first: its first call includes the Chrome launch."""
    out = []
    for i, t in enumerate(tests, 1):
        stop_bench_chrome(cc)
        rec = run_test(cc, t, env, 1, f"{tag}-cold", reset)
        rec["cold"] = True
        out.append(rec)
        progress(rec, f"[cold {i}/{len(tests)}]")
    return out


# ---------------------------------------------------------------------------------------------
# Scorecard
# ---------------------------------------------------------------------------------------------

def _median(vals: list) -> Optional[float]:
    vals = [v for v in vals if v is not None]
    return round(statistics.median(vals), 3) if vals else None


def _p90(vals: list) -> Optional[float]:
    vals = sorted(v for v in vals if v is not None)
    return round(vals[max(0, math.ceil(0.9 * len(vals)) - 1)], 3) if vals else None


def _pct(a: int, b: int) -> float:
    return round(100.0 * a / b, 1) if b else 0.0


def summarize(records: list[dict], cold: list[dict]) -> dict:
    names = list(dict.fromkeys(r["name"] for r in records))
    by = {n: [r for r in records if r["name"] == n] for n in names}
    first = {n: by[n][0] for n in names}
    stable = [n for n in names if len({_mark(r) for r in by[n]}) == 1]
    blocked = [n for n in names if first[n].get("blocked")]
    scored = [n for n in names if n not in blocked]
    scored_recs = [r for r in records if not r.get("blocked")]
    s: dict[str, Any] = {
        "tests": len(scored), "runs": max((r["run"] for r in records), default=0),
        "passed": sum(1 for n in scored if first[n]["pass"]),
        "accuracy": _pct(sum(1 for n in scored if first[n]["pass"]), len(scored)),
        "pass_rate_all_runs": _pct(sum(1 for r in scored_recs if r["pass"]), len(scored_recs)),
        "stability": _pct(len(stable), len(names)),
        "flaky": [n for n in names if n not in stable],
        "blocked": blocked,
        "failed_run1": [n for n in scored if not first[n]["pass"]],
        "median_s": _median([r["wall_s"] for r in records]), "p90_s": _p90([r["wall_s"] for r in records]),
        "median_tool_s": _median([r["tool_s"] for r in records]),
        "median_chars": _median([r["chars"] for r in records]),
        "chars_run1": sum(first[n]["chars"] for n in names),
        "median_steps": _median([r["steps"] for r in records]),
        "over_budget": sorted({r["name"] for r in records if r.get("over_budget")}),
        "bench_errors": sorted({r["name"] for r in records if str(r.get("detail", "")).startswith("bench error")}),
        "per_test": {n: {"results": "".join(_mark(r) for r in by[n]),
                         "median_s": _median([r["wall_s"] for r in by[n]]),
                         "median_chars": _median([r["chars"] for r in by[n]]), "steps": first[n]["steps"]}
                     for n in names},
    }
    if cold:
        s["cold"] = {"runs": len(cold), "passed": sum(1 for c in cold if c["pass"]),
                     "median_first_call_s": _median([c["first_call_s"] for c in cold]),
                     "median_s": _median([c["wall_s"] for c in cold]),
                     "per_test": {c["name"]: {"pass": c["pass"], "first_call_s": c["first_call_s"], "wall_s": c["wall_s"]}
                                  for c in cold}}
    return s


def payload(kind: str, n: int, started: str, records: list[dict], cold: list[dict], **extra: Any) -> dict:
    return {"runner": kind, "round": n, "started": started, "finished": now(), "connector": fingerprint(),
            "bench": {"port": BENCH_PORT, "home": str(BENCH_HOME), "python": sys.version.split()[0], **extra},
            "summary": summarize(records, cold), "tests": records, "cold": cold}


def round_path(kind: str, n: int) -> Path:
    return OUT_DIR / f"round-{n}-{kind}.json"


def next_round(kind: str) -> int:
    nums = []
    for p in OUT_DIR.glob(f"round-*-{kind}.json"):
        m = re.match(rf"round-(\d+)-{kind}\.json$", p.name)
        if m:
            nums.append(int(m.group(1)))
    return max(nums, default=0) + 1


def write_round(kind: str, n: int, data: dict) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = round_path(kind, n)
    p.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    return p


def print_scorecard(title: str, data: dict) -> None:
    s = data["summary"]
    c = data["connector"]
    print("=" * 100)
    print(f"{title}: round {data['round']}, {data['started']} to {data['finished']}, "
          f"connector py {c.get('py')} js {c.get('js')} (repo {c.get('git')})")
    print(f"accuracy    {s['passed']}/{s['tests']} = {s['accuracy']}% passed on run 1 (all {s['runs']} runs: {s['pass_rate_all_runs']}%)")
    print(f"stability   {s['stability']}% of tests gave the same result on all {s['runs']} runs"
          + (f"; flaky: {', '.join(s['flaky'])}" if s["flaky"] else ""))
    print(f"time        median {s['median_s']}s, p90 {s['p90_s']}s per test (wall); tool-reported median {s['median_tool_s']}s")
    print(f"output      median {s['median_chars']} chars per test (token proxy); run 1 total {s['chars_run1']} chars")
    print(f"steps       median {s['median_steps']} per test")
    if s.get("cold"):
        k = s["cold"]
        print(f"cold start  {k['passed']}/{k['runs']} passed, first call median {k['median_first_call_s']}s "
              f"(includes the Chrome launch), test median {k['median_s']}s")
    if s.get("blocked"):
        print(f"blocked     {', '.join(s['blocked'])}: the site walled the browser off on run 1 (not scored)")
    if s["over_budget"]:
        print(f"over budget {', '.join(s['over_budget'])}")
    if s["bench_errors"]:
        print(f"BENCH ERRORS (fix the bench, not the connector): {', '.join(s['bench_errors'])}")
    print("-" * 100)
    print(f"{'test':<28}{'runs':<8}{'median s':>9}{'chars':>8}{'steps':>6}")
    for name, p in s["per_test"].items():
        print(f"{name:<28}{p['results']:<8}{p['median_s']:>9}{int(p['median_chars'] or 0):>8}{p['steps']:>6}")
    failing = [n for n, p in s["per_test"].items() if "F" in p["results"] or "B" in p["results"]]
    if failing:
        print("-" * 100)
        print("failures (B = blocked by the site):")
        for name in failing:
            recs = [r for r in data["tests"] if r["name"] == name and not r["pass"]]
            r = next((x for x in recs if not x.get("blocked")), recs[0])
            print(f"  {name} [{s['per_test'][name]['results']}]: {cut(r['detail'], 400)}")
            for f in r.get("failures", [])[:4]:
                print(f"      {cut(f, 240)}")
    for k in data.get("cold") or []:
        if not k["pass"]:
            print(f"  cold {k['name']}: {cut(k['detail'], 300)}")
    print("=" * 100)


def print_compare(data: dict, base_round: int, kind: str) -> None:
    p = round_path(kind, base_round)
    try:
        base = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print(f"no baseline {p}")
        return
    a, b = base["summary"], data["summary"]
    print(f"compared with round {base_round} ({base['started']}, connector py {base['connector'].get('py')}):")
    for key, label in (("accuracy", "accuracy %"), ("stability", "stability %"), ("median_s", "median s"),
                       ("p90_s", "p90 s"), ("median_chars", "median chars"), ("chars_run1", "run 1 chars")):
        va, vb = a.get(key), b.get(key)
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            print(f"  {label:<14} {va:>10} -> {vb:<10} ({vb - va:+.3g})")
    pa, pb = a.get("per_test", {}), b.get("per_test", {})
    fixed = [n for n in pb if n in pa and "F" in pa[n]["results"] and "F" not in pb[n]["results"]]
    broke = [n for n in pb if n in pa and "F" not in pa[n]["results"] and "F" in pb[n]["results"]]
    print(f"  now passing: {', '.join(fixed) or 'none'}")
    print(f"  now failing: {', '.join(broke) or 'none'}")


def add_args(ap: argparse.ArgumentParser, repeat: int = 3) -> None:
    ap.add_argument("--round", type=int, default=0, help="round number for the results file (default: next free)")
    ap.add_argument("--repeat", type=int, default=repeat, help=f"full runs; run 1 is the accuracy pass (default {repeat})")
    ap.add_argument("--only", default="", help="comma-separated test names")
    ap.add_argument("--skip", default="", help="comma-separated test names to leave out")
    ap.add_argument("--baseline", type=int, default=0, help="print the change against this round")
    ap.add_argument("--list", action="store_true", help="list the tests and exit")
    ap.add_argument("--stop", action="store_true", help="stop the bench Chrome (port 9334) at the end")
    ap.add_argument("--connector", default="", help="folder with a copy of chrome_connector.py and .js to test "
                                                    "instead of the repo's (try a change before applying it)")
