#!/usr/bin/env python3
"""Ground truth for the Kahunas tasks of Runner C (round 28 on), read-only, through the Kahunas bot's own
connector (HERMES_HOME = its profile; the plugin copy it runs). Prints one JSON line of counts and page
titles: never a client's name, row contents or page text.

    HERMES_HOME=~/.hermes/profiles/kahunas-connector $PY -I kahunas_truth.py
"""
import json
import re
import sys
from pathlib import Path

home = Path.home() / ".hermes"
sys.path.insert(0, str(home / "hermes-agent"))
sys.path.insert(0, str(home / "profiles/kahunas-connector/plugins/hermes-pwa"))
import chrome_connector as cc  # noqa: E402

S = "bench-kahunas-truth"


def call(steps: str) -> str:
    return cc.chrome_tool({"steps": steps, "map": "none"}, session_id=S)


def stat(out: str, label: str) -> int | None:
    m = re.search(rf"(\d+) {label}\b", out)
    return int(m.group(1)) if m else None


def table_rows(out: str) -> int | None:
    m = re.search(r"read table: (\d+) rows", out)
    if m:
        return int(m.group(1)) - 1  # less the header row
    # The tab opened but holds no table: an empty plan (Kahunas shows only "Add supplement").
    if re.search(r"^2\. click ", out, re.M) and "no table on the page" in out:
        return 0
    return None


def main() -> int:
    out = call("go kahunas.io/coach/clients/all\nwait 2000\nread table\nread links")
    truth = {"active": stat(out, "ACTIVE CLIENTS"), "archived": stat(out, "ARCHIVED CLIENTS"),
             "new_checkins": stat(out, "NEW CHECK-INS")}
    views = list(dict.fromkeys(re.findall(r" (/coach/clients/view/[0-9A-Za-z-]+)$", out, re.M)))
    truth["clients_listed"] = len(views)
    sups = []
    for path in views[:3]:
        sups.append(table_rows(call(f"go kahunas.io{path}\nclick Supplements\nread table")))
    truth["supplements_first"] = sups[0] if sups else None
    truth["supplements_first3"] = sum(sups) if sups and None not in sups else None
    out = call("go kahunas.io/coach/daily_check_ins")
    m = re.search(r'^Page: "([^"]*)"', out, re.M)
    truth["daily_checkins_title"] = m.group(1) if m else None
    print(json.dumps(truth))
    return 0


if __name__ == "__main__":
    sys.exit(main())
