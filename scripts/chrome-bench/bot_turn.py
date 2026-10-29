"""One bot turn the way a CLI chat builds its agent (platform cli, the profile's own config, plugins
and skills), for Runner C. `hermes -z` goes through a local gateway surface whose tool list leaves
plugin tools out, so it cannot test the connector; this goes through hermes_cli.oneshot._run_agent.

Runner C starts it under Hermes's own runtime with HERMES_HOME set to the bot's profile:
    bot_turn.py "<prompt>" [--json out.json] [--model M] [--reasoning low|medium|high] [--toolsets a,b]
It prints the final answer, then one line: STATS {"seconds", "api_calls", "tools", "session_id", ...}.
--model, --reasoning and --toolsets override the profile for this one turn only (to measure a setting
without changing the bot's config)."""
import json
import os
import sys
import time
from contextlib import redirect_stderr, redirect_stdout

args = sys.argv[1:]
opts = {}
for flag in ("--json", "--model", "--reasoning", "--toolsets"):
    if flag in args:
        i = args.index(flag)
        opts[flag] = args[i + 1]
        del args[i:i + 2]
prompt = args[0]
os.environ.setdefault("HERMES_SINGLE_QUERY_SESSION", "1")
from hermes_cli import oneshot  # noqa: E402

t0 = time.monotonic()
error = ""
response, result = "", {}
with open(os.devnull, "w") as devnull, redirect_stdout(devnull), redirect_stderr(devnull):
    try:
        toolsets = [x.strip() for x in opts.get("--toolsets", "").split(",") if x.strip()] or None
        response, result = oneshot._run_agent(prompt, model=opts.get("--model"), reasoning=opts.get("--reasoning"),
                                               toolsets=toolsets, ledger=True)
    except Exception as exc:  # report it; the runner counts it as a crash
        error = f"{type(exc).__name__}: {exc}"
took = time.monotonic() - t0
tools = []
for m in (result or {}).get("messages") or []:
    for c in (m.get("tool_calls") or []) if isinstance(m, dict) else []:
        fn = (c.get("function") or {}) if isinstance(c, dict) else {}
        tools.append(fn.get("name"))
print(response)
stats = {"seconds": round(took, 2), "api_calls": (result or {}).get("api_calls"), "tools": tools,
         "input_tokens": (result or {}).get("input_tokens"), "output_tokens": (result or {}).get("output_tokens"),
         "session_id": (result or {}).get("session_id"), "error": error}
print("STATS " + json.dumps(stats))
if opts.get("--json"):
    with open(opts["--json"], "w") as fh:
        json.dump({"response": response, **stats}, fh)
sys.stdout.flush()
import atexit  # noqa: E402
atexit._run_exitfuncs()  # os._exit skips them: the connector closes this turn's tabs there
os._exit(0)
