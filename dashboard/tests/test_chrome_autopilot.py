"""chrome_autopilot: the Jev autopilot (auto) and small-model page reading (ask), with fake pages and a
fake gateway. No browser and no network."""

import copy
import http.client
import json
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import chrome_autopilot as ap
import chrome_connector as cc
import pwa_router

EVALUATE = "https://ai-gateway.vercel.sh/v1/evaluate"
CHAT = "https://ai-gateway.vercel.sh/v1/chat/completions"
ZDR = {"gateway": {"zeroDataRetention": True}}
PLAN_REFUSAL = (
    '{"error":{"message":"Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. Current plan: '
    'hobby. Please upgrade your plan to access this feature.","type":"permission_denied"}}'
)
NO_PROVIDER = (
    '{"error":"No ZDR (Zero Data Retention) providers available for model: inception/mercury-3. Providers '
    'considered: inception","type":"no_providers_available","statusCode":400}'
)
GOAL = "open the article about the Eiffel Tower"


def page(url, title, els, text="", scroll=(0, 0), dialog=""):
    return {"title": title, "url": url, "ready": "complete", "dialog": dialog, "behind": 0, "notices": [],
            "heads": [], "frames": [], "login": False, "els": els, "total": len(els), "cut": 0, "text": text,
            "scroll": list(scroll)}


WIKI = page("https://en.wikipedia.org/wiki/Main_Page", "Wikipedia, the free encyclopedia", [
    ["e1", "button", "Main menu", {}],
    ["e2", "searchbox", "Search Wikipedia", {"value": ""}],
    ["e3", "button", "Search", {}],
    ["e4", "link", "Eiffel Tower", {"href": "/wiki/Eiffel_Tower"}],
    ["e5", "password", "Password", {"value": ""}],
    ["e6", "button", "Disabled thing", {"disabled": True}],
    ["e7", "select", "Sort by", {"value": "Relevance", "options": ["Relevance", "Newest", "Oldest"]}],
    ["e8", "checkbox", "Remember me", {"checked": False}],
    ["e9", "textbox", "Read only", {"value": "x", "readonly": True}],
    ["e10", "combobox", "Language", {"value": "", "expanded": False}],
], text="Welcome to Wikipedia\n[... 7935 more characters; read with {\"read\": \"text\"}]", scroll=(0, 2800))
ARTICLE = page("https://en.wikipedia.org/wiki/Eiffel_Tower", "Eiffel Tower - Wikipedia",
               [["e20", "link", "Paris", {"href": "/wiki/Paris"}]], text="The Eiffel Tower is in Paris.")
SHOP = page("https://shop.example/account", "Account", [
    ["e1", "button", "Save changes", {}],
    ["e2", "button", "Delete client", {}],
    ["e3", "link", "Order history", {"href": "/orders"}],
    ["e4", "link", "The Jungle Book", {"href": "/wiki/The_Jungle_Book"}],
    ["e5", "link", "Log out", {"href": "/logout"}],
    ["e6", "button", "Search", {}],
    ["e7", "link", "Account", {"href": "/account/signout"}],
    ["e8", "link", "Washington Post", {"href": "/wiki/The_Washington_Post"}],
])
ROUTED = {"gateway": {"routing": {"planningReasoning": "ZDR requested: 1 attempts -> 1 ZDR attempts."}}}
NOT_ROUTED = {"gateway": {"routing": {"planningReasoning": "System credentials planned for: typesafe-ai"}}}


def choice(options, picked, confidence=0.95):
    return {"type": "choice", "choice": picked, "confidence": confidence,
            "probabilities": {o: (1.0 if o == picked else 0.0) for o in options}}


