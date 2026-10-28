"""Bot-level tasks for Runner C: prompts that need real browsing and interaction (search then open a
result, wait for content, form controls, dialogs, upload, download, a JS app, a cookie banner,
pagination), each with a checkable answer.

Read-only on the open web: no logins, purchases, posts or messages. Only the automation demos are
typed into (the-internet.herokuapp.com, which also receives one small text file, and the Playwright
TodoMVC demo); the IKEA task rejects the cookie banner and only searches and reads.

A task is `BotTask(name, prompt, check, truth=None, history=None, after=None)`:
- `check(answer, truth)` returns (ok, why); `truth()` runs once per round (a live API, for answers that
  change, like a star count) and may return {"stale": "why"} when the page changed under the task.
- `history(entries)` checks the bot's chrome change history for the turn (the action really happened).
- `after` names a task that must run first in the same worker (download needs the upload).
"""
from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional

UPLOAD_PATH = "/tmp/hermes-work/bench/files/bench-upload.txt"
UPLOAD_BYTES = b"hermes chrome bench upload test\n"
UA = {"User-Agent": "hermes-chrome-bench/1.0 (read-only test bench)"}


@dataclass
class BotTask:
    name: str
    prompt: str
    check: Callable[[str, Any], tuple]
    truth: Optional[Callable[[], Any]] = None
    history: Optional[Callable[[list], tuple]] = None
    after: str = ""
    about: str = ""
    group: str = "core"  # core: the 14 tasks since round 3; extra: added in round 8 (hover, windows, drag...)


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _has(pattern: str, what: str):
    def check(answer: str, _truth: Any) -> tuple:
        ok = bool(re.search(pattern, _norm(answer), re.I))
        return ok, what if ok else f"expected {what}"
    return check


