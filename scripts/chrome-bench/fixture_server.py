"""Fixture site for the Chrome connector bench (scripts/chrome-bench).

Static pages from fixtures/ plus generated pages and a few JSON endpoints with deliberate delays.
Pages report what the browser did to /api/submit/<key> or /api/upload/<key>, so a test checks the
outcome on the server side instead of trusting what the connector read back. The data behind the
generated pages is deterministic and lives in this file, so it is also the ground truth.

    from fixture_server import start
    fx = start()          # a free port on 127.0.0.1, served from a background thread
    fx.base               # http://127.0.0.1:<port>   (fx.alt is http://localhost:<port>, another origin)
    fx.state.last("form") # the last thing the form page submitted

Run it alone to click through the pages by hand:  python fixture_server.py [port]
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import random
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# ---------------------------------------------------------------------------------------------
# Deterministic data: the ground truth for the generated pages
# ---------------------------------------------------------------------------------------------

_FIRST = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Margaret", "Ken", "Dennis", "Frances",
          "John", "Radia", "Linus", "Guido", "Bjarne", "Hedy", "Katherine", "Tim", "Vint", "Shafi"]
_LAST = ["Lovelace", "Hopper", "Turing", "Dijkstra", "Liskov", "Knuth", "Hamilton", "Thompson", "Ritchie",
         "Allen", "McCarthy", "Perlman", "Torvalds", "Rossum", "Stroustrup", "Lamarr", "Johnson", "Lee", "Cerf",
         "Goldwasser"]
REGIONS = ["North", "South", "East", "West"]
STATUSES = ["Shipped", "Pending", "Cancelled"]


def _orders() -> list[dict]:
    # Seed 11: the answer is neither the biggest order overall (South) nor the biggest in the West (Cancelled).
    rnd = random.Random(11)
    rows = []
    for i in range(60):
        rows.append({"id": f"ORD-{1001 + i}", "customer": f"{rnd.choice(_FIRST)} {rnd.choice(_LAST)}",
                     "region": rnd.choice(REGIONS), "amount": round(rnd.uniform(120, 19999), 2),
                     "status": rnd.choice(STATUSES), "date": f"2026-{rnd.randint(1, 9):02d}-{rnd.randint(1, 28):02d}"})
    return rows


ORDERS = _orders()
REGION_TOTALS = {r: round(sum(o["amount"] for o in ORDERS if o["region"] == r), 2) for r in REGIONS}


def orders_truth() -> dict:
    """The rule the table test applies: the Shipped order in the West with the highest amount."""
    return max((o for o in ORDERS if o["region"] == "West" and o["status"] == "Shipped"), key=lambda o: o["amount"])


_WORDS = ("signal harbor copper meadow lantern quartz orbit velvet ember thistle canyon falcon prism willow "
          "cobalt summit ribbon glacier saffron tundra beacon mosaic nectar pylon").split()
ARTICLE_SECRET = "K7-ORCHID-58"
ARTICLE_END = "END-OF-ARTICLE-7731"


def _article() -> list[list[str]]:
    rnd = random.Random(42)
    sections = []
    for _ in range(30):
        sections.append([" ".join(rnd.choice(_WORDS) for _ in range(70)).capitalize() + "." for _ in range(3)])
    sections[16][1] += f" The archive code is {ARTICLE_SECRET}."
    sections[29][2] += f" {ARTICLE_END}."
    return sections


ARTICLE = _article()

SPA_TOTAL = 47
SPA_PAGE = 10


def spa_item(n: int) -> dict:
    return {"id": n, "name": f"Item {n}", "price": round(3 + (n * 37) % 100 + 0.99, 2)}


FEED_TOTAL = 200


def feed_code(n: int) -> str:
    return hashlib.sha1(f"feed-{n}".encode()).hexdigest()[:6]


def feed_title(n: int) -> str:
    return f"Item {n} code {feed_code(n)}"


COUNTRIES = [("AR", "Argentina"), ("AU", "Australia"), ("AT", "Austria"), ("BE", "Belgium"), ("BR", "Brazil"),
             ("CA", "Canada"), ("CL", "Chile"), ("CN", "China"), ("DK", "Denmark"), ("EG", "Egypt"),
             ("FI", "Finland"), ("FR", "France"), ("DE", "Germany"), ("GR", "Greece"), ("IN", "India"),
             ("IE", "Ireland"), ("IT", "Italy"), ("JP", "Japan"), ("KE", "Kenya"), ("MX", "Mexico"),
             ("NL", "Netherlands"), ("NZ", "New Zealand"), ("NO", "Norway"), ("PK", "Pakistan"), ("PA", "Panama"),
             ("PY", "Paraguay"), ("PE", "Peru"), ("PH", "Philippines"), ("PL", "Poland"), ("PT", "Portugal"),
             ("ES", "Spain"), ("SE", "Sweden"), ("CH", "Switzerland"), ("GB", "United Kingdom"),
             ("US", "United States"), ("UY", "Uruguay"), ("VN", "Vietnam")]

PAGE_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]

REPORT_CSV = ("region,total\n" + "".join(f"{r},{REGION_TOTALS[r]:.2f}\n" for r in REGIONS)).encode()
DATA_BIN = random.Random(7).randbytes(50_000)
EXPORT_CSV = b"id,name\n1,alpha\n2,beta\n3,gamma\n"
SLOW_BIN = random.Random(11).randbytes(60_000)
PIXEL_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
UPLOAD_FILES = {"upload-a.txt": b"hermes chrome bench upload A\n" * 50, "upload-b.bin": random.Random(9).randbytes(3000)}


def write_upload_files(folder: Path) -> dict[str, Path]:
    """The files the upload tests send (the connector uploads only from allowed folders such as /tmp)."""
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, data in UPLOAD_FILES.items():
        p = folder / name
        if not p.exists() or p.read_bytes() != data:
            p.write_bytes(data)
        out[name] = p
    return out


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------------------------
# Generated pages
# ---------------------------------------------------------------------------------------------

_STYLE = ("<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:880px}"
          "table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:3px 8px}</style>")


def _page(title: str, body: str) -> bytes:
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
            f"{_STYLE}</head><body>{body}</body></html>").encode()


# ---- round 25: a very long report and a paged shop, both seeded by the task's token -----------------
_WORDS = ("ledger quarter freight audit depot inbound route manifest carrier volume region schedule transfer "
          "dock count review season forecast intake outbound storage turnover pallet shift crew yard").split()
DEPOTS = ["Harbor", "Ridge", "Valley", "Summit", "Canyon", "Prairie"]
MONTHS = ["January", "February", "March", "April", "May", "June"]


def long_fact(token: str) -> int:
    """Pallets the Harbor depot logged in March (the one fact the long report's question asks for)."""
    return 1000 + int(hashlib.sha256(f"long:{token}".encode()).hexdigest()[:6], 16) % 8000


def long_report_html(token: str) -> bytes:
    rng = random.Random(f"long:{token}")
    sections, answer = [], long_fact(token)
    target = rng.randrange(36, 54)
    for i in range(60):
        paras = []
        for _ in range(8):
            paras.append(" ".join(rng.choice(_WORDS) for _ in range(70)).capitalize() + ".")
        if i % 3 == 0 or i == target:
            depot, month = rng.choice(DEPOTS), rng.choice(MONTHS)
            if i == target:
                depot, month, n = "Harbor", "March", answer
            else:
                if (depot, month) == ("Harbor", "March"):
                    month = "February"
                n = rng.randrange(1000, 9000)
            paras.insert(rng.randrange(1, 8), f"In {month}, the {depot} depot logged {n:,} pallets through its "
                                              f"inbound docks.")
        body = "".join(f"<p>{html.escape(x)}</p>" for x in paras)
        sections.append(f"<h2>Section {i + 1}: {rng.choice(_WORDS).title()} {rng.choice(_WORDS)}</h2>{body}")
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><title>Annual operations report</title></head>"
            f"<body><main><h1>Annual operations report</h1>{''.join(sections)}</main></body></html>").encode()


