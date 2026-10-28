"""Live public-site tasks: fixed steps and checks for Runner B, prompts and answer patterns for Runner C.

Read-only on the open web: no logins, purchases, posts, votes or messages. Only the demo sites built
for automation practice are typed into: the-internet.herokuapp.com (it also receives one small text
file on its upload page) and the Playwright TodoMVC demo. The bench never tries to get past a bot
check or a login wall: such a page is recorded as "blocked" (reported, not scored).

Live pages change. When a task fails, look at the stored output in the round file before blaming the
connector: a changed page is a bench update, not a connector bug.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

TASKS, task = C.registry()

UPLOAD_NAME = "bench-upload.txt"
UPLOAD_BYTES = b"hermes chrome bench upload test\n"

# Pages that wall a browser off. Seeing one is "blocked", never something to work around.
_WALLS = [
    (r"Sorry! Something went wrong!|To discuss automated access to Amazon data|Enter the characters you see below",
     "Amazon error page served to this browser"),
    (r"blocked by network security", "Reddit network-security block"),
    (r"reddit\.com/login/\?reason=", "Reddit login wall"),
    (r"(?i)unusual traffic from your computer|verify you are (a )?human|are you a robot|captcha", "bot check"),
    (r"consent\.(google|youtube)\.com", "consent wall"),
    (r"No results returned\.\s*Oops, something went wrong", "Google Flights returned no results to this browser"),
]


def write_files() -> dict:
    C.FILES_DIR.mkdir(parents=True, exist_ok=True)
    p = C.FILES_DIR / UPLOAD_NAME
    if not p.exists() or p.read_bytes() != UPLOAD_BYTES:
        p.write_bytes(UPLOAD_BYTES)
    return {UPLOAD_NAME: str(p)}


def wall(out: str) -> str:
    for pattern, label in _WALLS:
        if re.search(pattern, out):
            return label
    return ""


def verdict(out: str, ok, what: str, got=None):
    """Like C.check, but a failure on a walled page is "blocked" instead of a connector failure."""
    if not ok:
        w = wall(out)
        if w:
            return "blocked", f"blocked by the site ({w}); expected {what}"
    return C.check(ok, what, got)


def _items(out: str, spec: str) -> list[str]:
    blocks = C.read_items(out, spec)
    return blocks[-1] if blocks else []


@task("wiki_article", "Wikipedia article: a fact from the infobox",
      prompt="On Wikipedia, what is Alan Turing's date of birth? Reply with the date only.",
      answer=r"23 June 1912|June 23,? 1912")
def _(t):
    out = t.call("go https://en.wikipedia.org/wiki/Alan_Turing\nread css=.infobox")
    return verdict(out, re.search(r"23 June 1912", out), "the infobox says 23 June 1912", out[:400])


@task("wiki_search", "Wikipedia: search box, Enter, the article",
      prompt="Use the search box on the English Wikipedia main page to find Ada Lovelace. In what year was she born? Reply with the year only.",
      answer=r"\b1815\b")
def _(t):
    out = t.call("go https://en.wikipedia.org/wiki/Main_Page\ntype Search Wikipedia = Ada Lovelace\npress Enter\nread css=#firstHeading")
    return verdict(out, _items(out, "css=#firstHeading") == ["Ada Lovelace"], "the Ada Lovelace article opened", out[-400:])


@task("hn_front", "Hacker News front page: the story list",
      prompt="How many stories are listed on the Hacker News front page (news.ycombinator.com) right now? Reply with the number only.",
      answer=r"\b30\b")
def _(t):
    out = t.call("go https://news.ycombinator.com/\nread css=.titleline > a")
    items = _items(out, "css=.titleline")
    return verdict(out, len(items) == 30, "30 story titles", f"{len(items)} items: {items[:2]}")


@task("gh_trending", "GitHub trending: repository names",
      prompt="What is the first repository listed on github.com/trending right now? Reply as owner/name only.",
      answer=r"[\w.-]+\s*/\s*[\w.-]+")
def _(t):
    out = t.call("go https://github.com/trending\nread css=article.Box-row h2 a")
    items = _items(out, "css=article.Box-row")
    ok = len(items) >= 10 and all(re.match(r"^[\w.-]+ ?/ ?[\w.-]+$", x) for x in items)
    return verdict(out, ok, "at least 10 owner / name entries", items[:3] or out[-400:])


@task("mdn_search", "MDN docs search: results (inside a web component), open the array one",
      prompt="Search MDN Web Docs for flatMap and open the result about arrays. What is the exact page title (the main heading)? Reply with the title only.",
      answer=r"Array\.prototype\.flatMap\(\)")
def _(t):
    out = t.call(["go https://developer.mozilla.org/en-US/search?q=flatMap",
                  {"wait": "text:Array.prototype.flatMap()", "timeout": 6},
                  "click link:Array.prototype.flatMap()", "read css=main h1"])
    return verdict(out, _items(out, "css=main h1") == ["Array.prototype.flatMap()"], "the Array.prototype.flatMap() page opened",
                   out[-400:])


@task("bbc_news", "News site: BBC News headlines",
      prompt="What is the top headline on bbc.com/news right now? Reply with the headline only.",
      answer=r"\w{3,}")
def _(t):
    out = t.call("go https://www.bbc.com/news\nread css=h2")
    items = [x for x in _items(out, "css=h2") if len(x.split()) >= 3]
    return verdict(out, len(items) >= 5, "at least 5 headlines of 3+ words", items[:3] or out[-400:])


@task("google_flights", "Travel search: Google Flights results (no booking)",
      prompt="Using Google Flights, what is the cheapest one-way fare shown from London to Paris on 15 December 2026? Do not book anything. Reply with the price only.",
      answer=r"[$£€]\s?\d")
def _(t):
    # "Loading results" stays in the page (a live region), so a fixed pause gives the results time.
    out = t.call("go https://www.google.com/travel/flights?q=Flights%20to%20Paris%20from%20London%20on%202026-12-15%20one%20way&hl=en&curr=USD\n"
                 "wait 2500\nread text")
    full = C.with_saved(out)
    return verdict(out, re.search(r"\$\s?\d{2,}", full) and "Paris" in full, "fares in USD for London to Paris", out[-400:])


@task("amazon_search", "Amazon search results (no cart, no purchase)",
      prompt="Search amazon.com for 'usb c cable' and tell me the title of the first result. Do not add anything to the cart. Reply with the title only.",
      answer=r"(?i)usb")
def _(t):
    out = t.call("go https://www.amazon.com/s?k=usb+c+cable\nread css=[data-component-type=s-search-result] h2", map="auto")
    items = _items(out, "css=[data-component-type")
    return verdict(out, len(items) >= 5 and any("usb" in x.lower() for x in items), "at least 5 result titles mentioning USB",
                   items[:3] or out[-400:])


@task("youtube_search", "YouTube search results",
      prompt="Search YouTube for 'lofi hip hop radio' and tell me the title of the first video result. Reply with the title only.",
      answer=r"(?i)lo-?fi")
def _(t):
    out = t.call("go https://www.youtube.com/results?search_query=lofi+hip+hop+radio\nwait css=ytd-video-renderer\n"
                 "read css=ytd-video-renderer #video-title")
    items = _items(out, "css=ytd-video-renderer")
    return verdict(out, len(items) >= 5, "at least 5 video titles", items[:3] or out[-400:])


@task("reddit_old", "old.reddit.com listing (read only)",
      prompt="On old.reddit.com/r/programming, what is the title of the top post right now? Read only: do not vote or comment. Reply with the title only.",
      answer=r"\w{3,}")
def _(t):
    out = t.call("go https://old.reddit.com/r/programming/\nread css=#siteTable a.title", map="auto")
    items = _items(out, "css=#siteTable")
    return verdict(out, len(items) >= 10, "at least 10 post titles", items[:3] or out[-400:])


@task("books_product", "E-commerce product page (books.toscrape.com): price and stock",
      prompt="On books.toscrape.com, what is the price of the book 'A Light in the Attic'? Reply with the price only.",
      answer=r"£\s?51\.77", smoke=True)
def _(t):
    out = t.call("go https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html\n"
                 "read css=.product_main .price_color\nread css=.product_main .availability")
    blocks = C.read_items(out, "css=.product_main")
    return verdict(out, blocks == [["£51.77"], ["In stock (22 available)"]], "£51.77 and In stock (22 available)",
                   blocks or out[-400:])


@task("datagov_search", "Government data catalog (catalog.data.gov): search box and result count",
      prompt="Search catalog.data.gov for 'electric vehicle'. How many datasets does it find? Reply with the number only.",
      answer=r"\d[\d,]*")
def _(t):
    out = t.call("go https://catalog.data.gov/\ntype Search datasets = electric vehicle\npress Enter\nread text")
    m = re.search(r"Found ([\d,]+) datasets? matching", C.with_saved(out))
    return verdict(out, m and int(m.group(1).replace(",", "")) > 0, "Found N datasets matching", out[-400:])


@task("heroku_dynamic", "the-internet: element rendered after a 5 s load",
      prompt="Open the-internet.herokuapp.com/dynamic_loading/2, click Start and tell me the text that appears. Reply with the text only.",
      answer=r"Hello World!")
def _(t):
    out = t.call("go https://the-internet.herokuapp.com/dynamic_loading/2\nclick Start\nwait text:Hello World!\nread css=#finish")
    return verdict(out, _items(out, "css=#finish") == ["Hello World!"], "Hello World! read after the wait", out[-400:])


@task("heroku_iframe", "the-internet: text inside the TinyMCE iframe",
      prompt="On the-internet.herokuapp.com/iframe, what text is inside the editor? Reply with the text only.",
      answer=r"Your content goes here")
def _(t):
    out = t.call("go https://the-internet.herokuapp.com/iframe\nread css=#tinymce")
    return verdict(out, "Your content goes here." in " ".join(_items(out, "css=#tinymce")),
                   "the editor text read through the iframe", out[-400:])


@task("heroku_alerts", "the-internet: JS confirm dismissed and JS prompt answered",
      prompt="On the-internet.herokuapp.com/javascript_alerts, click 'Click for JS Confirm', cancel the dialog and tell me the result text shown. Reply with the text only.",
      answer=r"You clicked: Cancel")
def _(t):
    out = t.call("go https://the-internet.herokuapp.com/javascript_alerts\ndialog dismiss\nclick Click for JS Confirm\n"
                 "read css=#result\ndialog accept = bench\nclick Click for JS Prompt\nread css=#result")
    blocks = C.read_items(out, "css=#result")
    return verdict(out, blocks == [["You clicked: Cancel"], ["You entered: bench"]],
                   "You clicked: Cancel, then You entered: bench", blocks or out[-400:])


@task("heroku_upload", "the-internet: file upload form (one small text file)",
      prompt=f"Upload the file /tmp/hermes-work/bench/files/{UPLOAD_NAME} on the-internet.herokuapp.com/upload and tell me the file name the page reports afterwards. Reply with the name only.",
      answer=re.escape(UPLOAD_NAME))
def _(t):
    out = t.call(f"go https://the-internet.herokuapp.com/upload\nupload css=#file-upload = {t.files[UPLOAD_NAME]}\n"
                 "click css=#file-submit\nread css=#uploaded-files")
    return verdict(out, _items(out, "css=#uploaded-files") == [UPLOAD_NAME], f"the page reports {UPLOAD_NAME}", out[-400:])


@task("heroku_download", "the-internet: download a listed file (the one the upload task sent)",
      prompt=f"On the-internet.herokuapp.com/download, download the file {UPLOAD_NAME} and tell me its size in bytes. Reply with the number only.",
      answer=rf"\b{len(UPLOAD_BYTES)}\b")
def _(t):
    out = t.call(f"go https://the-internet.herokuapp.com/download\ndownload {UPLOAD_NAME}")
    path, data = C.downloaded(out)
    return verdict(out, data == UPLOAD_BYTES, f"{UPLOAD_NAME} saved with the {len(UPLOAD_BYTES)} bytes uploaded", out[-400:])


@task("todomvc", "Playwright TodoMVC demo: add two todos",
      prompt="On demo.playwright.dev/todomvc, add a todo called 'bench item' and tell me how many items are left. Reply with the number only.",
      answer=r"\b\d+\b")
def _(t):
    out = t.call("go https://demo.playwright.dev/todomvc/\ntype What needs to be done? = bench item one\npress Enter\n"
                 "type What needs to be done? = bench item two\npress Enter\nread css=.todo-list li label\nread css=.todo-count")
    labels, count = _items(out, "css=.todo-list"), _items(out, "css=.todo-count")
    m = re.match(r"(\d+) items? left", count[0]) if count else None
    ok = "bench item one" in labels and "bench item two" in labels and m and int(m.group(1)) == len(labels)
    return verdict(out, ok, "both todos listed and the count matches the list", f"{labels[-3:]} {count}")
