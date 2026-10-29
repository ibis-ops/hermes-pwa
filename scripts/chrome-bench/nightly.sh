#!/bin/zsh
# Nightly regression check of the Chrome connector: Runner A (fixtures, 1 run, no cold pass), Runner B (live
# sites, 1 run) and, unless --no-bot is given, Runner C on 4 bot tasks (about $0.15), one after another.
# One row per night goes to ~/Developer/hermes-bench-data/nightly.md: pass counts per runner and every task
# that passed in the previous nightly and fails now. Exit 0 even when a regression is found; nonzero only
# when this script itself broke (cd, summary step, rsync).
# Usage: nightly.sh [--no-bot]
# Skips the night (logged, a SKIPPED row, exit 0) when the Mac is busy: 1-minute load above 8, system-wide free
# memory below 20% (memory_pressure; idle dev servers keep swap high without real pressure), or a runner_[abc].py
# process already running. Swap use is logged for reference.
# Round id = yymmdd, so nightly files (round-261029-direct.json, round-261029-live.json,
# round-261029-bot-nightly.json) stay apart from the numbered improvement rounds.
# Template for launchd: ai.hermes.chrome-bench-nightly.plist (03:45). launchd cannot read ~/Desktop: nothing
# here may depend on the vault.
BOT=1
for arg in "$@"; do
  case $arg in
    --no-bot) BOT=0 ;;
    *) print -u2 "usage: nightly.sh [--no-bot]"; exit 2 ;;
  esac
done
PY=/Users/seanwoodward/Developer/hermes-pwa/scripts/chrome-bench/hpy
B=/tmp/hermes-work/bench
L=$B/logs
D=~/Developer/hermes-bench-data
NOTES=$D/nightly.md
ROUND=$(date +%y%m%d)
LOG=$L/nightly-$ROUND.log
EXIT_CODE=0
typeset -A RC
mkdir -p $L $D || exit 1
exec >> $LOG 2>&1
log() { print "$(date '+%F %T') $*" }
log "nightly $ROUND started, bot runner $BOT"

# One row per night; the file gets a short header the first time.
note_row() {
  if [[ ! -f $NOTES ]]; then
    cat > $NOTES <<'EOF'
# Chrome connector nightly

One row per night from scripts/chrome-bench/nightly.sh (03:45): A = fixtures, B = live sites, C = the bot on 4 tasks.
Counts are tasks passed on run 1 out of the scored ones (blocked and stale tasks are not scored).
A regression is a task that passed in the previous nightly and fails now. Find them: grep REGRESSION nightly.md

| date | round | status | A | B | C | regressions vs previous nightly | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
EOF
  fi
  print -r -- "$1" >> $NOTES
}

# Busy Mac: leave it alone, say why in the log and in nightly.md. The bench times things, so a loaded Mac
# gives noise instead of a regression signal.
WHY=""
LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')     # "{ 6.94 5.41 3.24 }"
SWAP_MB=$(sysctl -n vm.swapusage | awk '{ for (i = 1; i < NF; i++) if ($i == "used") {
  v = $(i + 2); u = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
  if (u == "G") n *= 1024; else if (u == "K") n /= 1024
  printf "%.0f", n } }')                             # "used = 17454.56M"
# pgrep never lists itself; the awk drops this script too. A false match only skips a night.
RUNNING=$(pgrep -fl 'runner_[abc]\.py' | awk -v me=$$ '$1 != me')
if [[ -z $LOAD ]]; then
  log "warning: could not read the load average"
elif awk -v l=$LOAD 'BEGIN { exit !(l > 8) }'; then
  WHY="load average $LOAD above 8"
fi
FREE_PCT=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {gsub(/%/, "", $2); print $2 + 0}')
log "load ${LOAD:-?}, free memory ${FREE_PCT:-?}%, swap used ${SWAP_MB:-?} MB"
if [[ -z $FREE_PCT ]]; then
  log "warning: could not read the free memory"
elif (( FREE_PCT < 20 )); then
  WHY="${WHY:+$WHY; }free memory ${FREE_PCT}% below 20%"
fi
if [[ -n $RUNNING ]]; then
  WHY="${WHY:+$WHY; }a runner is already running: $(print -r -- $RUNNING | head -1 | cut -c1-120)"
fi
if [[ -n $WHY ]]; then
  log "skipped: $WHY"
  note_row "| $(date '+%F %H:%M') | $ROUND | SKIPPED | - | - | - | - | busy: $WHY |"
  exit 0
fi

cd ~/Developer/hermes-pwa/scripts/chrome-bench || { log "cannot cd to the bench folder"; exit 1; }
rm -f $L/nightly-$ROUND.done

# phase LABEL RESULTS-FILE COMMAND...: runs one runner; a failing runner does not stop the next one. Safe to
# run again the same day: a phase whose results file exists is skipped, and an interrupted one resumes from
# its round-<id>-<kind>.partial.jsonl.
phase() {
  local label=$1 results=$2 rc
  shift 2
  if [[ -f $B/$results ]]; then log "$label already done"; RC[$label]=0; return; fi
  log "$label started"
  "$@"; rc=$?
  RC[$label]=$rc
  log "$label ended ($rc)"
}
phase A round-$ROUND-direct.json $PY runner_a.py --repeat 1 --no-cold --round $ROUND
phase B round-$ROUND-live.json $PY runner_b.py --repeat 1 --round $ROUND --stop   # --stop: no bench Chrome left up
if (( BOT )); then
  phase C round-$ROUND-bot-nightly.json $PY runner_c.py --tasks heroku_dynamic,books_page2,github_repo,trouble_retry \
    --repeat 1 --round $ROUND --tag=-nightly
