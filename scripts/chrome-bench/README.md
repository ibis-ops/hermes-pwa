# Chrome connector bench

A test bench for the speed, accuracy and reliability of the Chrome connector
(`chrome_connector.py` and `chrome_connector.js`). Three runners:

| Runner | What it drives | Ground truth | Results file |
| --- | --- | --- | --- |
| A `runner_a.py` | `chrome_tool` directly, local fixture site | what the fixture server received, file bytes, generated data | `/tmp/hermes-work/bench/round-<N>-direct.json` |
| B `runner_b.py` | `chrome_tool` directly, live public sites (read-only) | exact values or patterns on the live page | `/tmp/hermes-work/bench/round-<N>-live.json` |
| C `runner_c.py` | the bot itself (LLM + its own Chrome), one CLI-style turn per task (`bot_turn.py`) | the answer, and for actions the bot's chrome change history | `/tmp/hermes-work/bench/round-<N>-bot.json` |

`scripts/` is never shipped, so none of this reaches the plugin package.

## Isolation and safety

- Runners A and B set `HERMES_HOME=/tmp/hermes-work/cx-bench-home` before importing the connector.
  That home holds `chrome/connector.json` (`{"port": 9334, "headless": true}`) and its own Chrome
  profile `chrome/profile` (it starts empty). `common.guard()` stops the run unless the loaded
  settings say port 9334 inside that home, so the bench never touches port 9333 or Sean's connector
  (`~/.hermes/profiles/kahunas-connector`). The cold-start pass stops only the Chrome that listens on
  9334 with the bench profile.
- The bench Chrome stays up between runs, like the real connector. `--stop` stops it at the end.
- Live sites are read-only: no logins, purchases, posts, votes or messages. Only the automation demos
  are typed into (the-internet.herokuapp.com, which also receives one small text file on its upload
  page, and the Playwright TodoMVC demo).
- A live page that walls the browser off (a bot check, a login wall) is recorded as **blocked**. The
  bench never tries to get past it; blocked tasks are listed but not scored.
- Runner C reads the bot's `state.db` read-only (`mode=ro`) and keeps only counts and the final
  answer, never tool outputs or the system prompt.

## Running

Use Hermes's Python (it has `websockets`):

```sh
PY=/Users/seanwoodward/.hermes/installs/a054e8eb893639fa/environments/144c13c0849643c59ebdb1c3c7f7f488/venv/bin/python
cd ~/Developer/hermes-pwa/scripts/chrome-bench
```

A full Runner A run (3 runs plus the cold-start pass) takes about 2 minutes and Runner B about 1.5
minutes; Runner C takes from seconds to minutes per prompt. A remote shell may time out after about
60 s while the run keeps going, so start long runs in the background and read the log:

```sh
nohup $PY runner_a.py --round 2 --baseline 1 > /tmp/hermes-work/bench/logs/round-2-direct.log 2>&1 &
tail -f /tmp/hermes-work/bench/logs/round-2-direct.log
```

Every runner saves each finished test or task to `round-<N>-<kind>.partial.jsonl` as it ends. Run the
same command with the same `--round` after an interruption and it keeps what was saved and runs only the
rest (Runner C reruns a chain such as upload then download unless every task in it was saved). The
partial file is removed once `round-<N>-<kind>.json` is written.

### Runner A (fixtures, no LLM)

```sh
$PY runner_a.py                          # all tests x3, then the cold-start pass; next free round number
$PY runner_a.py --round 2 --baseline 1   # numbered round, compared with round 1
$PY runner_a.py --only spa_nowait,stale_refs --repeat 1 --no-cold   # a quick look at a few tests
$PY runner_a.py --list                   # test names and what each covers
```