class FakeGateway:
    """Answers like Vercel's AI Gateway: zero data retention checks, Jev decisions and chat completions."""

    def __init__(self, decisions=(), texts=(), refuse="", applied=True, fail=None, fail_at=0):
        self.decisions = list(decisions)
        self.texts = list(texts)
        self.refuse = refuse
        self.applied = applied
        self.fail = fail
        self.fail_at = fail_at
        self.asked = 0
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        sent = json.loads(body)
        self.calls.append({"url": url, "headers": headers, "body": sent, "timeout": timeout})
        if self.refuse and sent.get("providerOptions"):
            raise pwa_router.JevHTTPError(400 if "No ZDR" in self.refuse else 403, self.refuse)
        meta = ROUTED if self.applied else NOT_ROUTED
        if url == EVALUATE:
            if "check" in sent["questions"]:
                return {"answers": {"check": {"type": "boolean", "probability": 0.9}}, "providerMetadata": meta}
            self.asked += 1
            if self.fail is not None and self.asked > self.fail_at:
                raise self.fail
            op, target = self.decisions.pop(0)
            questions = sent["questions"]
            answers = {"operation": choice(questions["operation"]["criteria"], op)}
            for head in ("click_target", "type_text_target", "select_target"):
                if head in questions:  # speculative heads; the unused ones answer nonsense on purpose
                    answers[head] = {"type": "choice", "choice": "999", "probabilities": {}}
            if ap.HEADS.get(op):
                answers[ap.HEADS[op]] = choice(questions[ap.HEADS[op]]["criteria"], target)
            return {"answers": answers, "model": "typesafe-ai/jev", "providerMetadata": meta}
        if url == CHAT:
            content = "OK" if sent["max_tokens"] == 1 else self.texts.pop(0)
            return {"choices": [{"message": {"role": "assistant", "content": content, "provider_metadata": meta}}]}
        raise AssertionError(url)

    def urls(self):
        return [c["url"] for c in self.calls]


class FakeTab:
    """A tab whose map walks through the given pages, one per navigating action."""

    def __init__(self, pages, text="", options=None):
        self.pages = list(pages)
        self.i = 0
        self.text = text
        self.options = options or {}
        self.calls = []
        self.pending_nav = False
        self.nav_seq = 0
        self.hcx_busy_advances = False  # a page that finishes rendering while the autopilot waits

    @property
    def page(self):
        return self.pages[min(self.i, len(self.pages) - 1)]

    def advance(self):
        self.i += 1

    def hcx(self, fn, *args, timeout=30.0):
        self.calls.append((fn, *args))
        if fn == "map":
            return copy.deepcopy(self.page)
        if fn == "busy":
            if self.hcx_busy_advances:
                self.advance()
            return {"ready": "complete", "inflight": 0, "quiet": 1000, "net": 10 ** 9}
        if fn == "scroll":
            self.advance()
            return {"y": 850}
        if fn == "read":
            return {"text": self.text}
        raise AssertionError(fn)

    def evaluate(self, expression, **_):
        self.calls.append(("evaluate", expression))
        if "document.title" in expression:
            return [self.page["url"], self.page["title"]]
        if "e.options" in expression:
            return self.options
        if expression == "location.href":
            return self.page["url"]
        return None