fi

# The row: counts from each results file, regressions against the previous nightly of the same kind (the highest
# six-digit round id below today's, found in the bench folder, else in the rsync copy after a reboot cleared /tmp).
build_row() {
  $PY -I - "$@" <<'PYEOF'
import json
import re
import sys
from datetime import datetime
from pathlib import Path

out_dir, bak_dir, round_id, rc_a, rc_b, rc_c, minutes = sys.argv[1:8]
RUNNERS = [("A", "direct", rc_a), ("B", "live", rc_b), ("C", "bot-nightly", rc_c)]


def marks(kind, data):
    """name -> P pass, F fail, B blocked (A, B) or S stale (C), from run 1 of each test."""
    bot = kind == "bot-nightly"
    out = {}
    for r in sorted(data["prompts"] if bot else data["tests"], key=lambda r: r.get("run", 1)):
        if bot:
            m = "S" if r.get("stale") else ("P" if r.get("pass") else "F")
        else:
            m = "B" if r.get("blocked") else ("P" if r.get("pass") else "F")
        out.setdefault(r["name"], m)
    return out


def previous(kind):
    best = None
    for d in (out_dir, bak_dir):
        for p in Path(d).glob(f"round-*-{kind}.json"):
            m = re.fullmatch(r"round-(\d{6})-" + re.escape(kind) + r"\.json", p.name)
            if m and int(m.group(1)) < int(round_id) and (best is None or int(m.group(1)) > best[0]):
                best = (int(m.group(1)), p)
    return best


cells, reg_parts, notes, bases, failed = {}, [], [], {}, False
for label, kind, rc in RUNNERS:
    if rc == "-":
        cells[label] = "not run"
        continue
    cur_path = Path(out_dir) / f"round-{round_id}-{kind}.json"
    try:
        cur = marks(kind, json.loads(cur_path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        cells[label] = f"FAILED (exit {rc})" if rc != "0" else "FAILED (no results)"
        failed = True
        print(f"{label}: {cur_path.name} not usable: {type(exc).__name__}: {exc}", file=sys.stderr)
        continue
    scored = [n for n, m in cur.items() if m in "PF"]
    cell = f"{sum(1 for n in scored if cur[n] == 'P')}/{len(scored)}"
    for letter, word in (("B", "blocked"), ("S", "stale")):
        k = sum(1 for m in cur.values() if m == letter)
        if k:
            cell += f" ({k} {word})"
    cells[label] = cell
    if rc != "0":
        failed = True
        notes.append(f"{label} exit {rc}")
    prev, old = previous(kind), None
    if prev:
        try:
            old = marks(kind, json.loads(prev[1].read_text(encoding="utf-8")))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            notes.append(f"{label} previous nightly {prev[0]} unreadable")
            print(f"{label}: {prev[1]} not usable: {type(exc).__name__}: {exc}", file=sys.stderr)
    print(f"{label}: {cur_path.name} vs {prev[1] if prev else 'no previous nightly'}", file=sys.stderr)
    regs = []
    if old is not None:
        bases[label] = prev[0]
        regs = sorted(n for n, m in cur.items() if m == "F" and old.get(n) == "P")
        fixed = sorted(n for n, m in cur.items() if m == "P" and old.get(n) == "F")
        if regs:
            reg_parts.append(f"{label} {', '.join(regs)}")
        if fixed:
            notes.append(f"{label} fixed: {', '.join(fixed)}")
    other = sorted(n for n, m in cur.items() if m == "F" and n not in regs)
    if other:
        notes.append(f"{label} also failing: {', '.join(other)}")

status = " ".join(([] if not reg_parts else ["**REGRESSION**"]) + (["RUNNER-FAILED"] if failed else [])) or "OK"
reg_col = "; ".join(reg_parts) if reg_parts else ("none" if bases else "n/a (no previous nightly)")
if bases:
    ids = sorted(set(bases.values()))
    reg_col += " (vs " + (str(ids[0]) if len(ids) == 1 else ", ".join(f"{k} {v}" for k, v in bases.items())) + ")"
notes.append(f"{minutes} min")
print(f"| {datetime.now().strftime('%Y-%m-%d %H:%M')} | {round_id} | {status} | A {cells['A']} | B {cells['B']} "
      f"| C {cells['C']} | {reg_col} | {'; '.join(notes)} |")
PYEOF
}
ROW=$(build_row $B $D/bench $ROUND ${RC[A]:--} ${RC[B]:--} ${RC[C]:--} $(( SECONDS / 60 )))
if [[ $? -ne 0 || -z $ROW ]]; then
  log "summary step failed"
  ROW="| $(date '+%F %H:%M') | $ROUND | ERROR | - | - | - | - | summary step failed, see nightly-$ROUND.log |"
  EXIT_CODE=1
fi
note_row "$ROW"
log "row: $ROW"
date > $L/nightly-$ROUND.done
log "nightly $ROUND finished"

# /tmp is cleared on a reboot: copy the bench folder to ~/Developer/hermes-bench-data like round.sh does.
rsync -a --exclude 'stray-downloads/' $B/ $D/bench/ || { log "rsync failed ($?)"; EXIT_CODE=1; }
exit $EXIT_CODE
