"""Sync for the phone app's Obsidian tab: keep Obsidian open on the Mac.

The vault reaches the phone through Obsidian Sync, and Sync only runs while the
Obsidian app is open on the Mac. A note a bot writes while Obsidian is closed
waits on the Mac until it opens. The Sync button in the phone app asks this
module to open Obsidian on the Mac in the background when it is not running, so
Sync can upload what the bots wrote and pull down what was written on the phone.
It never reads or changes the vault's files.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

APP_NAME = "Obsidian"
# Wait this long, in half seconds, for a freshly opened Obsidian to show up.
START_CHECKS = 12

Runner = Callable[..., Any]


def app_paths() -> tuple[Path, ...]:
    return (Path("/Applications/Obsidian.app"), Path.home() / "Applications" / "Obsidian.app")


def installed() -> bool:
    return sys.platform == "darwin" and any(path.exists() for path in app_paths())


def running(run: Runner = subprocess.run) -> bool:
    try:
        result = run(["/usr/bin/pgrep", "-x", APP_NAME], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return getattr(result, "returncode", 1) == 0


def ensure_open(run: Runner = subprocess.run, sleep: Callable[[float], None] = time.sleep) -> dict[str, bool]:
    """``{"available", "running", "started"}``: whether Obsidian is on this Mac, whether it is
    running now, and whether this call had to open it."""
    if not installed():
        return {"available": False, "running": False, "started": False}
    if running(run):
        return {"available": True, "running": True, "started": False}
    try:
        # -g keeps it in the background: Sean is on his phone, not at the Mac.
        run(["/usr/bin/open", "-g", "-a", APP_NAME], capture_output=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return {"available": True, "running": False, "started": False}
    for _ in range(START_CHECKS):
        sleep(0.5)
        if running(run):
            return {"available": True, "running": True, "started": True}
    return {"available": True, "running": False, "started": True}