COLOURS = ["blue", "red", "green", "black", "white", "blue"]


def shop_items(token: str) -> list[dict]:
    rng = random.Random(f"shop:{token}")
    nouns = ["Mug", "Lamp", "Scarf", "Bottle", "Notebook", "Cushion", "Planter", "Clock", "Tray", "Basket"]
    out = []
    for i in range(40):
        out.append({"name": f"{rng.choice(['Nordic', 'Coastal', 'Urban', 'Rustic', 'Studio'])} {rng.choice(nouns)} "
                            f"{100 + i}",
                    "colour": rng.choice(COLOURS), "price": round(rng.uniform(6, 90), 2),
                    "stock": rng.random() > 0.35})
    # The cheapest blue item overall is out of stock, so the answer needs the stock column too.
    blue = sorted((x for x in out if x["colour"] == "blue"), key=lambda x: x["price"])
    blue[0]["stock"] = False
    if not any(x["stock"] for x in blue):
        blue[1]["stock"] = True
    return out


def shop_answer(token: str) -> str:
    return min((x for x in shop_items(token) if x["colour"] == "blue" and x["stock"]), key=lambda x: x["price"])["name"]


def shop_html(token: str, page: int) -> bytes:
    items = shop_items(token)[(page - 1) * 10:page * 10]
    rows = "".join(f"<li class=item><span class=name>{html.escape(x['name'])}</span> <span class=colour>"
                   f"{x['colour']}</span> <span class=price>${x['price']:.2f}</span> <span class=stock>"
                   f"{'In stock' if x['stock'] else 'Sold out'}</span></li>" for x in items)
    nav = "".join(f" <a href='/shop/{token}?page={n}'>{'Page ' + str(n) if n != page else '[' + str(n) + ']'}</a>"
                  for n in range(1, 5))
    nxt = f" <a href='/shop/{token}?page={page + 1}'>Next page</a>" if page < 4 else ""
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><title>Home goods, page {page}</title></head>"
            f"<body><main><h1>Home goods</h1><p>Page {page} of 4</p><ul>{rows}</ul><nav>{nav}{nxt}</nav></main>"
            f"</body></html>").encode()