It starts `fixture_server.py` on a free port of 127.0.0.1 (pages in `fixtures/`, generated pages and
JSON endpoints with deliberate delays) and runs each test on a fresh tab. Every page reports what the
browser did to the server, so checks do not trust what the connector read back. Coverage: plain text,
a 45k-character article, tables (a rule over 60 rows; the second table by caption), a form with every
common field type (text, email, number, date, textarea, native select, checkboxes, radios, checkboxes
hidden behind their labels), radio by group label, `chrome_history` verify, a React-like controlled
input and a change-only framework, a search-as-you-type combobox (with and without a wait, and a
`wait option:<name>` role target), a custom ARIA dropdown (by clicks and with `select`), a SPA that
fetches its list 300 to 900 ms after load and paginates, `read api`, confirm/alert/prompt, a cookie banner covering a button, a modal dialog, `target=_blank` and
`window.open` tabs, same-origin and cross-origin iframes, nested open shadow roots (click, pointerdown,
typing), a file input and a script-opened file picker, downloads (attachment link, URL, blob), infinite
scroll, sign-in detection (one and two steps; passwords never echoed or typed), controls re-rendered
with new nodes (stale refs), slow images and scripts, `each`, tabs, back/forward/reload, a bare
`localhost:port` address and a hover menu. The `target_*` tests (fixtures `targets.html`,
`results.html`) hold each target form the bot wrote in rounds 8 to 12 that the connector once refused:
`X in Y` for a control in a row, `text:`, `role:`, `#id` without `css=`, kind nouns (`Login button`,
`Card A`), an unlabelled list under its heading, typing into the box a Search button opens, two tables
with the same header, a row action shown only on hover, ordinals (`first result`, `second User
Avatar`), `read table:2`. Also a frameset page (`fs*.html`), a ref used after the page is opened again,
and a download while a second connector process listens on the same Chrome.

Passes: every test runs `--repeat` times (default 3) as full passes; pass 1 is the accuracy pass and all
passes together are the stability pass. Then the cold-start pass stops the bench Chrome before each of
`text_plain`, `form_fields` and `spa_list`, so their first call includes the Chrome launch
(`--no-cold` skips it).

### Runner B (live sites, no LLM)

```sh
$PY runner_b.py                          # all live tasks x3
$PY runner_b.py --only hn_front,books_product --repeat 1
```

Tasks are in `live_tasks.py`: Wikipedia (article, search box), Hacker News, GitHub trending, MDN
search, BBC News, Google Flights (no booking), Amazon search (no cart), YouTube search,
old.reddit.com, books.toscrape.com (product page), catalog.data.gov search, the-internet.herokuapp.com
(dynamic loading, iframe, JS alerts, upload, download) and the Playwright TodoMVC demo. Live pages
change: when a task fails, read its stored output before blaming the connector, and update the task
if the page changed.

### Runner C (the bot, with its LLM)

```sh
$PY runner_c.py --all --repeat 2 --workers 2 --round 4 --baseline 3
$PY runner_c.py --tasks heroku_upload,heroku_download
$PY runner_c.py --all --model claude-sonnet-5-5 --tag=-s55   # one-turn override; the profile is unchanged
$PY runner_c.py --all --reasoning low --tag=-rlow
$PY runner_c.py --all --toolsets browser,clarify,file,memory,session_search,skills,terminal,todo,web --tag=-lean
$PY runner_c.py --all --extra --repeat 2               # the 14 core tasks plus the 8 added in round 8
$PY runner_c.py --all --extra --trouble --long --kahunas --repeat 2   # every group (rounds 19, 25, 28)
```

Groups: `--trouble` the fixture site misbehaving on purpose (round 19), `--long` a 250k-character page and a
vague goal over 4 pages (round 25), `--kahunas` read-only Kahunas tasks (round 28): their truth comes from
`kahunas_truth.py` (the bot's own connector, counts and a page title only, never a client's name), and a task
fails if its chrome history holds a step that could change Kahunas.

Write `--tag=-x` with the equals sign (argparse reads `--tag -x` as an option). With `--extra` the
scorecard also prints the 14 core tasks alone (`core 14`), comparable with the rounds before round 8.

Tasks are in `bot_tasks.py`: they need real interaction (search then open the second result and read
its infobox, wait for late content, unlabelled checkboxes, a dropdown, a JS prompt, upload, download,
a JS to-do app, a GitHub repo's stars and release, pagination, a JS-rendered list, a docs search, a
cookie banner then search, a travel search form), and every one has a checkable answer. Answers that
change (stars, the release) are checked against a live API at the start of the round; a task whose
page changed under it is reported as stale, not scored.

