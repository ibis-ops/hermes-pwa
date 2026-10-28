#!/usr/bin/env python3
"""Runner B: the Chrome connector on live public sites, called directly (no LLM). Read-only.

Same metrics as Runner A (accuracy on run 1, stability over the runs, time, output size). Tasks and
their checks live in live_tasks.py. Uses the bench home (port 9334), never Sean's connector.

    PY=/Users/seanwoodward/.hermes/installs/a054e8eb893639fa/environments/144c13c0849643c59ebdb1c3c7f7f488/venv/bin/python
    $PY runner_b.py                         # every task x3; next round number
    $PY runner_b.py --round 2 --baseline 1
    $PY runner_b.py --only hn_front,books_product --repeat 1

Results: /tmp/hermes-work/bench/round-<N>-live.json, scorecard on stdout.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import live_tasks as L  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Runner B: the Chrome connector on live public sites (read-only, no LLM).")
    C.add_args(ap)
    args = ap.parse_args(argv)
    tests = C.select(L.TASKS, args.only, args.skip)
    if args.list:
        for t in L.TASKS:
            print(f"{t.name:<18}{t.scenario}")
        return 0
    cc = C.load_connector(args.connector)
    C.clean_bench_dirs()
    env = {"files": L.write_files()}
    n = args.round or C.next_round("live")
    started = C.now()
    print(f"Runner B round {n}: {len(tests)} live tasks x {args.repeat} runs, bench Chrome port {C.BENCH_PORT}, "
          f"home {C.BENCH_HOME}", flush=True)
    records = C.run_suite(cc, tests, env, args.repeat, "b")
    data = C.payload("live", n, started, records, [], repeat=args.repeat)
    path = C.write_round("live", n, data)
    C.print_scorecard("Runner B (direct, live sites)", data)
    if args.baseline:
        C.print_compare(data, args.baseline, "live")
    if args.stop:
        print(C.stop_bench_chrome(cc))
    print(f"results: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
