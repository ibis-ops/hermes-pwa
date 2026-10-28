#!/usr/bin/env python3
"""One chrome call on the bench home (port 9334), printed in full: for looking at a page while
writing or fixing a test. Never touches Sean's connector.

    $PY probe.py 'go https://example.com' [auto|full|text|none] [--fixtures] [--session=NAME] [--connector=DIR]

A literal \\n in the steps starts a new step. With --fixtures the local fixture server is started and
{base} in the steps becomes its address. --connector=DIR loads a copy of the connector from DIR.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    flags = [a for a in argv if a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    session, connector = "bench-probe", ""
    for f in flags:
        if f.startswith("--session="):
            session = f.split("=", 1)[1]
        elif f.startswith("--connector="):
            connector = f.split("=", 1)[1]
    steps = args[0].replace("\\n", "\n")
    mode = args[1] if len(args) > 1 else "auto"
    cc = C.load_connector(connector)
    if "--fixtures" in flags:
        import fixture_server as F
        fx = F.start()
        steps = steps.replace("{base}", fx.base)
    t0 = time.monotonic()
    out = cc.chrome_tool({"steps": steps, "map": mode}, session_id=session)
    print(out)
    print(f"--- wall {time.monotonic() - t0:.2f}s, {len(out)} chars")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
