#!/usr/bin/env python3
"""Runner A: the Chrome connector against the local fixture site, called directly (no LLM).

Each test sends fixed step scripts through chrome_connector.chrome_tool and checks the outcome
against ground truth: what the fixture server received, the bytes of a downloaded file, values
generated in fixture_server.py. All runs use the bench home (port 9334), never Sean's connector.

    PY=/Users/seanwoodward/.hermes/installs/a054e8eb893639fa/environments/144c13c0849643c59ebdb1c3c7f7f488/venv/bin/python
    $PY runner_a.py                       # every test x3, then the cold-start pass; next round number
    $PY runner_a.py --round 2 --baseline 1
    $PY runner_a.py --only form_fields,spa_list --repeat 1 --no-cold

Results: /tmp/hermes-work/bench/round-<N>-direct.json, scorecard on stdout.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import fixture_server as F  # noqa: E402

TESTS, test = C.registry()
COLD = ("text_plain", "form_fields", "spa_list")


# ---- reading -------------------------------------------------------------------------------------

@test("text_plain", "plain text page")
def _(t):
    out = t.call(f"go {t.base}/plain.html\nread text")
    return C.check("PLAIN-7Q2X" in out and "extension 4471" in out, "read text returns PLAIN-7Q2X and extension 4471", out)


@test("article_long", "long article (about 45k characters)")
def _(t):
    out = t.call(f"go {t.base}/article.html\nread text")
    full = C.with_saved(out)
    ok = F.ARTICLE_SECRET in full and F.ARTICLE_END in full and len(out) < 8000
    return C.check(ok, f"{F.ARTICLE_SECRET} and {F.ARTICLE_END} reachable (inline or in the saved file), reply under 8000 chars",
                   f"{len(out)} chars: {out[:300]}")


@test("table_rule", "data table: find a value by a rule")
def _(t):
    out = t.call(f"go {t.base}/table.html\nread table")
    tables = C.read_tables(out)
    rows = tables[0] if tables else []
    best = None
    for r in rows[1:]:
        if len(r) >= 5 and r[2] == "West" and r[4] == "Shipped":
            amount = float(r[3].replace("$", "").replace(",", ""))
            if best is None or amount > best[0]:
                best = (amount, r[0], r[1])
    truth = F.orders_truth()
    want = (truth["amount"], truth["id"], truth["customer"])
    return C.check(len(rows) == 61 and best == want,
                   f"61 rows (header + 60) and the top Shipped West order {want[1]} {want[2]} {want[0]}",
                   f"{len(rows)} rows, best {best}")


@test("table_pick", "data table: the second table on the page, named by its caption")
def _(t):
    out = t.call(f"go {t.base}/table.html\nread table:Totals by region")
    tables = C.read_tables(out)
    rows = tables[0] if tables else []
    want = f"${F.REGION_TOTALS['West']:,.2f}"
    west = [r for r in rows if r and r[0] == "West"]
    return C.check(len(rows) == 5 and west and west[0][-1] == want, f"the 5-row totals table with West = {want}",
                   f"{len(rows)} rows, first {rows[:2]}")


# ---- forms -----------------------------------------------------------------------------------------

FORM_STEPS = ("fill Full name = Ada Lovelace ; Email = ada@example.com ; Age = 36 ; Start date = 2026-11-02 ; "
              "Notes = Line one, line two ; Plan = Yearly ; Newsletter = on ; Phone = on ; "
              "I accept the terms = on ; Marketing emails = on")
FORM_WANT = {"name": "Ada Lovelace", "email": "ada@example.com", "age": "36", "start": "2026-11-02",
             "notes": "Line one, line two", "plan": "y", "interests": ["news"], "contact": "phone",
             "terms": True, "marketing": True}


@test("form_fields", "form: text, email, number, date, textarea, select, checkboxes, radio, label-styled checkboxes")
def _(t):
    out = t.call(f"go {t.base}/form.html\n{FORM_STEPS}\nclick Save profile")
    got = t.state.last("form")
    diff = C.dict_diff(FORM_WANT, got)
    return C.check(got is not None and not diff, "the server got every field as filled", diff or out[-400:])


@test("form_radio_group", "form: a radio chosen by its group label (fill Contact by = Phone)")
def _(t):
    out = t.call(f"go {t.base}/form.html\nfill Contact by = Phone\nclick Save profile")
    got = t.state.last("form")
    return C.check(isinstance(got, dict) and got.get("contact") == "phone", "contact = phone on the server",
                   f"contact {got.get('contact') if isinstance(got, dict) else None!r}; {out[-300:]}")


@test("history_verify", "chrome_history verify=true after filling the form")
def _(t):
    t.call(f"go {t.base}/form.html\n{FORM_STEPS}")
    out = t.history(verify=True)
    holds = len(re.findall(r"\(holds\)", out))
    bad = re.findall(r"#\d+ e\d+: (?:now .*\(CHANGED since\)|no longer on the page)", out)
    return C.check(holds == 10 and not bad, "verify lists all 10 changed fields as holding", out[-700:])


@test("controlled_inputs", "React-like controlled input and a framework that listens to change only")
def _(t):
    out = t.call(f"go {t.base}/controlled.html\ntype Nickname = Ada\ntype City = Lisbon\nclick Save settings")
    got = t.state.last("controlled")
    return C.check(isinstance(got, dict) and got.get("nickname") == "Ada" and got.get("city") == "Lisbon",
                   "nickname Ada and city Lisbon in the page state the server got", got or out[-400:])


@test("combobox_wait", "search-as-you-type combobox, suggestions after 550 ms (script waits for them)")
def _(t):
    out = t.call(f"go {t.base}/combobox.html\ntype Country = Portu\nwait css=[role=option]\nclick option:Portugal\nclick Save shipping")
    got = t.state.last("combobox")
    return C.check(isinstance(got, dict) and got.get("country") == "PT", "country PT saved", got or out[-400:])


@test("combobox_nowait", "search-as-you-type combobox, no wait step (typing must let suggestions arrive)")
def _(t):
    out = t.call(f"go {t.base}/combobox.html\ntype Country = Portu\nclick option:Portugal\nclick Save shipping")
    got = t.state.last("combobox")
    return C.check(isinstance(got, dict) and got.get("country") == "PT", "country PT saved", got or out[-400:])


@test("wait_role_target", "wait for a role:name target (wait option:Portugal) like every other step accepts")
def _(t):
    out = t.call([f"go {t.base}/combobox.html", "type Country = Portu", {"wait": "option:Portugal", "timeout": 4},
                  "click option:Portugal", "click Save shipping"])
    got = t.state.last("combobox")
    return C.check(isinstance(got, dict) and got.get("country") == "PT", "the wait found the option; country PT saved",
                   got or out[-400:])


@test("custom_select_clicks", "custom ARIA dropdown (button + listbox) by two clicks")
def _(t):
    out = t.call(f"go {t.base}/combobox.html\nclick Size\nclick option:Large\nclick Save shipping")
    got = t.state.last("combobox")
    return C.check(isinstance(got, dict) and got.get("size") == "L", "size L saved", got or out[-400:])


@test("custom_select_via_select", "custom ARIA dropdown with the select step (select Size = Large)")
def _(t):
    out = t.call(f"go {t.base}/combobox.html\nselect Size = Large\nclick Save shipping")
    got = t.state.last("combobox")
    return C.check(isinstance(got, dict) and got.get("size") == "L", "size L saved", got or out[-400:])


# ---- single-page apps ------------------------------------------------------------------------------

def _spa_names(out: str) -> list[str]:
    blocks = C.read_items(out, "css=.item")
    return [re.sub(r" - \$.*$", "", x) for x in blocks[-1]] if blocks else []


@test("spa_list", "SPA list fetched 300-900 ms after load (script waits for it)")
def _(t):
    out = t.call(f"go {t.base}/spa.html\nwait css=.item\nread css=.item")
    names = _spa_names(out)
    return C.check(names == [f"Item {n}" for n in range(1, 11)], "Items 1 to 10", names or out[-400:])


@test("spa_nowait", "SPA list read right after go (settle must catch a fetch that starts 900 ms after load)")
def _(t):
    out = t.call(f"go {t.base}/spa.html?delay=900\nread css=.item")
    names = _spa_names(out)
    return C.check(names == [f"Item {n}" for n in range(1, 11)], "Items 1 to 10", names or out[-400:])


@test("spa_paginate", "SPA pagination: Next twice (fetch + pushState)")
def _(t):
    out = t.call(f"go {t.base}/spa.html\nwait css=.item\nclick Next\nclick Next\nread css=.item")
    names = _spa_names(out)
    return C.check(names == [f"Item {n}" for n in range(21, 31)], "Items 21 to 30 (page 3)", names or out[-400:])


@test("spa_read_api", "read api: the JSON the page loaded")
def _(t):
    out = t.call(f"go {t.base}/spa.html\nwait css=.item\nread api\nread api:/api/items")
    ok = re.search(r"GET \S*/api/items\?page=1 -> 200", out) and '"Item 10"' in out
    return C.check(ok, "read api lists /api/items?page=1 and read api:/api/items returns its JSON", out[-500:])


# ---- dialogs, overlays, tabs, frames, shadow DOM ----------------------------------------------------

@test("dialog_confirm_accept", "confirm() accepted (default policy)")
def _(t):
    out = t.call(f"go {t.base}/dialogs.html\nclick Delete item")
    got = t.state.last("dialogs")
    ok = isinstance(got, dict) and got.get("confirm") == "deleted" and re.search(r"dialog: confirm .*accepted", out)
    return C.check(ok, "confirm accepted (item deleted) and the reply names the dialog", got or out[-400:])


@test("dialog_confirm_dismiss", "confirm() dismissed with dialog dismiss")
def _(t):
    out = t.call(f"go {t.base}/dialogs.html\ndialog dismiss\nclick Delete item")
    got = t.state.last("dialogs")
    ok = isinstance(got, dict) and got.get("confirm") == "kept" and re.search(r"dialog: confirm .*dismissed", out)
    return C.check(ok, "confirm dismissed (item kept) and the reply names the dialog", got or out[-400:])


@test("dialog_alert", "alert()")
def _(t):
    out = t.call(f"go {t.base}/dialogs.html\nclick Show alert")
    got = t.state.last("dialogs")
    ok = isinstance(got, dict) and got.get("alert") == "closed" and re.search(r"dialog: alert ", out)
    return C.check(ok, "alert closed and reported", got or out[-400:])


@test("dialog_prompt", "prompt() answered with dialog accept = text")
def _(t):
    out = t.call(f"go {t.base}/dialogs.html\ndialog accept = Bench name\nclick Rename")
    got = t.state.last("dialogs")
    return C.check(isinstance(got, dict) and got.get("prompt") == "Bench name", "prompt answered Bench name", got or out[-400:])


@test("overlay_covered_click", "button covered by a cookie banner")
def _(t):
    out = t.call(f"go {t.base}/overlay.html\nclick Subscribe")
    subs = [x for x in t.state.get("overlay") if isinstance(x, dict) and x.get("subscribed")]
    trusted = subs[-1].get("trusted") if subs else None
    return C.check(bool(subs), f"the Subscribe handler ran (trusted click: {trusted})", out[-400:])


@test("overlay_accept_then_click", "accept the cookie banner, then a real (trusted) click")
def _(t):
    out = t.call(f"go {t.base}/overlay.html\nclick Accept all\nclick Subscribe")
    subs = [x for x in t.state.get("overlay") if isinstance(x, dict) and x.get("subscribed")]
    return C.check(subs and subs[-1].get("trusted") is True, "Subscribe ran from a trusted click", subs or out[-400:])


@test("modal_form", "modal dialog over the page: type into its field and save")
def _(t):
    out = t.call(f"go {t.base}/overlay.html\nclick Accept all\nclick Edit profile\ntype Display name = Grace H.\nclick Save changes")
    saves = [x for x in t.state.get("overlay") if isinstance(x, dict) and "display" in x]
    ok = saves and saves[-1].get("display") == "Grace H." and saves[-1].get("main") == "Original Name"
    return C.check(ok, "the modal field saved Grace H. and the page field behind it kept Original Name", saves or out[-400:])


def _newtab(t, opener: str) -> tuple[bool, str]:
    out = t.call(f"go {t.base}/newtab.html\nclick {opener}\nread css=#marker\ntab close\nread css=h1")
    items = C.read_items(out, "css=")
    ok = "opened a new tab" in out and items == [["REPORT-3141"], ["Links"]]
    return C.check(ok, "the new tab adopted (REPORT-3141 read there), closed, back on Links", items or out[-500:])


@test("newtab_link", "target=_blank link opens a new tab the connector adopts")
def _(t):
    return _newtab(t, "Open report")


@test("newtab_script", "window.open from a button opens a new tab")
def _(t):
    return _newtab(t, "Open popup")


@test("iframe_same_origin", "same-origin iframe: type and click inside it")
def _(t):
    out = t.call(f"go {t.base}/iframe.html\ntype Frame email = frame@example.com\nclick Join list")
    got = t.state.last("iframe")
    return C.check(isinstance(got, dict) and got.get("email") == "frame@example.com", "the frame submitted frame@example.com",
                   got or out[-400:])


@test("iframe_cross_origin", "cross-origin iframe (localhost inside 127.0.0.1): type and click inside it")
def _(t):
    out = t.call(f"go {t.base}/iframe.html\ntype Partner code = XO-42\nclick Apply code")
    got = t.state.last("cross")
    return C.check(isinstance(got, dict) and got.get("code") == "XO-42", "the cross-origin frame submitted XO-42",
                   got or out[-400:])


@test("shadow_click", "button inside nested open shadow roots, clicked twice")
def _(t):
    out = t.call(f"go {t.base}/shadow.html\nclick Shadow add\nclick Shadow add")
    adds = [x for x in t.state.get("shadow") if isinstance(x, dict) and x.get("what") == "add"]
    trusted = [x.get("trusted") for x in adds]
    return C.check(len(adds) == 2, f"two adds reached the component (trusted: {trusted})", out[-400:])


@test("shadow_pointerdown", "shadow-root menu button that opens on pointerdown")
def _(t):
    out = t.call(f"go {t.base}/shadow.html\nclick Shadow menu")
    menus = [x for x in t.state.get("shadow") if isinstance(x, dict) and x.get("what") == "menu"]
    return C.check(bool(menus), "the menu opened (pointerdown reached it)", out[-400:])


@test("shadow_type", "type into a shadow-root field and save")
def _(t):
    out = t.call(f"go {t.base}/shadow.html\ntype Shadow note = hello shadow\nclick Save note")
    notes = [x for x in t.state.get("shadow") if isinstance(x, dict) and x.get("what") == "note"]
    return C.check(notes and notes[-1].get("note") == "hello shadow", "the note saved as hello shadow", notes or out[-400:])


# ---- files -------------------------------------------------------------------------------------------

def _upload(t, target: str, name: str, key: str) -> tuple[bool, str]:
    path = t.files[name]
    out = t.call(f"go {t.base}/upload.html\nupload {target} = {path}")
    got = t.state.last(key)
    data = F.UPLOAD_FILES[name]
    ok = isinstance(got, dict) and got.get("name") == name and got.get("size") == len(data) and got.get("sha256") == F.sha256(data)
    return C.check(ok, f"the server got {name} ({len(data)} bytes, same sha256)", got or out[-400:])


@test("upload_input", "file input with a label")
def _(t):
    return _upload(t, "Attachment", "upload-a.txt", "input")


@test("upload_button", "Choose file button that opens the picker from script (hidden input)")
def _(t):
    return _upload(t, "Choose file", "upload-b.bin", "button")


def _download(t, spec: str, want: bytes, name: str) -> tuple[bool, str]:
    out = t.call(f"go {t.base}/download.html\ndownload {spec}")
    path, data = C.downloaded(out)
    ok = data == want and path is not None and path.name.startswith(name)
    return C.check(ok, f"{name}* saved with the server's {len(want)} bytes",
                   f"{path} {len(data) if data is not None else None} bytes; {out[-300:]}")


@test("download_link", "download link served as an attachment")
def _(t):
    return _download(t, "Download report", F.REPORT_CSV, "region-report")


@test("download_url", "download by URL")
def _(t):
    return _download(t, f"{t.base}/download/data.bin", F.DATA_BIN, "bench-data")


@test("download_blob", "download of a blob the page builds (Export CSV button)")
def _(t):
    return _download(t, "Export CSV", F.EXPORT_CSV, "export")


# ---- scrolling, sign-in, stale refs, speed ------------------------------------------------------------

@test("infinite_scroll", "infinite scroll: six scroll-to-bottom steps, then find item 95")
def _(t):
    out = t.call(f"go {t.base}/infinite.html\nwait css=.feed-item\n" + "scroll bottom\n" * 6 + "read css=.feed-item")
    blocks = C.read_items(out, "css=.feed-item")
    items = blocks[-1] if blocks else []
    want = F.feed_title(95)
    return C.check(want in items, f"{want} among the items (needs 5 loads of 20)",
                   f"{len(items)} items, last {items[-1] if items else None}")


@test("login_detect", "sign-in page: flagged in the map, password never echoed, typing a password refused")
def _(t):
    out1 = t.call(f"go {t.base}/login.html", map="auto")
    out2 = t.call("read form")
    out3 = t.call("type Password = hunter2")
    secret = "fixture-not-a-secret"
    ok = ("Sign-in form on this page" in out1 and secret not in out1 + out2 + out3 and "(hidden)" in out2
          and "never type passwords" in out3)
    return C.check(ok, "sign-in form flagged, password shown as (hidden), typing into it refused",
                   f"{out1[-300:]} || {out2[-200:]} || {out3[-200:]}")


@test("login_two_step", "two-step sign-in: the password field appears after Next")
def _(t):
    out1 = t.call(f"go {t.base}/login2.html", map="auto")
    out2 = t.call("type Email address = someone@example.com\nclick Next", map="auto")
    ok = "Sign-in form on this page" not in out1 and ("A sign-in form appeared" in out2 or "Sign-in form on this page" in out2)
    return C.check(ok, "no sign-in flag on step 1, flagged after Next", out2[-400:])


@test("stale_refs", "controls re-rendered with new nodes and ids: click a ref from an earlier map")
def _(t):
    out1 = t.call(f"go {t.base}/stale.html", map="auto")
    ref = C.find_ref(out1, "button", "Add one")
    if not ref:
        return C.check(False, "a ref for Add one in the first map", out1[-400:])
    time.sleep(1.3)  # the board re-renders on its own meanwhile, like a model thinking between calls
    out2 = t.call(f"click {ref}")
    t.call("click Add one")
    got = t.state.last("stale")
    return C.check(isinstance(got, dict) and got.get("count") == 2,
                   f"count 2 after clicking the old ref {ref}, then Add one by text", f"{got}; {out2[-250:]}")


@test("slow_assets", "image and async script that take 2.5 s: text readable before they finish", budget=1.5)
def _(t):
    out = t.call(f"go {t.base}/slow.html\nread css=#marker")
    items = C.read_items(out, "css=#marker")
    return C.check(items == [["SLOW-PAGE-READY"]], "SLOW-PAGE-READY read", out[-300:])


# ---- tabs, navigation, bulk -----------------------------------------------------------------------------

@test("each_parallel", "each: read three pages in parallel tabs")
def _(t):
    urls = [f"{t.base}/page/{n}.html" for n in (1, 2, 3)]
    out = t.call([{"each": urls, "do": "read css=h1"}])
    items = sorted(x for b in C.read_items(out, "css=h1") for x in b)
    want = ["Page 1: alpha", "Page 2: bravo", "Page 3: charlie"]
    return C.check(items == want, "the three page titles", items or out[-400:])


@test("tabs_basic", "tab new / tab 1 / tab list")
def _(t):
    out = t.call(f"go {t.base}/page/1.html\ntab new {t.base}/page/2.html\nread css=h1\ntab 1\nread css=h1\ntab list")
    items = C.read_items(out, "css=h1")
    ok = items == [["Page 2: bravo"], ["Page 1: alpha"]] and re.search(r"tabs: #1 \(active\) \S*page/1\.html; #2 \S*page/2\.html", out)
    return C.check(ok, "page 2 in the new tab, page 1 after tab 1, tab list with two tabs", items or out[-400:])


@test("nav_history", "back, forward, reload")
def _(t):
    out = t.call(f"go {t.base}/page/1.html\ngo {t.base}/page/2.html\nback\nread css=h1\nforward\nread css=h1\nreload\nread css=h1")
    items = C.read_items(out, "css=h1")
    want = [["Page 1: alpha"], ["Page 2: bravo"], ["Page 2: bravo"]]
    return C.check(items == want, "page 1 after back, page 2 after forward and reload", items or out[-400:])


@test("url_bare_localhost", "go with a bare address: localhost:<port>/plain.html")
def _(t):
    out = t.call(f"go localhost:{t.port}/plain.html\nread text")
    return C.check("PLAIN-7Q2X" in out, "the plain page opened over http", out[-300:])


@test("hover_menu", "submenu that shows only on hover")
def _(t):
    out = t.call(f"go {t.base}/menu.html\nhover Products\nclick Laptops")
    got = t.state.last("menu")
    return C.check(isinstance(got, dict) and got.get("picked") == "Laptops", "Laptops picked", got or out[-400:])


# ---- main ------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Runner A: the Chrome connector against local fixtures (no LLM).")
    C.add_args(ap)
    ap.add_argument("--no-cold", action="store_true", help="skip the cold-start pass")
    args = ap.parse_args(argv)
    tests = C.select(TESTS, args.only, args.skip)
    if args.list:
        for t in TESTS:
            print(f"{t.name:<28}{t.scenario}")
        return 0
    cc = C.load_connector(args.connector)
    C.clean_bench_dirs()
    fx = F.start()
    files = F.write_upload_files(C.FILES_DIR)
    env = {"base": fx.base, "alt": fx.alt, "port": fx.port, "state": fx.state,
           "files": {k: str(v) for k, v in files.items()}}
    n = args.round or C.next_round("direct")
    started = C.now()
    print(f"Runner A round {n}: {len(tests)} tests x {args.repeat} runs, fixtures {fx.base}, "
          f"bench Chrome port {C.BENCH_PORT}, home {C.BENCH_HOME}", flush=True)
    records = C.run_suite(cc, tests, env, args.repeat, "a", reset=fx.state.reset)
    cold = [] if args.no_cold else C.run_cold(cc, [t for t in tests if t.name in COLD], env, "a", reset=fx.state.reset)
    data = C.payload("direct", n, started, records, cold, fixtures=fx.base, repeat=args.repeat)
    path = C.write_round("direct", n, data)
    C.print_scorecard("Runner A (direct, fixtures)", data)
    if args.baseline:
        C.print_compare(data, args.baseline, "direct")
    if args.stop:
        print(C.stop_bench_chrome(cc))
    print(f"results: {path}")
    fx.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