class FakeRun:
    """The parts of chrome_connector.Run the autopilot uses; actions are logged, not done."""

    def __init__(self, tab, home):
        self.tab = tab
        self.deadline = time.monotonic() + 120
        self.browser = SimpleNamespace(settings=SimpleNamespace(home=Path(home)))
        self.done = []

    def url(self):
        return self.tab.page["url"]

    def _click(self, step, target, double):
        self.done.append(("click", target))
        self.tab.advance()
        return f"click {target} (0.1s)"

    def _typed(self, target, text, *, clear=True, enter=False):
        self.done.append(("type", target, text))
        return f'type {target}: "" -> {json.dumps(text)}'

    def _selected(self, target, option):
        self.done.append(("select", target, option))
        return f"select {target}: -> {json.dumps(option)}"

    def do_press(self, step, keys):
        self.done.append(("press", keys))
        self.tab.advance()
        return f"press {keys} (0.2s)"


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in (("jev_credentials", lambda: (pwa_router.VERCEL, "vck_test")),
                            ("load_settings", pwa_router.default_settings)):
            patcher = patch.object(pwa_router, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        ap.forget_zdr()
        self.addCleanup(ap.forget_zdr)
        self.run_ = None

    def auto(self, pages, gw, goal=GOAL, options=None, **step):
        self.run_ = FakeRun(FakeTab(pages, options=options), self.tmp.name)
        return ap.run_auto(self.run_, {"auto": goal, **step}, goal, post=gw)

    def auto_fails(self, pages, gw, goal=GOAL, **step):
        with self.assertRaises(cc.ConnectorError) as ctx:
            self.auto(pages, gw, goal, **step)
        return str(ctx.exception)

    def ask(self, text, gw, question="How tall is the Eiffel Tower?", **step):
        self.run_ = FakeRun(FakeTab([ARTICLE], text=text), self.tmp.name)
        return ap.ask(self.run_, {"ask": question, **step}, question, post=gw)


class RequestTests(_Base):
    def test_one_request_per_step_with_each_head_offered_only_what_it_can_act_on(self):
        gw = FakeGateway(decisions=[("DONE", None)])
        out = self.auto([WIKI], gw)
        self.assertEqual(gw.urls(), [EVALUATE, EVALUATE])  # the zero data retention check, then one decision
        check, decision = gw.calls
        self.assertEqual(check["body"]["providerOptions"], ZDR)
        self.assertNotIn("Eiffel", json.dumps(check["body"]))  # the check carries nothing from the goal or page
        self.assertNotIn("Wikipedia", json.dumps(check["body"]))
        body = decision["body"]
        self.assertEqual(decision["headers"]["Authorization"], "Bearer vck_test")
        self.assertEqual(body["model"], "typesafe-ai/jev")
        self.assertEqual(body["providerOptions"], ZDR)
        self.assertEqual(body["state"]["goal"], GOAL)
        self.assertEqual(body["state"]["recent_actions"], [])
        self.assertEqual(body["state"]["page"]["text"], "Welcome to Wikipedia")
        questions = body["questions"]
        self.assertEqual(set(questions), {"operation", "click_target", "type_text_target", "select_target"})
        # Numbered: visible, enabled controls only (no password field, nothing disabled, no read-only text box).
        self.assertEqual(len(body["state"]["elements"]), 7)
        self.assertNotIn("Password", json.dumps(body))
        self.assertNotIn("Disabled thing", json.dumps(body))
        self.assertNotIn("Read only", json.dumps(body))
        clicks = questions["click_target"]["criteria"]
        self.assertEqual(sorted(clicks, key=int), ["1", "3", "4", "6", "7"])  # buttons, the link, the box, the combobox
        self.assertTrue(clicks["4"].startswith('[4] link "Eiffel Tower" -> /wiki/Eiffel_Tower'))
        self.assertEqual(sorted(questions["type_text_target"]["criteria"], key=int), ["2", "7"])  # text fields
        self.assertEqual(sorted(questions["select_target"]["criteria"]), ["5:2", "5:3"])  # not the chosen option
        self.assertIn('-> option "Newest"', questions["select_target"]["criteria"]["5:2"])
        self.assertEqual(set(questions["operation"]["criteria"]),
                         {"CLICK", "TYPE_TEXT", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"})
        self.assertTrue(out.startswith(f"auto {GOAL}: DONE in 1 step, "))
        self.assertEqual(self.run_.done, [])

    def test_only_controls_on_screen_are_numbered(self):
        long_page = page("https://example.test/", "Long", [
            ["e1", "link", "Top link", {"href": "/top"}],
            ["e2", "link", "Far below", {"href": "/below", "offscreen": True}],
        ], scroll=(0, 5000))
        gw = FakeGateway(decisions=[("DONE", None)])
        self.auto([long_page], gw, goal="open Far below")
        body = gw.calls[1]["body"]
        self.assertEqual(body["state"]["elements"], ['[1] link "Top link" -> /top'])
        self.assertIn("SCROLL_DOWN", body["questions"]["operation"]["criteria"])

    def test_heads_appear_only_when_some_element_fits(self):
        only_links = page("https://example.test/", "Links", [["e1", "link", "About", {"href": "/about"}]])
        gw = FakeGateway(decisions=[("DONE", None)])
        self.auto([only_links], gw)
        questions = gw.calls[1]["body"]["questions"]
        self.assertEqual(set(questions), {"operation", "click_target"})
        self.assertEqual(set(questions["operation"]["criteria"]), {"CLICK", "WAIT", "DONE", "BLOCKED"})

    def test_long_dropdowns_are_offered_in_full(self):
        many = [f"Country {i}" for i in range(1, 41)]
        form = page("https://example.test/form", "Form",
                    [["e1", "select", "Country", {"value": "Country 1", "options": many[:15], "more": 25}]])
        gw = FakeGateway(decisions=[("SELECT", "1:33"), ("DONE", None)])
        self.auto([form], gw, goal="choose Country 33", options={"e1": many})
        self.assertEqual(len(gw.calls[1]["body"]["questions"]["select_target"]["criteria"]), 39)
        self.assertEqual(self.run_.done, [("select", "e1", "Country 33")])


class SafetyTests(_Base):
    def test_controls_that_change_things_are_withheld_unless_changes_are_allowed(self):
        gw = FakeGateway(decisions=[("DONE", None)])
        self.auto([SHOP], gw)
        body = gw.calls[1]["body"]
        offered = " ".join(body["questions"]["click_target"]["criteria"].values())
        for kept in ("The Jungle Book", "Washington Post", '"Search"'):
            self.assertIn(kept, offered)
        for gone in ("Save changes", "Delete client", "Order history", "Log out", '"Account"'):
            self.assertNotIn(gone, offered)
        self.assertEqual(body["state"]["withheld_controls"],
                         ['button "Save changes"', 'button "Delete client"', 'link "Order history"', 'link "Log out"',
                          'link "Account"'])
        self.assertIn('button "Save changes"', body["questions"]["operation"]["criteria"]["NEEDS_CHANGE"])

        gw = FakeGateway(decisions=[("DONE", None)])
        self.auto([SHOP], gw, changes=True)
        body = gw.calls[-1]["body"]
        self.assertEqual(len(body["questions"]["click_target"]["criteria"]), 8)
        self.assertNotIn("NEEDS_CHANGE", body["questions"]["operation"]["criteria"])
        self.assertNotIn("withheld_controls", body["state"])

    def test_change_words(self):
        for role, name, href, changes in (
            ("button", "Submit order", "", True), ("button", "Apply filters", "", True), ("button", "Search", "", False),
            ("button", "Show more", "", False), ("menuitem", "Archive", "", True), ("checkbox", "I agree", "", True),
            ("link", "Post a comment", "", True), ("link", "Washington Post", "", False), ("link", "Donate now", "", True),
            ("link", "Settings", "/account/logout", True), ("link", "Read more", "/orders/7/cancel", True),
            ("link", "Cancel culture", "/wiki/Cancel_culture", True), ("option", "The Jungle Book", "", False),
        ):
            with self.subTest(name=name):
                self.assertEqual(ap.changes_something(role, name, href), changes)

    def test_a_goal_that_needs_a_withheld_control_stops_blocked(self):
        message = self.auto_fails([SHOP], FakeGateway(decisions=[("NEEDS_CHANGE", None)]), goal="save the client")
        self.assertTrue(message.startswith("BLOCKED after 1 step, "))
        self.assertIn('needs a control that changes or sends something (button "Save changes"', message)
        self.assertIn('"changes": true', message)

    def test_jev_answers_only_choose_from_the_table(self):
        message = self.auto_fails([WIKI], FakeGateway(decisions=[("CLICK", "999")]))
        self.assertIn("Jev failed (Jev gave no usable answer); nothing was done", message)
        self.assertEqual(self.run_.done, [])


class LoopTests(_Base):
    def test_click_then_done_reports_each_step_and_where_it_ended(self):
        gw = FakeGateway(decisions=[("CLICK", "4"), ("DONE", None)])
        out = self.auto([WIKI, ARTICLE], gw)
        self.assertEqual(self.run_.done, [("click", "e4")])
        second = gw.calls[2]["body"]["state"]
        self.assertEqual(second["recent_actions"], [{"step": 1, "operation": "CLICK", "target": 'link "Eiffel Tower"',
                                                     "outcome": "done; page changed"}])
        self.assertEqual(second["page"]["title"], "Eiffel Tower - Wikipedia")
        lines = out.split("\n")
        self.assertRegex(lines[0], rf"^auto {GOAL}: DONE in 2 steps, \d+\.\ds$")
        self.assertRegex(lines[1], r"^   1\. CLICK: click e4 \(0\.1s\) \(decide \d+ ms, browser \d+ ms\)$")
        self.assertRegex(lines[2], r"^   2\. DONE \(decide \d+ ms, browser \d+ ms\)$")
        self.assertEqual(lines[3], '   now: "Eiffel Tower - Wikipedia" https://en.wikipedia.org/wiki/Eiffel_Tower')
        self.assertRegex(lines[4], r"^   Jev typesafe-ai/jev: 2 decisions, median \d+ ms, max \d+ ms; browser \d+ ms\. "
                                   r"DONE is Jev's judgement")

    def test_blocked_stops_with_the_reason_after_one_wait(self):
        gw = FakeGateway(decisions=[("BLOCKED", None), ("BLOCKED", None)])
        message = self.auto_fails([WIKI], gw)
        self.assertTrue(message.startswith("BLOCKED after 2 steps, "))
        self.assertIn("Jev found no way forward on this page", message)
        self.assertRegex(message, r"1\. WAIT: waited \d+ ms for the page \(decide \d+ ms, browser \d+ ms; Jev said "
                                  r"BLOCKED, so the page gets one wait in case it is still loading\)")
        self.assertIn("2. BLOCKED", message)
        self.assertIn('now: "Wikipedia, the free encyclopedia"', message)
        self.assertEqual(gw.calls[2]["body"]["state"]["recent_actions"][0]["operation"], "WAIT")

    def test_a_page_still_rendering_gets_one_wait_before_blocked(self):
        loading = page("https://demo.test/select", "demo", [["e1", "link", "Home", {"href": "/"}]])
        loaded = page("https://demo.test/select", "demo", [
            ["e1", "link", "Home", {"href": "/"}],
            ["e2", "select", "oldSelectMenu", {"value": "Red", "options": ["Red", "Purple"]}],
        ])
        self.run_ = FakeRun(FakeTab([loading, loaded]), self.tmp.name)
        self.run_.tab.hcx_busy_advances = True
        gw = FakeGateway(decisions=[("BLOCKED", None), ("SELECT", "2:2"), ("DONE", None)])
        out = ap.run_auto(self.run_, {"auto": "pick Purple"}, "pick Purple", post=gw)
        self.assertTrue(out.startswith("auto pick Purple: DONE in 3 steps, "))
        self.assertEqual(self.run_.done, [("select", "e2", "Purple")])

    def test_step_limit_and_hard_cap(self):
        self.assertEqual([ap.step_limit(v) for v in (None, "x", 0, 5, 99)], [15, 15, 1, 5, 30])
        pages = [page(f"https://example.test/{i}", f"Page {i}", [["e1", "link", "Next", {"href": f"/{i + 1}"}]])
                 for i in range(5)]
        message = self.auto_fails(pages, FakeGateway(decisions=[("CLICK", "1")] * 5), goal="reach the end", max=2)
        self.assertTrue(message.startswith("STOPPED after 2 steps, "))
        self.assertIn("reached the step limit (2)", message)
        self.assertEqual(self.run_.done, [("click", "e1"), ("click", "e1")])

    def test_actions_that_change_nothing_stop_the_run(self):
        same = page("https://example.test/", "Same", [["e1", "button", "Nothing happens", {}]])
        message = self.auto_fails([same], FakeGateway(decisions=[("CLICK", "1")] * 5), goal="make something happen")
        self.assertTrue(message.startswith("BLOCKED after 3 steps, "))
        self.assertIn("the last 3 actions changed nothing on the page", message)
        self.assertEqual(len(self.run_.done), 3)

    def test_jev_failing_later_reports_what_was_done(self):
        gw = FakeGateway(decisions=[("CLICK", "4")], fail=pwa_router.JevHTTPError(500, "oops"), fail_at=1)
        message = self.auto_fails([WIKI, ARTICLE], gw)
        self.assertIn("Jev failed (Vercel AI Gateway answered 500) at step 2; do the rest yourself.", message)
        self.assertIn("1. CLICK: click e4", message)
        message = self.auto_fails([WIKI], FakeGateway(fail=TimeoutError("timed out")))
        self.assertIn("Jev failed (Jev took too long); nothing was done", message)

    def test_no_key(self):
        with patch.object(pwa_router, "jev_credentials", lambda: None):
            message = self.auto_fails([WIKI], FakeGateway())
        self.assertIn("no Jev key on this Mac", message)


class TypingTests(_Base):
    def test_type_text_asks_the_small_model_and_types_its_value(self):
        gw = FakeGateway(decisions=[("TYPE_TEXT", "2"), ("SUBMIT_SEARCH", None), ("DONE", None)],
                         texts=['```json\n{"text": "Eiffel Tower"}\n```'])
        out = self.auto([WIKI, ARTICLE], gw)
        self.assertEqual(self.run_.done, [("type", "e2", "Eiffel Tower"), ("press", "Enter")])
        self.assertEqual(gw.urls(), [EVALUATE, EVALUATE, CHAT, CHAT, EVALUATE, EVALUATE])
        text_check, text_call = gw.calls[2]["body"], gw.calls[3]["body"]
        self.assertNotIn("Eiffel", json.dumps(text_check))
        self.assertEqual(text_call["model"], "anthropic/claude-haiku-5.5")
        self.assertEqual(text_call["providerOptions"], ZDR)
        self.assertEqual(text_call["reasoning"], {"enabled": False})
        self.assertEqual(text_call["response_format"], {"type": "json_object"})
        context = json.loads(text_call["messages"][1]["content"])
        self.assertEqual((context["goal"], context["field"]["label"]), (GOAL, "Search Wikipedia"))
        self.assertNotIn("SUBMIT_SEARCH", gw.calls[1]["body"]["questions"]["operation"]["criteria"])
        after = gw.calls[4]["body"]
        self.assertIn("SUBMIT_SEARCH", after["questions"]["operation"]["criteria"])
        self.assertEqual(after["state"]["recent_actions"][0]["text"], "Eiffel Tower")
        self.assertRegex(out, r"1\. TYPE_TEXT: type e2: \"\" -> \"Eiffel Tower\" \(decide \d+ ms, text \d+ ms, browser")
        # A plain search box has no suggestions to wait for.
        self.assertFalse(any(c[0] == "evaluate" and "role=option" in c[1] for c in self.run_.tab.calls))

    def test_typing_into_a_combobox_waits_briefly_for_its_suggestions(self):
        gw = FakeGateway(decisions=[("TYPE_TEXT", "7"), ("DONE", None)], texts=['{"text": "English"}'])
        self.auto([WIKI], gw, goal="set the language to English")
        self.assertEqual(self.run_.done, [("type", "e10", "English")])
        waits = [c[1] for c in self.run_.tab.calls if c[0] == "evaluate" and "role=option" in c[1]]
        self.assertEqual(len(waits), 1)
        self.assertTrue(waits[0].endswith('("e10", 200)'))

    def test_only_a_tiny_json_object_is_ever_typed(self):
        for bad in ("Eiffel Tower", '{"text": "a", "why": "b"}', '{"value": "a"}', '{"text": 5}', '{"text": "  "}',
                    json.dumps({"text": "a" * 1001}), '["Eiffel Tower"]', '{"text": "a\\u0007b"}'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                ap.parse_field_text(bad)
        self.assertIsNone(ap.parse_field_text('{"text": null}'))
        self.assertEqual(ap.parse_field_text(' {"text": " Paris "} '), "Paris")

        message = self.auto_fails([WIKI], FakeGateway(decisions=[("TYPE_TEXT", "2")], texts=["Sure: Eiffel Tower"]))
        self.assertIn("gave no valid value for searchbox \"Search Wikipedia\"", message)
        self.assertIn("nothing typed", message)
        self.assertEqual(self.run_.done, [])

    def test_a_goal_without_the_value_stops_blocked(self):
        message = self.auto_fails([WIKI], FakeGateway(decisions=[("TYPE_TEXT", "2")], texts=['{"text": null}']))
        self.assertTrue(message.startswith("BLOCKED after 1 step, "))
        self.assertIn('the goal does not say what to type into searchbox "Search Wikipedia"', message)
        self.assertEqual(self.run_.done, [])


class ZeroDataRetentionTests(_Base):
    def test_a_refusal_sends_nothing_from_the_page_and_is_remembered(self):
        gw = FakeGateway(decisions=[("DONE", None)], refuse=PLAN_REFUSAL)
        message = self.auto_fails([WIKI], gw)
        self.assertIn("grants zero data retention only on Pro and Enterprise plans (this team is on hobby)", message)
        self.assertIn("nothing from the page was sent to Jev", message)
        self.assertEqual(len(gw.calls), 1)
        self.assertNotIn("Eiffel", json.dumps(gw.calls[0]["body"]))
        self.assertNotIn("Wikipedia", json.dumps(gw.calls[0]["body"]))
        self.auto_fails([WIKI], gw)
        self.assertEqual(len(gw.calls), 1)  # remembered: nothing is asked again for a while

    def test_ask_refused_does_not_read_or_send_the_page(self):
        gw = FakeGateway(texts=["330 m"], refuse=PLAN_REFUSAL)
        with self.assertRaises(cc.ConnectorError) as ctx:
            self.ask("The Eiffel Tower is 330 m tall.", gw)
        self.assertIn("so the page was not sent to anthropic/claude-haiku-5.5. Read the page yourself", str(ctx.exception))
        self.assertEqual(gw.urls(), [CHAT])
        self.assertNotIn("tall", json.dumps(gw.calls[0]["body"]))
        self.assertFalse(any(c[0] == "read" for c in self.run_.tab.calls))

    def test_no_zdr_provider_for_the_text_model(self):
        (Path(self.tmp.name) / "connector.json").write_text(json.dumps({"fast_model": "inception/mercury-3"}))
        with self.assertRaises(cc.ConnectorError) as ctx:
            self.ask("text", FakeGateway(refuse=NO_PROVIDER))
        self.assertIn("has no zero-data-retention provider for inception/mercury-3", str(ctx.exception))

    def test_a_check_that_fails_for_another_reason_is_reported_and_not_remembered(self):
        def broken(url, headers, body, timeout):
            raise pwa_router.JevHTTPError(401, '{"error": "invalid key"}')

        message = self.auto_fails([WIKI], broken)
        self.assertEqual(message, "Vercel AI Gateway refused the key; nothing was done. Do the steps yourself")
        gw = FakeGateway(decisions=[("DONE", None)])
        self.assertTrue(self.auto([WIKI], gw).startswith(f"auto {GOAL}: DONE in 1 step"))
        self.assertEqual(gw.urls(), [EVALUATE, EVALUATE])  # checked again, then asked

    def test_a_flag_that_was_not_applied_counts_as_a_refusal(self):
        message = self.auto_fails([WIKI], FakeGateway(decisions=[("DONE", None)], applied=False))
        self.assertIn("took the zero data retention request for typesafe-ai/jev but did not apply it", message)

    def test_switched_off_for_public_page_measurements(self):
        gw = FakeGateway(decisions=[("DONE", None)])
        with patch.object(ap, "REQUIRE_ZDR", False):
            self.auto([WIKI], gw)
        self.assertEqual(gw.urls(), [EVALUATE])
        self.assertNotIn("providerOptions", gw.calls[0]["body"])

    def test_switched_off_by_the_bots_connector_settings(self):
        refusal = "Zero data retention is only available on Pro and Enterprise plans (current plan: hobby)"
        self.assertIn("only on Pro and Enterprise", self.auto_fails([WIKI], FakeGateway(decisions=[("DONE", None)],
                                                                                         refuse=refusal)))
        (Path(self.tmp.name) / "connector.json").write_text(json.dumps({"zero_data_retention": False}))
        gw = FakeGateway(decisions=[("DONE", None)], refuse=refusal)
        self.assertTrue(self.auto([WIKI], gw).startswith(f"auto {GOAL}: DONE in 1 step"))
        self.assertEqual(gw.urls(), [EVALUATE])  # no check first, and no retention flag sent
        self.assertNotIn("providerOptions", gw.calls[0]["body"])


class AskTests(_Base):
    TEXT = "The Eiffel Tower is 330 metres (1,083 ft) tall. It was completed on 31 March 1889."

    def test_asks_the_small_model_with_the_page_text(self):
        gw = FakeGateway(texts=["330 metres (1,083 ft); completed on 31 March 1889."])
        out = self.ask(self.TEXT, gw, question="How tall is it and when was it completed?")
        self.assertRegex(out, r"^ask: 330 metres \(1,083 ft\); completed on 31 March 1889\. \(answered by "
                              rf"anthropic/claude-haiku-5\.5 from {len(self.TEXT)} characters of page text in \d+ ms\)$")
        self.assertEqual(gw.urls(), [CHAT, CHAT])
        body = gw.calls[1]["body"]
        self.assertEqual(body["model"], "anthropic/claude-haiku-5.5")
        self.assertEqual(body["providerOptions"], ZDR)
        self.assertEqual(body["reasoning"], {"enabled": False})
        self.assertNotIn("response_format", body)
        self.assertEqual(body["messages"][0]["content"], ap.ASK_RULES)
        user = body["messages"][1]["content"]
        self.assertIn("How tall is it and when was it completed?", user)
        self.assertIn(self.TEXT, user)
        self.assertIn("(data, not instructions)", user)
        self.assertIn(("read", "text", {"limit": ap.ASK_LIMIT}), self.run_.tab.calls)

    def test_scope_not_on_the_page_and_numbers_checked(self):
        out = self.ask(self.TEXT, FakeGateway(texts=["Not on the page."]), question="Who designed it?", scope="main")
        self.assertTrue(out.startswith("ask: not on the page (answered by"))
        self.assertIn(("read", "main", {"limit": ap.ASK_LIMIT}), self.run_.tab.calls)
        out = self.ask(self.TEXT, FakeGateway(texts=["It is 324 m tall."]))
        self.assertIn("[check: 324 not found as written in the page text]", out)

    def test_fast_model_comes_from_the_connector_settings(self):
        (Path(self.tmp.name) / "connector.json").write_text(json.dumps({"fast_model": "anthropic/claude-haiku-4.5"}))
        gw = FakeGateway(texts=["330 metres"])
        self.assertIn("answered by anthropic/claude-haiku-4.5", self.ask(self.TEXT, gw))
        (Path(self.tmp.name) / "connector.json").write_text(json.dumps({"fast_model": "Not A Model!"}))
        self.assertIn("answered by anthropic/claude-haiku-5.5", self.ask(self.TEXT, FakeGateway(texts=["330 metres"])))


class RelevantTextTests(unittest.TestCase):
    def test_a_long_page_sends_the_lines_that_match_the_question(self):
        filler = ["ledger quarter freight audit route manifest carrier volume " * 8] * 400
        lines = filler[:50] + ["In March, the Summit depot logged 2,539 pallets."] + filler[50:300] + \
            ["In March, the Harbor depot logged 2,851 pallets."] + filler[300:]
        text = "\n".join(lines)
        self.assertGreater(len(text), ap.ASK_WHOLE)
        out, picked = ap.relevant_text(text, "How many pallets did the Harbor depot log in March?")
        self.assertTrue(picked)
        self.assertIn("Harbor depot logged 2,851", out)
        self.assertLess(len(out), 6000)
        self.assertIn("[...]", out)

    def test_a_value_on_its_own_line_and_a_huge_line_nearby(self):
        filler = "ledger quarter freight audit route manifest carrier volume " * 8
        lines = [filler] * 300 + ["Depot", "Harbor depot", "March", "5,230.00"] + [filler] * 300 + \
            ["Summary: the Harbor depot pallets total for March and every month", "x" * 200000] + [filler] * 50
        out, picked = ap.relevant_text("\n".join(lines), "How many pallets did the Harbor depot log in March?")
        self.assertTrue(picked)
        self.assertIn("5,230.00", out)
        self.assertLess(len(out), ap.ASK_PICKED + 3 * ap.ASK_LINE_CAP)

    def test_short_pages_and_vague_questions_go_whole(self):
        self.assertEqual(ap.relevant_text("short page", "anything?"), ("short page", False))
        text = "\n".join(["ledger quarter freight audit " * 30] * 200)
        self.assertFalse(ap.relevant_text(text, "Summarize this.")[1])


class _Response:
    def __init__(self, status, data):
        self.status = status
        self.data = data
        self.will_close = False

    def read(self):
        return self.data


class _Conn:
    made = []
    drop_next = False

    def __init__(self, host, timeout=None):
        self.host = host
        self.timeout = timeout
        self.sock = None
        self.uses = 0
        self.closed = False
        self.status = 200
        _Conn.made.append(self)

    def request(self, method, path, body=None, headers=None):
        self.uses += 1
        if _Conn.drop_next and self.uses > 1:
            _Conn.drop_next = False
            raise http.client.RemoteDisconnected("closed")
        self.path = path

    def getresponse(self):
        return _Response(self.status, b'{"ok": true}' if self.status < 400 else b'{"error": "nope"}')

    def close(self):
        self.closed = True


class PoolTests(unittest.TestCase):
    def test_connections_are_kept_and_a_dropped_one_is_replaced_once(self):
        _Conn.made = []
        pool = ap._Pool()
        with patch.object(http.client, "HTTPSConnection", _Conn), patch.object(urllib.request, "getproxies", dict):
            self.assertEqual(pool.post(EVALUATE, {}, b"{}", 4.0), {"ok": True})
            self.assertEqual(pool.post(EVALUATE, {}, b"{}", 4.0), {"ok": True})
            self.assertEqual(len(_Conn.made), 1)
            self.assertEqual((_Conn.made[0].host, _Conn.made[0].path, _Conn.made[0].uses), ("ai-gateway.vercel.sh", "/v1/evaluate", 2))
            _Conn.drop_next = True
            self.assertEqual(pool.post(EVALUATE, {}, b"{}", 4.0), {"ok": True})
            self.assertEqual(len(_Conn.made), 2)
            self.assertTrue(_Conn.made[0].closed)
            _Conn.made[1].status = 403
            with self.assertRaises(pwa_router.JevHTTPError) as ctx:
                pool.post(EVALUATE, {}, b"{}", 4.0)
            self.assertEqual((ctx.exception.status, ctx.exception.body), (403, '{"error": "nope"}'))


if __name__ == "__main__":
    unittest.main()