`hermes -z` is not used: it runs a local gateway surface whose tool list leaves plugin tools out, so the
bot cannot see the connector there. Each task is one turn built like a CLI chat (`bot_turn.py`, run by
Hermes's own Python with `HERMES_HOME` set to the profile) from the empty folder `/tmp/hermes-work/run`.
Then the runner reads the turn's session from `~/.hermes/profiles/<profile>/state.db` (read-only) and
records wall time, model calls, tool calls by name (anything other than chrome is listed), chrome calls
and steps per call, chrome output size, FAILED steps, screenshots, tokens (input including cache) and
cost. A task **passes** when the answer matches, the bot made at least one chrome call, and, for tasks
that change something (checkboxes, dropdown, upload, download), the bot's chrome change history
(`chrome/history/<session>.jsonl`) shows the change.

### Other tools

- `probe.py 'go https://example.com' auto`: one chrome call on the bench home, printed in full (to look
  at a page while writing or fixing a test). `--fixtures` starts the fixture server and fills `{base}`.
- `fixture_server.py [port]`: the fixture site on its own, to click through the pages by hand.
- `analyze.py fails|split|overhead|big N` looks inside Runner C round N (the bot's sessions, read-only):
  FAILED steps and other tools with the calls that made them, chrome time against model time, chrome
  calls whose time is outside their steps, the biggest replies; `analyze.py trend 2 16` prints the A, B
  and bot scorecards per round.
- `--connector DIR` (all runners except C, and `probe.py --connector=DIR`): test a copy of
  `chrome_connector.py` and `.js` in DIR instead of the repo's, to try a change before applying it.
  The round file records which copy ran.

## The scorecard

Round 1 of Runner A (the connector as it was on 2026-10-27), plus the `blocked` line of Runner B:

```
accuracy    33/46 = 71.7% passed on run 1 (all 3 runs: 71.7%)
stability   100.0% of tests gave the same result on all 3 runs
time        median 0.606s, p90 1.219s per test (wall); tool-reported median 0.6s
output      median 317.5 chars per test (token proxy); run 1 total 28542 chars
steps       median 3.0 per test
cold start  3/3 passed, first call median 1.14s (includes the Chrome launch), test median 1.14s
blocked     amazon_search, reddit_old: the site walled the browser off on run 1 (not scored)
```

- **accuracy**: tests that passed on run 1, out of the scored tests (blocked ones are left out). This
  is the number the improvement rounds push up. "all runs" is the pass rate over every run.
- **stability**: tests whose result (P, F or B) was the same on every run. Below 100% means a flaky
  test: the connector (or the site) behaves differently from run to run, a reliability problem even
  when the pass rate looks fine. Flaky tests are named.
- **time**: wall time per test (the sum of its chrome calls, measured by the bench), median and 90th
  percentile over every run; "tool-reported" is the time the connector prints in its own header line.
- **output**: characters of everything the connector returned in a test, a stand-in for the tokens the
  model would read. Lower is better at the same accuracy.
- **steps**: steps per test (the scripts are fixed, so this changes only when the bench changes).
- **cold start**: the same tests with Chrome stopped first; the first call includes the launch.
- **over budget**: tests with a time budget (`slow_assets`: the page text is ready long before its slow
  image and script) that took longer than it.
- **blocked** (Runner B): sites that showed a bot check or login wall; not scored.
- **BENCH ERRORS**: an exception in a test's own code. Fix the bench, not the connector.

Below that: one row per test with its result on each run (`PPF` = passed, passed, failed), median time,
median characters and steps, then every failure with its check message and the connector's FAILED lines.
`--baseline N` adds the change against round N: accuracy, stability, times, characters, and which tests
started or stopped passing.

Times depend on what else the Mac is doing. Medians over 3 runs absorb most of it, but check a
surprising slowdown with a second round (or `probe.py` on one page with and without `--connector`)
before acting on it: one round of the fix copy showed 1 to 2 s outliers from machine load that another
round of the same code did not.

## Result files

`round-<N>-direct.json` and `round-<N>-live.json` hold `summary` (the scorecard numbers, per-test
results), `tests` (one record per test run: pass, blocked, detail, wall_s, tool_s, first_call_s,
steps, calls, chars, failures, and for failed runs the full connector outputs, cut at 6000 characters
per call), `cold` (Runner A) and `connector` (hashes of the two connector files and the repo HEAD).
`round-<N>-bot.json` holds one record per prompt and a summary.

Connector bugs the bench finds go to `/tmp/hermes-work/bench/findings.md` (file, function, the failing
test and the smallest suggested change); that list feeds the improvement rounds.

## Adding a test

Runner A: add a page to `fixtures/` (have it POST what happened to `/api/submit/<key>`), then a function
in `runner_a.py`:

```python
@test("my_case", "what it covers", budget=None)
def _(t):
    out = t.call(f"go {t.base}/my.html\nclick Save")       # timed and recorded
    got = t.state.last("my-key")                           # what the page reported
    return C.check(got == {"ok": True}, "what should have happened", got or out[-400:])
```

Runner B: add a `@task(...)` with `prompt=` and `answer=` to `live_tasks.py` and return
`verdict(out, ok, what, got)`, which reports a walled page as blocked.