def article_html() -> bytes:
    parts = ["<main><article><h1>The Lighthouse Keepers Almanac</h1>",
             "<p>A long article for the bench: thirty sections of filler with two markers in it.</p>"]
    for i, paras in enumerate(ARTICLE, 1):
        parts.append(f'<section id="s{i}"><h2>Section {i}</h2>' + "".join(f"<p>{p}</p>" for p in paras) + "</section>")
    parts.append("</article></main>")
    return _page("The Lighthouse Keepers Almanac", "".join(parts))


def table_html() -> bytes:
    head = "<tr><th>Order</th><th>Customer</th><th>Region</th><th>Amount</th><th>Status</th><th>Date</th></tr>"
    rows = "".join(f"<tr><td>{o['id']}</td><td>{o['customer']}</td><td>{o['region']}</td><td>${o['amount']:,.2f}</td>"
                   f"<td>{o['status']}</td><td>{o['date']}</td></tr>" for o in ORDERS)
    totals = "".join(f"<tr><td>{r}</td><td>${REGION_TOTALS[r]:,.2f}</td></tr>" for r in REGIONS)
    body = ("<main><h1>Sales</h1><h2>Orders</h2><table id=\"orders\"><caption>Orders</caption>"
            f"<thead>{head}</thead><tbody>{rows}</tbody></table>"
            "<h2>Totals by region</h2><table id=\"totals\"><caption>Totals by region</caption>"
            f"<thead><tr><th>Region</th><th>Total</th></tr></thead><tbody>{totals}</tbody></table></main>")
    return _page("Sales", body)


def numbered_page(n: int) -> bytes:
    word = PAGE_WORDS[(n - 1) % len(PAGE_WORDS)]
    return _page(f"Page {n}", f"<main><h1>Page {n}: {word}</h1><p>This is numbered page {n}.</p>"
                              f'<p><a href="/page/{n + 1}.html">Next page</a></p></main>')


def index_html() -> bytes:
    links = "".join(f'<li><a href="/{p.name}">{p.name}</a></li>' for p in sorted(FIXTURES.glob("*.html")))
    extra = "".join(f'<li><a href="{u}">{u}</a></li>' for u in ("/article.html", "/table.html", "/page/1.html"))
    return _page("Bench fixtures", f"<main><h1>Bench fixtures</h1><ul>{links}{extra}</ul></main>")


# ---------------------------------------------------------------------------------------------
# State and the server
# ---------------------------------------------------------------------------------------------