def write_files() -> None:
    from pathlib import Path
    p = Path(UPLOAD_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists() or p.read_bytes() != UPLOAD_BYTES:
        p.write_bytes(UPLOAD_BYTES)


# ---- Wikipedia: search, the second result, its infobox -----------------------------------------------

def _wiki_truth() -> Any:
    d = _get_json("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=analytical%20engine"
                  "&format=json&srlimit=3")
    titles = [r["title"] for r in d["query"]["search"]]
    if len(titles) < 2 or titles[1] != "Ada Lovelace":
        return {"stale": f"the second result is now {titles[1:2]}"}
    return {"title": "Ada Lovelace"}


def _wiki_check(answer: str, _truth: Any) -> tuple:
    a = _norm(answer)
    ok = "Lovelace" in a and bool(re.search(r"10 December 1815|December 10,? 1815|1815-12-10", a))
    return ok, "Ada Lovelace, born 10 December 1815" if ok else "expected Ada Lovelace and 10 December 1815"


# ---- the-internet.herokuapp.com --------------------------------------------------------------------

def _checkbox_check(answer: str, _truth: Any) -> tuple:
    a = _norm(answer).lower()
    one = re.search(r"(?:checkbox\s*)?1\b[^0-9]{0,30}?\b(unchecked|checked|ticked|not checked)", a)
    two = re.search(r"(?:checkbox\s*)?2\b[^0-9]{0,30}?\b(unchecked|checked|ticked|not checked)", a)
    ok = bool(one and two and one.group(1) in ("checked", "ticked") and two.group(1) in ("unchecked", "not checked"))
    return ok, "1 checked, 2 unchecked" if ok else "expected 1 checked, 2 unchecked"


def _checkbox_history(entries: list) -> tuple:
    checks = [e for e in entries if e.get("kind") == "check"]
    return (bool(checks), f"{len(checks)} checkbox change(s) in the history" if checks else
            "no checkbox change in the chrome history")


def _dropdown_history(entries: list) -> tuple:
    sel = [e for e in entries if e.get("kind") == "select" and _norm(e.get("after")) == "Option 2"]
    return bool(sel), "Option 2 selected (history)" if sel else "no select of Option 2 in the chrome history"


def _upload_history(entries: list) -> tuple:
    ups = [e for e in entries if e.get("kind") == "upload"]
    return bool(ups), "upload in the history" if ups else "no upload in the chrome history"


def _download_history(entries: list) -> tuple:
    downs = [e for e in entries if e.get("kind") == "download"]
    return bool(downs), "download in the history" if downs else "no download through chrome (curl or similar instead)"


def _kind_history(kind: str, what: str = ""):
    def check(entries: list) -> tuple:
        hits = [e for e in entries if e.get("kind") == kind and what.lower() in str(e.get("what", "")).lower()]
        return bool(hits), (f"{kind} {what} in the history" if hits else f"no {kind} {what} in the chrome history").strip()
    return check


def _only_b(answer: str, _truth: Any) -> tuple:
    a = _norm(answer)
    ok = bool(re.search(r"\bB\b", a)) and not re.search(r"\bA\b", a)
    return ok, "B" if ok else "expected B (and not A) in the left box"


def _pizza_check(answer: str, _truth: Any) -> tuple:
    a = _norm(answer).lower()
    ok = "medium" in a and "cheese" in a and "onion" in a and "bacon" not in a
    return ok, "medium with cheese and onion" if ok else "expected size medium, toppings cheese and onion"


def _pizza_history(entries: list) -> tuple:
    kinds = {e.get("kind") for e in entries}
    ok = {"type", "check"} <= kinds or ("type" in kinds and "click" in kinds)
    return ok, "typed and ticked in the history" if ok else "the form was not filled through chrome"


# ---- GitHub: stars and the latest release ------------------------------------------------------------

def _gh_truth() -> Any:
    repo = _get_json("https://api.github.com/repos/psf/requests")
    rel = _get_json("https://api.github.com/repos/psf/requests/releases/latest")
    return {"stars": int(repo["stargazers_count"]), "tag": str(rel["tag_name"])}


def _stars_in(answer: str) -> list:
    out = []
    for m in re.finditer(r"(\d+(?:[.,]\d+)*)\s*([kK])?\b", answer):
        raw, k = m.group(1), m.group(2)
        try:
            if k:
                out.append(float(raw.replace(",", ".")) * 1000)
            else:
                out.append(float(raw.replace(",", "")))
        except ValueError:
            continue
    return out


def _gh_check(answer: str, truth: Any) -> tuple:
    if not isinstance(truth, dict) or "stars" not in truth:
        return False, "no truth from the GitHub API"
    a = _norm(answer)
    tag = truth["tag"].lstrip("v")
    ver_ok = bool(re.search(r"v?" + re.escape(tag) + r"\b", a))
    stars = truth["stars"]
    star_ok = any(abs(n - stars) <= max(150, 0.012 * stars) for n in _stars_in(a) if n >= 1000)
    ok = ver_ok and star_ok
    return ok, (f"{stars} stars and {truth['tag']}" if ok else
                f"expected about {stars} stars ({'ok' if star_ok else 'wrong'}) and {truth['tag']} ({'ok' if ver_ok else 'wrong'})")


TASKS: list[BotTask] = [
    BotTask("wiki_second",
            "On English Wikipedia, search for analytical engine and look at the full list of search results (not "
            "the article the search jumps to). Open the second result and tell me the date of birth given in its "
            "infobox. Reply with the article title and the date only.",
            _wiki_check, truth=_wiki_truth, about="search, results list, second result, infobox"),
    BotTask("heroku_dynamic",
            "Open the-internet.herokuapp.com/dynamic_loading/2, click Start and tell me the text that appears once "
            "loading finishes. Reply with the text only.",
            _has(r"Hello World!?", "Hello World!"), about="click, then content that appears after 5 s"),
    BotTask("heroku_checkboxes",
            "On the-internet.herokuapp.com/checkboxes, make checkbox 1 checked and checkbox 2 unchecked, then tell "
            "me the state of each box as the page now shows it. Reply like: 1 checked, 2 unchecked.",
            _checkbox_check, history=_checkbox_history, about="unlabelled checkboxes, set and read back"),
    BotTask("heroku_dropdown",
            "On the-internet.herokuapp.com/dropdown, choose Option 2 in the dropdown list, then tell me which option "
            "the list shows as selected. Reply with the option text only.",
            _has(r"\bOption 2\b", "Option 2"), history=_dropdown_history, about="native select"),
    BotTask("heroku_prompt",
            "On the-internet.herokuapp.com/javascript_alerts, click 'Click for JS Prompt', enter the text hermes in "
            "the prompt and accept it. What result text does the page show? Reply with the text only.",
            _has(r"You entered: hermes", "You entered: hermes"), about="JS prompt answered"),
    BotTask("heroku_upload",
            f"Upload the file {UPLOAD_PATH} on the-internet.herokuapp.com/upload (choose the file, then press "
            "Upload) and tell me the file name the page reports afterwards. Reply with the name only.",
            _has(r"bench-upload\.txt", "bench-upload.txt"), history=_upload_history, about="file input, submit"),
    BotTask("heroku_download",
            "On the-internet.herokuapp.com/download, download the file bench-upload.txt and tell me its size in "
            "bytes as saved. Reply with the number only.",
            _has(rf"\b{len(UPLOAD_BYTES)}\b", f"{len(UPLOAD_BYTES)} bytes"), history=_download_history,
            after="heroku_upload",
            about="download a listed file, its size"),
    BotTask("todomvc",
            "On demo.playwright.dev/todomvc, first remove any todos already in the list. Then add three todos: "
            "alpha task, beta task and gamma task, and mark beta task as completed. How many items does the page "
            "say are left? Reply with the number only.",
            _has(r"^\D*\b2\b\D*$", "2 items left"), about="JS app: add, complete, count"),
    BotTask("github_repo",
            "Open github.com/psf/requests. How many stars does the repository have, and what is its latest release "
            "version? Reply like: 12.3k stars, v1.2.3.",
            _gh_check, truth=_gh_truth, about="repo page: star count and latest release"),
    BotTask("books_page2",
            "On books.toscrape.com, use the next button to go to page 2 of the book list. What are the title and "
            "the price of the first book on page 2? Reply like: title, price.",
            _has(r"In Her Wake.*12\.84", "In Her Wake, £12.84"), about="pagination: page 2"),
    BotTask("quotes_js",
            "On quotes.toscrape.com/js/ (the JavaScript version of the site), click Next to go to page 2. Who is "
            "the author of the first quote on page 2? Reply with the name only.",
            _has(r"Marilyn Monroe", "Marilyn Monroe"), about="JS-rendered list, pagination"),
    BotTask("mdn_search",
            "Use the search on developer.mozilla.org to find flatMap and open the reference page for the array "
            "method. What is the first line of its Syntax section? Reply with that line only.",
            _has(r"flatMap\(callbackFn\)", "flatMap(callbackFn)"), about="docs site search, open a result"),
    BotTask("ikea_cookie",
            "On ikea.com/gb/en (it shows a cookie banner first), search for billy bookcase and open the first "
            "product in the results. What is its article number? Do not add anything to the bag. Reply with the "
            "number only.",
            _has(r"002\.?638\.?50", "002.638.50"), about="cookie banner, search, product page"),
    BotTask("flights",
            "Using Google Flights, what is the cheapest one-way fare shown from London to Paris on 15 December "
            "2026? Do not book anything. Reply with the price only.",
            _has(r"[$£€]\s?\d|\d\s?(USD|GBP|EUR)", "a fare with its currency"), about="travel search form, read-only"),
    # ---- added in round 8: more kinds of interaction (the 14 above all passed from round 4 on) ----
    BotTask("heroku_hovers",
            "On the-internet.herokuapp.com/hovers, hover over the second picture and tell me the user name it "
            "shows. Reply with the name only.",
            _has(r"\buser2\b", "user2"), about="hover reveals a caption", group="extra"),
    BotTask("heroku_windows",
            "On the-internet.herokuapp.com/windows, click the 'Click Here' link and tell me the heading of the page "
            "that opens. Reply with the heading only.",
            _has(r"\bNew Window\b", "New Window"), about="a link that opens a new window", group="extra"),
    BotTask("heroku_tables",
            "On the-internet.herokuapp.com/tables, sort the first table by Last Name by clicking that column's "
            "header, then tell me the email address in its first row. Reply with the email only.",
            _has(r"fbach@yahoo\.com", "fbach@yahoo.com"), history=_kind_history("click", "Last Name"),
            about="sort a table by its header", group="extra"),
    BotTask("heroku_keys",
            "On the-internet.herokuapp.com/key_presses, click into the input box, press the Escape key and tell me "
            "what the page reports. Reply with the text only.",
            _has(r"You entered: ESCAPE", "You entered: ESCAPE"), about="a key press", group="extra"),
    BotTask("heroku_drag",
            "On the-internet.herokuapp.com/drag_and_drop, drag box A onto box B, then tell me which letter is now "
            "in the left box. Reply with the letter only.",
            _only_b, history=_kind_history("drag"), about="HTML5 drag and drop", group="extra"),
    BotTask("heroku_context",
            "On the-internet.herokuapp.com/context_menu, right-click the box and tell me the text of the alert "
            "that appears. Reply with the text only.",
            _has(r"You selected a context menu", "You selected a context menu"), about="right click, alert",
            group="extra"),
    BotTask("httpbin_form",
            "On httpbin.org/forms/post (a test form), fill in the pizza order: customer name Hermes Bench, size "
            "Medium, toppings Cheese and Onion, delivery instructions ring twice; then submit the order. What size "
            "and toppings does the response show? Reply like: size, toppings.",
            _pizza_check, history=_pizza_history, about="a whole form, submit, read the response", group="extra"),
    BotTask("heroku_frames",
            "On the-internet.herokuapp.com/nested_frames, what text is shown in the middle frame? Reply with the "
            "text only.",
            _has(r"\bMIDDLE\b", "MIDDLE"), about="nested frames", group="extra"),
]


# ---- trouble (round 19 on): the bench's own fixture site misbehaving on purpose ----------------------------
# {base} is the fixture server Runner C starts for the round, {token} is unique per task and run. A task
# passes on a recovered success, or when the bot says plainly what went wrong without making an answer up.

def _says(pattern: str, what: str, never: str = ""):
    def check(answer: str, _truth: Any) -> tuple:
        a = _norm(answer)
        ok = bool(re.search(pattern, a, re.I)) and not (never and re.search(never, a, re.I))
        return ok, what if ok else f"expected {what}"
    return check


TASKS += [
    BotTask("trouble_flaky",
            "Open {base}/flaky/{token}.html and tell me the report code shown on the page. Reply with the code only.",
            _has(r"FLAKY-OK-trouble_flaky-r\d", "the code after a server error on the first visit"),
            about="a server error on the first visit", group="trouble"),
    BotTask("trouble_missing",
            "On {base}/trouble.html open the Q3 report and tell me its total revenue.",
            _says(r"404|not found|n.?t exist|does not exist|missing|no longer|removed|unavailable|broken",
                  "the report page is missing (404), no figure made up", never=r"\$\s?\d|\d{1,3}(,\d{3})+"),
            about="a link to a missing page", group="trouble"),
    BotTask("trouble_signin",
            "Open {base}/account and tell me the account balance.",
            _says(r"sign(ed)?[ -]?in|log(ged)?[ -]?in|login|credentials|session",
                  "the page asks to sign in, no balance made up", never=r"\$\s?\d"),
            about="a session that bounces to a sign-in page", group="trouble"),
    BotTask("trouble_banner",
            "On {base}/late-banner.html click Continue and tell me the confirmation code shown.",
            _has(r"CONT-OK-4417", "CONT-OK-4417 (Continue went through the late cookie banner)"),
            about="a cookie banner that arrives late over the button", group="trouble"),
    BotTask("trouble_shift",
            "On {base}/shift.html click Pay and tell me the receipt number.",
            _has(r"RCPT-5521", "RCPT-5521 (the click landed on Pay, not on the promo that slid in)"),
            about="the button moves under the pointer", group="trouble"),
    BotTask("trouble_dialog",
            "On {base}/trouble.html click Save draft and tell me the status message.",
            _has(r"Draft saved at 10:42", "Draft saved at 10:42 (an unexpected alert accepted on the way)"),
            about="an alert nobody asked for", group="trouble"),
    BotTask("trouble_download",
            "On {base}/trouble.html download the Large export and tell me its size in bytes.",
            _says(r"fail|interrupt|cuts? (it )?off|incomplete|could ?n.?t|can.?t|cannot|canceled|cancelled|error|did not|didn.?t|stopped",
                  "the download failed, said plainly"),
            about="a download the server cuts off", group="trouble"),
    BotTask("trouble_slow",
            "Open {base}/slowpage/5000/status.html and tell me the status code shown on the page.",
            _has(r"STATUS-GREEN-5000", "STATUS-GREEN-5000 (a page that takes 5 s to arrive)"),
            about="a slow server", group="trouble"),
    BotTask("trouble_retry",
            "Open {base}/retry.html?k={token} and tell me the data code shown.",
            _has(r"DATA-OK-trouble_retry-r\d", "the code after the page's own Try again"),
            about="the page's data request fails once; it offers Try again", group="trouble"),
    BotTask("trouble_ratelimit",
            "Open {base}/ratelimit/{token}.html and tell me the code shown on the page.",
            _has(r"RATE-OK-trouble_ratelimit-r\d", "the code after a 429 on the first visit"),
            about="a rate limit on the first visit", group="trouble"),
    BotTask("trouble_loop",
            "Open {base}/loop.html and tell me what the page says.",
            _says(r"redirect|loop|could ?n.?t|unable|fail|not (load|open)", "the page cannot be opened (a redirect loop)"),
            about="a redirect loop", group="trouble"),
    BotTask("trouble_nosite",
            "Open https://reports.no-such-host.invalid/q3 and tell me the headline figure.",
            _says(r"n.?t exist|not resolve|no such|could ?n.?t|unable|fail|not (load|open|reach)|unreachable|invalid",
                  "the site does not exist, nothing made up", never=r"\$\s?\d"),
            about="an address whose site does not exist", group="trouble"),
    BotTask("trouble_longpoll",
            "On {base}/hang.html click Refresh and tell me the status message.",
            _has(r"\bRefreshed\b", "Refreshed (a page that keeps a request open)"),
            about="a page with a request that never finishes", group="trouble"),
]


# ---- round 25: a very long page and a vague goal over several pages (fixture site; answers seeded per run,
# so they cannot come from memory). Where auto (Jev) and ask (small model) should beat hand-written steps.
def _seeded(fn_name: str, task: str, what: str):
    def check(answer: str, _truth: Any) -> tuple:
        import fixture_server as F
        want = [getattr(F, fn_name)(f"{task}-r{r}") for r in (1, 2, 3)]  # the check does not know the run
        forms = {str(w) for w in want} | {f"{w:,}" for w in want if isinstance(w, int)}
        got = _norm(answer)
        ok = any(f in got for f in forms)
        return ok, what, got[:200]
    return check


TASKS += [
    BotTask("long_report",
            "Open {base}/long/{token}.html (a very long report) and tell me how many pallets the Harbor depot "
            "logged in March. Reply with the number only.",
            _seeded("long_fact", "long_report", "the Harbor depot's March figure from a 250k-character page"),
            about="one fact in a 250k-character page, with decoys", group="long"),
    BotTask("shop_vague",
            "On {base}/shop/{token} find the cheapest blue item that is in stock. Reply with its name only.",
            _seeded("shop_answer", "shop_vague", "the cheapest blue in-stock item over 4 pages"),
            about="a vague goal over 4 catalogue pages", group="long"),
]