class State:
    """What the pages reported, per key, in order."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, list] = {}

    def add(self, key: str, value) -> int:
        with self._lock:
            self._data.setdefault(key, []).append(value)
            return len(self._data[key])

    def get(self, key: str) -> list:
        with self._lock:
            return list(self._data.get(key, []))

    def last(self, key: str, default=None):
        items = self.get(key)
        return items[-1] if items else default

    def reset(self) -> None:
        with self._lock:
            self._data.clear()


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesBench/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # quiet
        pass

    # -- plumbing --------------------------------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    @property
    def state(self) -> State:
        return self.server.state  # type: ignore[attr-defined]

    def _templ(self, data: bytes) -> bytes:
        port = self.server.server_address[1]
        return (data.replace(b"{{ALT}}", f"http://localhost:{port}".encode())
                .replace(b"{{BASE}}", f"http://127.0.0.1:{port}".encode()))

    # -- GET ---------------------------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = u.path

        def arg(name: str, default: int) -> int:
            try:
                return int(q.get(name, [default])[0])
            except ValueError:
                return default

        if path in ("/", "/index.html"):
            return self._send(200, index_html(), "text/html; charset=utf-8")
        if path.startswith("/long/") and path.endswith(".html"):
            return self._send(200, long_report_html(path[6:-5]), "text/html; charset=utf-8")
        if path.startswith("/shop/"):
            try:
                page = min(4, max(1, int((q.get("page") or ["1"])[0])))
            except ValueError:
                page = 1
            return self._send(200, shop_html(path[6:], page), "text/html; charset=utf-8")
        if path == "/article.html":
            return self._send(200, article_html(), "text/html; charset=utf-8")
        if path == "/table.html":
            return self._send(200, table_html(), "text/html; charset=utf-8")
        if path.startswith("/page/") and path.endswith(".html"):
            try:
                n = int(path[6:-5])
            except ValueError:
                return self._json({"error": "bad page"}, 404)
            return self._send(200, numbered_page(n), "text/html; charset=utf-8")
        if path == "/api/items":
            time.sleep(0.15)
            page = max(1, arg("page", 1))
            pages = (SPA_TOTAL + SPA_PAGE - 1) // SPA_PAGE
            first = (page - 1) * SPA_PAGE + 1
            items = [spa_item(n) for n in range(first, min(SPA_TOTAL, first + SPA_PAGE - 1) + 1)]
            return self._json({"page": page, "pages": pages, "total": SPA_TOTAL, "items": items})
        if path == "/api/suggest":
            time.sleep(0.4)
            want = (q.get("q", [""])[0]).strip().lower()
            hits = [{"code": c, "name": n} for c, n in COUNTRIES if want and n.lower().startswith(want)][:8]
            return self._json({"q": want, "options": hits})
        if path == "/api/feed":
            time.sleep(0.3)
            offset, limit = max(0, arg("offset", 0)), max(1, min(50, arg("limit", 20)))
            items = [{"n": n, "title": feed_title(n)} for n in range(offset + 1, min(FEED_TOTAL, offset + limit) + 1)]
            nxt = offset + len(items)
            return self._json({"items": items, "next": nxt if nxt < FEED_TOTAL else None})
        if path.startswith("/api/state/"):
            return self._json(self.state.get(path[len("/api/state/"):]))
        if path == "/download/report.csv":
            return self._send(200, REPORT_CSV, "text/csv",
                              {"Content-Disposition": 'attachment; filename="region-report.csv"'})
        if path == "/download/data.bin":
            return self._send(200, DATA_BIN, "application/octet-stream",
                              {"Content-Disposition": 'attachment; filename="bench-data.bin"'})
        # ---- trouble: pages and files that fail the way real sites do ------------------------------
        if path.startswith("/flaky/") and path.endswith(".html"):
            # A server error on the first visit, then the page (a busy server, a deploy in progress).
            key = path[len("/flaky/"):-5]
            hits = self.state.add(f"flaky:{key}", 1)
            if hits == 1:
                return self._send(500, b"<!doctype html><title>500 Internal Server Error</title><h1>Internal Server Error</h1>",
                                  "text/html; charset=utf-8")
            body = (f"<!doctype html><html><head><meta charset=utf-8><title>Report {html.escape(key)}</title></head>"
                    f"<body><main><h1>Report {html.escape(key)}</h1><p id=code>FLAKY-OK-{html.escape(key)}</p></main>"
                    "</body></html>").encode()
            return self._send(200, body, "text/html; charset=utf-8")
        if path == "/always500.html":
            return self._send(500, b"<!doctype html><title>500 Internal Server Error</title><h1>Internal Server Error</h1>",
                              "text/html; charset=utf-8")
        if path == "/api/hang":
            # A request that never answers in time (a long poll, a stuck analytics call).
            time.sleep(30)
            return self._json({"ok": True})
        if path.startswith("/api/flaky-data/"):
            key = path[len("/api/flaky-data/"):]
            if self.state.add(f"flaky-data:{key}", 1) == 1:
                return self._json({"error": "upstream timeout"}, 500)
            return self._json({"code": f"DATA-OK-{key}"})
        if path.startswith("/ratelimit/") and path.endswith(".html"):
            key = path[len("/ratelimit/"):-5]
            if self.state.add(f"ratelimit:{key}", 1) == 1:
                return self._send(429, b"<!doctype html><title>429 Too Many Requests</title><h1>Too Many Requests</h1>",
                                  "text/html; charset=utf-8", {"Retry-After": "1"})
            body = (f"<!doctype html><html><head><meta charset=utf-8><title>Rates</title></head><body><main>"
                    f"<h1>Rates</h1><p id=code>RATE-OK-{html.escape(key)}</p></main></body></html>").encode()
            return self._send(200, body, "text/html; charset=utf-8")
        if path == "/loop.html":
            return self._send(302, b"", "text/html", {"Location": "/loop.html"})
        if path == "/account":
            # A session that has run out: the account page bounces to the sign-in page.
            return self._send(302, b"", "text/html", {"Location": "/login.html?next=/account"})
        if path.startswith("/slowpage/"):
            # A slow server: the page itself arrives after <ms>.
            parts = path.split("/")
            try:
                ms = int(parts[2])
            except (IndexError, ValueError):
                ms = 3000
            time.sleep(min(ms, 15000) / 1000.0)
            body = (f"<!doctype html><html><head><meta charset=utf-8><title>Status</title></head><body><main>"
                    f"<h1>Status</h1><p id=status>STATUS-GREEN-{ms}</p></main></body></html>").encode()
            return self._send(200, body, "text/html; charset=utf-8")
        if path == "/download/slow.bin":
            # A slow download: 60 kB in six parts over about 3 s.
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(SLOW_BIN)))
            self.send_header("Content-Disposition", 'attachment; filename="slow-export.bin"')
            self.end_headers()
            for i in range(6):
                self.wfile.write(SLOW_BIN[i * 10000:(i + 1) * 10000])
                self.wfile.flush()
                time.sleep(0.5)
            return None
        if path == "/download/broken.bin":
            # A download the server cuts off: it promises 100 kB, sends 2 kB, closes the connection.
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", "100000")
            self.send_header("Content-Disposition", 'attachment; filename="large-export.bin"')
            self.end_headers()
            self.wfile.write(b"x" * 2000)
            self.wfile.flush()
            time.sleep(0.3)
            self.close_connection = True
            try:
                import socket
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return None
        if path.startswith("/slow/"):
            parts = path.split("/")
            try:
                ms = int(parts[2])
            except (IndexError, ValueError):
                ms = 1000
            time.sleep(min(ms, 10000) / 1000.0)
            name = parts[-1]
            if name.endswith(".png"):
                return self._send(200, PIXEL_PNG, "image/png")
            if name.endswith(".js"):
                js = b"document.getElementById('late').textContent = 'late script ran';"
                return self._send(200, js, "text/javascript")
            return self._send(200, b"", "text/css")
        return self._static(path)

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (FIXTURES / rel).resolve()
        if FIXTURES.resolve() not in target.parents or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        data = target.read_bytes()
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
                 ".json": "application/json", ".png": "image/png", ".txt": "text/plain"}.get(target.suffix, "application/octet-stream")
        if target.suffix == ".html":
            data = self._templ(data)
        return self._send(200, data, ctype)

    # -- POST --------------------------------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        body = self._body()
        if path.startswith("/api/submit/"):
            key = path[len("/api/submit/"):]
            try:
                value = json.loads(body.decode("utf-8") or "null")
            except ValueError:
                value = body.decode("utf-8", "replace")
            return self._json({"ok": True, "n": self.state.add(key, value)})
        if path.startswith("/api/upload/"):
            key = path[len("/api/upload/"):]
            name = urllib.parse.unquote(self.headers.get("X-File-Name") or "")
            n = self.state.add(key, {"name": name, "size": len(body), "sha256": sha256(body)})
            return self._json({"ok": True, "n": n, "size": len(body)})
        if path == "/api/reset":
            self.state.reset()
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # A tab closed while a slow response was still being written: normal during a bench run.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Fixture:
    def __init__(self, httpd: ThreadingHTTPServer) -> None:
        self.httpd = httpd
        self.port = httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.alt = f"http://localhost:{self.port}"
        self.state: State = httpd.state  # type: ignore[attr-defined]

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def start(host: str = "127.0.0.1", port: int = 0) -> Fixture:
    httpd = _Server((host, port), Handler)
    httpd.state = State()  # type: ignore[attr-defined]
    threading.Thread(target=httpd.serve_forever, name="bench-fixtures", daemon=True).start()
    return Fixture(httpd)


if __name__ == "__main__":
    fx = start(port=int(sys.argv[1]) if len(sys.argv) > 1 else 0)
    print(f"fixtures on {fx.base} (also {fx.alt}); Ctrl+C to stop")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        fx.stop()
