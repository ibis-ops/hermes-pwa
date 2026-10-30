import importlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import bot_graph
import pwa_router
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")

ROUTER_ON_TOP = {
    "nodes": {
        "router": {
            "reportsTo": None,
            "canMessage": ["gmail-connector", "manager", "signal-connector"],
            "role": "Front door: answers quick things, hands real work on.",
        },
        "manager": {"reportsTo": "router", "canMessage": ["router"], "role": "Coordinates multi-step jobs across bots."},
        "gmail-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": ""},
        "signal-connector": {"reportsTo": "manager", "canMessage": ["manager"], "role": "Sends Signal messages."},
    }
}
ROUTES = {
    "manager": "Coordinates the other bots for multi-step jobs that span several of them.",
    "gmail-connector": "Reads and sends email in Sean's Gmail.",
    "default": "General work as the main agent.",
}
ON = {"enabled": True, "bot": "router", "jevModel": "", "minConfidence": 0.6}
KEY_NAMES = ("HERMES_PWA_JEV_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY")


def jev_answer(choice, confidence, cost=0.00002):
    """OpenRouter's shape: a confidence next to the probabilities, the cost in usage."""

    def post(url, headers, body, timeout):
        post.calls.append({"url": url, "headers": headers, "body": json.loads(body), "timeout": timeout})
        return {
            "answers": {"route": {"type": "choice", "choice": choice, "confidence": confidence, "probabilities": {choice: confidence}}},
            "usage": {"input_tokens": 400, "output_tokens": 20, "cost": cost},
        }

    post.calls = []
    return post


def vercel_answer(choice, probability, *, refuse_zdr=False, zdr_notes="applied"):
    """Vercel's /v1/evaluate shape: probabilities only, the cost as text in the gateway metadata.

    ``zdr_notes`` is what the routing notes say: "applied" (ZDR when asked, as Vercel documents),
    "ignored" (a plan that lets the flag through without applying it) or "none" (no notes).
    """

    def post(url, headers, body, timeout):
        sent = json.loads(body)
        post.calls.append({"url": url, "headers": headers, "body": sent, "timeout": timeout})
        asked = bool(sent.get("providerOptions", {}).get("gateway", {}).get("zeroDataRetention"))
        if refuse_zdr and asked:
            raise pwa_router.JevHTTPError(
                400,
                '{"error":"No ZDR (Zero Data Retention) providers available for model: typesafe-ai/jev.","type":"no_providers_available","statusCode":400}',
            )
        rest = round(1 - probability, 4)
        routing = {"finalProvider": "typesafe-ai"}
        if zdr_notes != "none":
            routing["planningReasoning"] = (
                "ZDR requested: 1 attempts → 1 ZDR attempts. ZDR execution order: typesafe-ai(system)"
                if asked and zdr_notes == "applied"
                else "System credentials planned for: typesafe-ai"
            )
        return {
            "model": "typesafe-ai/jev",
            "answers": {"route": {"type": "choice", "choice": choice, "probabilities": {choice: probability, "answer" if choice != "answer" else "manager": rest}}},
            "usage": {"inputTokens": 275, "outputTokens": 20},
            "providerMetadata": {"gateway": {"cost": "0.00001155", "routing": routing}},
        }

    post.calls = []
    return post


def failing(status, body=""):
    def post(url, headers, body_bytes, timeout):
        raise pwa_router.JevHTTPError(status, body)

    return post


class TempHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for name in KEY_NAMES:
            os.environ.pop(name, None)
        root = patch.object(bot_graph, "_root_hermes_home", return_value=Path(self.tmp.name))
        root.start()
        self.addCleanup(root.stop)
        bot_graph.forget_seen()
        pwa_router.forget_previous()
        self.addCleanup(bot_graph.forget_seen)
        self.addCleanup(pwa_router.forget_previous)


class SettingsTests(TempHome):
    def test_defaults_until_saved_then_merges(self):
        self.assertEqual(pwa_router.load_settings(), pwa_router.default_settings())
        self.assertFalse(pwa_router.load_settings()["enabled"])
        saved = pwa_router.save_settings({"enabled": True})
        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["bot"], "router")
        pwa_router.save_settings({"bot": "front-door", "minConfidence": 0.75})
        settings = pwa_router.load_settings()
        self.assertEqual((settings["enabled"], settings["bot"], settings["minConfidence"]), (True, "front-door", 0.75))

    def test_refuses_bad_values(self):
        for bad in ("x", {"enabled": "yes"}, {"bot": "Not A Bot"}, {"minConfidence": 2}, {"minConfidence": True}, {"jevModel": "bad model"}):
            with self.subTest(bad=bad), self.assertRaises(pwa_router.RouterSettingsError):
                pwa_router.save_settings(bad)


class CandidateTests(unittest.TestCase):
    def test_team_map_and_delegation_routes_both_apply(self):
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        # signal-connector is on the map but has no delegation route; default has a route but is not on the map.
        self.assertEqual(list(options), ["gmail-connector", "manager"])
        self.assertEqual(options["manager"], "Coordinates multi-step jobs across bots.")
        self.assertEqual(options["gmail-connector"], "Reads and sends email in Sean's Gmail.")

    def test_without_a_map_every_route_is_a_candidate(self):
        self.assertEqual(sorted(pwa_router.candidates("router", None, ROUTES)), ["default", "gmail-connector", "manager"])
        # Profile routes off: the map alone decides.
        self.assertEqual(sorted(pwa_router.candidates("router", ROUTER_ON_TOP, None)), ["gmail-connector", "manager", "signal-connector"])

    def test_bots_on_the_map_without_a_route_are_unreachable(self):
        # Seen on the Mac: Claude Cowork Driver was on the map but not in the router's routes.
        self.assertEqual(pwa_router.unreachable("router", ROUTER_ON_TOP, ROUTES), {"signal-connector": "Sends Signal messages."})
        graph = {"nodes": {**ROUTER_ON_TOP["nodes"], "router": {**ROUTER_ON_TOP["nodes"]["router"], "canMessage": ["claude-cowork-driver", "manager"]}}}
        self.assertEqual(pwa_router.unreachable("router", graph, ROUTES), {"claude-cowork-driver": "The bot called Claude Cowork Driver."})
        # Routes unknown (profile routes off): the map alone decides, so nothing is unreachable.
        self.assertEqual(pwa_router.unreachable("router", ROUTER_ON_TOP, None), {})
        self.assertEqual(pwa_router.unreachable("router", None, ROUTES), {})


class DecideTests(unittest.TestCase):
    def setUp(self):
        pwa_router.forget_previous()

    def test_asks_jev_through_vercel_with_zero_data_retention(self):
        post = vercel_answer("gmail-connector", 0.93)
        decision = pwa_router.decide(
            "Any email from the Kahunas clients today?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
            session_id="s-1", key="vck_test", provider=pwa_router.VERCEL, post=post, now=1000.0,
        )
        self.assertEqual((decision["route"], decision["source"], decision["confidence"]), ("gmail-connector", "jev", 0.93))
        self.assertEqual((decision["provider"], decision["zdr"], decision["cost"]), ("vercel", True, 0.00001155))
        call = post.calls[0]
        self.assertEqual(call["url"], "https://ai-gateway.vercel.sh/v1/evaluate")
        self.assertEqual(call["headers"]["Authorization"], "Bearer vck_test")
        self.assertNotIn("X-Title", call["headers"])
        self.assertEqual(call["body"]["model"], "typesafe-ai/jev")
        self.assertEqual(call["body"]["providerOptions"], {"gateway": {"zeroDataRetention": True}})
        self.assertNotIn("session_id", call["body"])
        self.assertEqual(call["body"]["state"], {"message": "Any email from the Kahunas clients today?"})
        # Signal Connector is on the map without a route: Jev still sees it, so a pick for it is named.
        self.assertEqual(
            sorted(call["body"]["questions"]["route"]["criteria"]), ["answer", "gmail-connector", "manager", "signal-connector"]
        )

    def test_a_plan_without_zero_data_retention_still_routes(self):
        post = vercel_answer("manager", 0.8, refuse_zdr=True)
        decision = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="vck_test", provider=pwa_router.VERCEL, post=post, now=1000.0)
        self.assertEqual((decision["route"], decision["zdr"]), ("manager", False))
        self.assertEqual([("providerOptions" in c["body"]) for c in post.calls], [True, False])
        # Within the hour it asks without zero data retention straight away; after it, tries again.
        again = vercel_answer("manager", 0.8, refuse_zdr=True)
        pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                          key="vck_test", provider=pwa_router.VERCEL, post=again, now=1000.0 + 600)
        self.assertEqual(len(again.calls), 1)
        later = vercel_answer("manager", 0.8)
        result = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                   key="vck_test", provider=pwa_router.VERCEL, post=later,
                                   now=1000.0 + pwa_router.ZDR_RETRY_SECONDS + 100)
        self.assertEqual(result["zdr"], True)

    def test_vercels_own_hobby_answers_from_the_mac(self):
        # Both bodies came back from Vercel for this Mac's key on 27 Oct 2026, on a Hobby team with
        # a card on file and no paid credits.
        zdr_body = (
            '{"error":{"message":"Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. Current plan: '
            'hobby. Please upgrade your plan at https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fsettings%2Fbilling to access '
            'this feature.","type":"permission_denied"}}'
        )
        free_body = (
            '{"error":{"message":"Free tier users do not have access to this model. Upgrade to paid credits at '
            'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up for unrestricted access.",'
            '"type":"no_providers_available"}}'
        )

        def hobby(url, headers, body, timeout):
            sent = json.loads(body)
            hobby.calls.append(sent)
            if sent.get("providerOptions"):
                raise pwa_router.JevHTTPError(403, zdr_body)
            raise pwa_router.JevHTTPError(403, free_body)

        hobby.calls = []
        decision = pwa_router.decide("What is 15% of 2,340?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="vck_test", provider=pwa_router.VERCEL, post=hobby, now=5000.0)
        # The plan's refusal of zero data retention is not the reason: it asked again without it.
        self.assertEqual([("providerOptions" in sent) for sent in hobby.calls], [True, False])
        self.assertEqual((decision["route"], decision["reason"]), (None, "Jev is not in Vercel AI Gateway's free tier"))
        # And the next message goes straight to the question without zero data retention.
        pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="vck_test",
                          provider=pwa_router.VERCEL, post=hobby, now=5060.0)
        self.assertEqual([("providerOptions" in sent) for sent in hobby.calls], [True, False, False])

    def test_zero_data_retention_counts_as_on_only_when_vercel_says_it_applied(self):
        ignored = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="vck_test",
                                    provider=pwa_router.VERCEL, post=vercel_answer("manager", 0.8, zdr_notes="ignored"), now=1000.0)
        self.assertEqual((ignored["route"], ignored["zdr"]), ("manager", False))
        silent = pwa_router.decide("Plan my week", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="vck_test",
                                   provider=pwa_router.VERCEL, post=vercel_answer("manager", 0.8, zdr_notes="none"), now=1000.0)
        self.assertEqual((silent["route"], silent["zdr"]), ("manager", None))

    def test_a_team_with_no_jev_provider_is_named_as_such(self):
        body = '{"error":"No providers available for model: typesafe-ai/jev","type":"no_providers_available","statusCode":403}'
        decision = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="vck_test",
                                     provider=pwa_router.VERCEL, post=failing(403, body), now=1000.0)
        self.assertEqual((decision["route"], decision["reason"]), (None, "Vercel AI Gateway has no Jev provider for this account"))

    def test_asks_jev_through_openrouter_and_follows_a_sure_pick(self):
        post = jev_answer("gmail-connector", 0.91)
        decision = pwa_router.decide(
            "Any email from the Kahunas clients today?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
            session_id="s-1", key="sk-or-test", provider=pwa_router.OPENROUTER, post=post, now=1000.0,
        )
        self.assertEqual((decision["route"], decision["source"], decision["confidence"]), ("gmail-connector", "jev", 0.91))
        call = post.calls[0]
        self.assertEqual(call["url"], "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(call["headers"]["Authorization"], "Bearer sk-or-test")
        self.assertEqual(call["body"]["model"], "~typesafe/jev-latest")
        self.assertEqual(call["body"]["state"], {"message": "Any email from the Kahunas clients today?"})
        question = call["body"]["questions"]["route"]
        self.assertEqual(question["type"], "choice")
        self.assertEqual(sorted(question["criteria"]), ["answer", "gmail-connector", "manager", "signal-connector"])
        self.assertEqual(call["body"]["session_id"], "s-1")
        self.assertNotIn("providerOptions", call["body"])
        self.assertEqual(decision["zdr"], None)

    def test_a_model_from_the_other_service_falls_back_to_its_own_jev(self):
        stale = {**ON, "jevModel": "~typesafe/jev-latest"}
        self.assertEqual(pwa_router.jev_model(pwa_router.VERCEL, stale), "typesafe-ai/jev")
        self.assertEqual(pwa_router.jev_model(pwa_router.OPENROUTER, stale), "~typesafe/jev-latest")
        self.assertEqual(pwa_router.jev_model(pwa_router.VERCEL, {**ON, "jevModel": "typesafe-ai/jev-1.14"}), "typesafe-ai/jev-1.14")
        self.assertEqual(pwa_router.jev_model(pwa_router.OPENROUTER, ON), "~typesafe/jev-latest")

    def test_a_follow_up_carries_the_previous_message_and_where_it_went(self):
        pwa_router.decide("Check my inbox", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, session_id="s-1",
                          key="k", post=jev_answer("gmail-connector", 0.9), now=1000.0)
        post = jev_answer("gmail-connector", 0.8)
        pwa_router.decide("and reply to the first one", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                          session_id="s-1", key="k", post=post, now=1300.0)
        self.assertEqual(post.calls[0]["body"]["state"]["previous_message"], "Check my inbox")
        self.assertEqual(post.calls[0]["body"]["state"]["previous_route"], "gmail-connector")
        # Long after, it is a new topic.
        later = jev_answer("answer", 0.9)
        pwa_router.decide("what is 2+2", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, session_id="s-1",
                          key="k", post=later, now=1300.0 + 3 * 3600)
        self.assertNotIn("previous_message", later.calls[0]["body"]["state"])

    def test_an_unsure_pick_is_a_guess_and_the_router_decides(self):
        decision = pwa_router.decide("hmm", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="k", post=jev_answer("manager", 0.42))
        self.assertEqual((decision["route"], decision["guess"], decision["source"]), (None, "manager", "router"))

    def test_without_a_key_jev_is_not_asked(self):
        decision = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key=None)
        self.assertEqual((decision["route"], decision["source"], decision["reason"]), (None, "router", "no Jev key on the Mac"))

    def test_jev_failures_become_a_reason(self):
        cases = [
            (pwa_router.VERCEL, 401, "", "Vercel AI Gateway refused the key"),
            (pwa_router.VERCEL, 402, "", "Vercel AI Gateway is out of credits"),
            (pwa_router.VERCEL, 403, '{"error":"Insufficient funds: add AI Gateway credits"}', "Vercel AI Gateway is out of credits"),
            (pwa_router.VERCEL, 403, '{"error":"This model is not available on the free tier"}', "Jev is not in Vercel AI Gateway's free tier"),
            (pwa_router.VERCEL, 429, "", "Vercel AI Gateway is rate limiting"),
            # Vercel's answer to a team without a card, as it came back from the Mac on 27 Oct 2026.
            (
                pwa_router.VERCEL,
                403,
                '{"error":{"message":"AI Gateway requires a valid credit card on file to service requests. Please visit '
                'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your '
                'free credits.","type":"customer_verification_required"}}',
                "Vercel AI Gateway needs a card on file",
            ),
            (pwa_router.OPENROUTER, 402, "", "OpenRouter is out of credits"),
            (pwa_router.OPENROUTER, 500, "", "OpenRouter answered 500"),
        ]
        for provider, status, body, reason in cases:
            with self.subTest(provider=provider.name, status=status, body=body):
                decision = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                             provider=provider, post=failing(status, body))
                self.assertEqual((decision["route"], decision["reason"]), (None, reason))

        def timeout(url, headers, body, timeout):
            raise TimeoutError("timed out")

        self.assertEqual(
            pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k", post=timeout)["reason"],
            "Jev took too long",
        )
        # A choice that is not one of the options is not followed, and the reason says so.
        stray = pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                  post=jev_answer("kahunas-connector", 0.99))
        self.assertEqual((stray["route"], stray["reason"]), (None, "Jev gave no usable answer"))

        def not_json(url, headers, body, timeout):
            return json.loads("<html>Bad gateway</html>")

        self.assertEqual(
            pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k", post=not_json)["reason"],
            "Jev gave no usable answer",
        )

        def offline(url, headers, body, timeout):
            raise OSError("nodename nor servname provided")

        self.assertEqual(
            pwa_router.decide("hi", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k", post=offline)["reason"],
            "Jev could not be reached",
        )

    def test_no_one_to_hand_to_means_answer(self):
        decision = pwa_router.decide("hi", bot="router", settings=ON, graph={"nodes": {"router": {"reportsTo": None, "canMessage": [], "role": ""}}}, routes={}, key="k")
        self.assertEqual(decision["route"], "answer")

    def test_a_pick_the_router_cannot_reach_is_named_not_handed_elsewhere(self):
        post = jev_answer("signal-connector", 0.9)
        decision = pwa_router.decide("Anything new on Signal?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="k", post=post)
        self.assertEqual((decision["route"], decision["source"], decision["blocked"], decision["team"]), ("signal-connector", "jev", True, {}))
        self.assertEqual(decision["unreachable"], {"signal-connector": "Sends Signal messages."})
        # Jev reads what it does like any other bot.
        self.assertIn("Sends Signal messages.", post.calls[0]["body"]["questions"]["route"]["criteria"]["signal-connector"])
        # Only bots it cannot reach on the map: the router still answers when there is no one at all.
        alone = {"nodes": {"router": {"reportsTo": None, "canMessage": ["signal-connector"], "role": ""}}}
        only_blocked = pwa_router.decide("Anything new on Signal?", bot="router", settings=ON, graph=alone, routes=ROUTES,
                                         key="k", post=jev_answer("signal-connector", 0.9))
        self.assertEqual((only_blocked["route"], only_blocked["blocked"]), ("signal-connector", True))
        reachable = pwa_router.decide("Any new email?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                      post=jev_answer("gmail-connector", 0.9))
        self.assertFalse(reachable["blocked"])


class DirectiveTests(unittest.TestCase):
    def test_says_what_to_do_for_each_outcome(self):
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        answer = pwa_router.directive("router", {"route": "answer", "source": "jev", "confidence": 0.93, "options": options}, False)
        self.assertIn("picked you to answer it yourself (93% sure)", answer)
        hand = pwa_router.directive("router", {"route": "manager", "source": "jev", "confidence": 0.81, "options": options}, True)
        self.assertIn('Jev picked Manager (@manager) for this (81% sure). Hand it over with delegate_task, profile "manager".', hand)
        # Hermes derives a child's role from its depth and ignores one passed in, so none is asked for.
        self.assertNotIn("orchestrator", hand)
        self.assertIn("The bot does not see this chat", hand)
        self.assertIn("Sean's message in his own words", hand)
        unsure = pwa_router.directive("router", {"route": None, "guess": "manager", "confidence": 0.4, "source": "router", "options": options}, False)
        self.assertIn("best guess Manager (@manager), 40%", unsure)
        self.assertIn("Decide yourself", unsure)
        self.assertIn("Gmail Connector (@gmail-connector): Reads and sends email", unsure)
        self.assertIn("Bots you hand work to cannot hand it on from here", unsure)
        # In Sean's chat the router once delegated with no profile, so the specialist never got the task.
        self.assertIn("Give every task its profile name", unsure)
        # Nor may it borrow another bot's login when a bot lacks one (it did once, from ~/.hermes).
        for text in (hand, unsure):
            self.assertIn("no pointing HERMES_HOME at another bot", text)
        nested = pwa_router.directive("router", {"route": None, "guess": "manager", "confidence": 0.4, "source": "router", "options": options}, True)
        self.assertNotIn("cannot hand it on", nested)
        off = pwa_router.directive("router", {"route": None, "reason": "no Jev key on the Mac", "source": "router", "options": options}, False)
        self.assertIn("Jev did not decide this time (no Jev key on the Mac)", off)
        for text in (answer, hand, unsure, nested, off):
            self.assertNotIn("\u2014", text)

    def test_asks_for_what_sean_asked_and_trusts_the_answer(self):
        # Seen on the Mac: a "just the count" calendar question went out with extra calendars and titles
        # to fetch, and the router reopened bots' logs to recheck answers, slowing every handoff.
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        hand = pwa_router.directive("router", {"route": "gmail-connector", "source": "jev", "confidence": 0.97, "options": options}, False)
        unsure = pwa_router.directive("router", {"route": None, "guess": "manager", "confidence": 0.4, "source": "router", "options": options}, False)
        for text in (hand, unsure):
            self.assertIn("add no extra checks or scope", text)
            self.assertIn('"just the count" means a number', text)
            self.assertIn("do not reopen its log or redo its work to check it", text)
            self.assertIn("say only what its result confirms", text)
            self.assertIn("must read the saved state back after saving", text)
            self.assertIn("Call it done only when that read-back matches", text)
        decision = pwa_router.decide("Plan my week across email and calendar", bot="router", settings=ON, graph=ROUTER_ON_TOP,
                                     routes=ROUTES, key="k", post=jev_answer("manager", 0.95))
        split = pwa_router.directive("router", decision, False)
        self.assertIn("add no extra checks or scope", split)
        self.assertIn("without reopening their logs or redoing their work unless one failed", split)
        self.assertIn("must read the saved state back after saving", split)
        for text in (hand, unsure, split):
            self.assertNotIn("\u2014", text)

    def test_quick_read_only_checks_on_the_mac_are_the_routers_own(self):
        post = jev_answer("answer", 0.9)
        pwa_router.decide("How much free disk space do I have?", bot="router", settings=ON, graph=ROUTER_ON_TOP,
                          routes=ROUTES, key="k", post=post)
        own = post.calls[0]["body"]["questions"]["route"]["criteria"]["answer"]
        self.assertIn("a quick read-only check on the Mac itself (free disk space, a screenshot, what is running)", own)
        self.assertIn("nothing to send, schedule or change", own)

    def test_a_bot_the_router_cannot_reach_is_explained_not_rerouted(self):
        decision = pwa_router.decide("Anything new on Signal?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES,
                                     key="k", post=jev_answer("signal-connector", 0.9))
        text = pwa_router.directive("router", decision, False)
        self.assertIn("Jev picked Signal Connector (@signal-connector) for this (90% sure), but Signal Connector is not in your "
                      "delegation routes, so delegate_task cannot run it.", text)
        self.assertIn("he can add Signal Connector under Router in the phone app", text)
        self.assertIn("Do not give this to a different bot or do it yourself unless Sean says to.", text)
        self.assertNotIn("Hand it over", text)
        self.assertEqual(text.count("delegation routes"), 1)  # no second note about the same bot
        # Every other note names the bots it cannot reach, so a request for one is not quietly rerouted.
        handoff = pwa_router.decide("Any new email?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                    post=jev_answer("gmail-connector", 0.9))
        note = pwa_router.directive("router", handoff, False)
        self.assertIn('profile "gmail-connector"', note)
        self.assertIn("Signal Connector (@signal-connector) is on Sean's team map but not in your delegation routes, so "
                      "delegate_task cannot run it. If Sean asks for it, say so", note)
        two = pwa_router.directive("router", {**handoff, "unreachable": {"signal-connector": "", "claude-cowork-driver": ""}}, False)
        self.assertIn("Signal Connector (@signal-connector) and Claude Cowork Driver (@claude-cowork-driver) are on Sean's team map", two)
        self.assertIn("cannot run them. If Sean asks for one of them", two)
        everyone = pwa_router.directive("router", {**handoff, "unreachable": {}}, False)
        self.assertNotIn("team map", everyone)
        for text_ in (text, note, two):
            self.assertNotIn("\u2014", text_)

    def test_a_team_job_is_split_by_the_router_when_bots_cannot_hand_work_on(self):
        options = pwa_router.candidates("router", ROUTER_ON_TOP, ROUTES)
        # Manager runs Gmail Connector and Signal Connector on the map; the router can reach Gmail Connector.
        self.assertEqual(pwa_router.team_of("manager", ROUTER_ON_TOP, options), {"gmail-connector": "Reads and sends email in Sean's Gmail."})
        self.assertEqual(pwa_router.team_of("gmail-connector", ROUTER_ON_TOP, options), {})
        decision = pwa_router.decide("Plan my week across email and calendar", bot="router", settings=ON, graph=ROUTER_ON_TOP,
                                     routes=ROUTES, key="k", post=jev_answer("manager", 0.95))
        self.assertEqual(decision["team"], {"gmail-connector": "Reads and sends email in Sean's Gmail."})
        split = pwa_router.directive("router", decision, False)
        self.assertIn("Jev picked Manager (@manager) for this (95% sure): a job for Manager's team.", split)
        self.assertIn("do Manager's part yourself", split)
        self.assertIn("one task per bot and all in one call", split)
        self.assertIn("Give every task its profile name", split)
        self.assertIn("tell Sean what it was missing", split)
        self.assertIn("Manager's team: Gmail Connector (@gmail-connector): Reads and sends email in Sean's Gmail.", split)
        self.assertNotIn('profile "manager"', split)
        # With deeper delegation on, Manager runs its own team.
        self.assertIn('Hand it over with delegate_task, profile "manager".', pwa_router.directive("router", decision, True))
        # A bot without a team is a plain handoff either way.
        single = pwa_router.decide("Any new email?", bot="router", settings=ON, graph=ROUTER_ON_TOP, routes=ROUTES, key="k",
                                   post=jev_answer("gmail-connector", 0.97))
        self.assertEqual(single["team"], {})
        self.assertIn('profile "gmail-connector"', pwa_router.directive("router", single, False))


class CredentialTests(TempHome):
    def write_env(self, text):
        (Path(self.tmp.name) / ".env").write_text(text, encoding="utf-8")
        pwa_router.forget_previous()  # the cache keys on the file's stamp, which a fast rewrite can repeat

    def test_reads_the_key_from_hermes_env_and_picks_the_service(self):
        self.assertIsNone(pwa_router.jev_credentials())
        self.write_env("ANTHROPIC_API_KEY=sk-ant-x\nHERMES_PWA_JEV_API_KEY=vck_abc123\n")
        provider, key = pwa_router.jev_credentials()
        self.assertEqual((provider.name, key), ("vercel", "vck_abc123"))
        # A copied env line and quotes are cleaned off; an OpenRouter key is told apart by its prefix.
        self.write_env('HERMES_PWA_JEV_API_KEY="AI_GATEWAY_API_KEY=vck_line"\n')
        self.assertEqual(pwa_router.jev_credentials()[1], "vck_line")
        self.write_env("export HERMES_PWA_JEV_API_KEY='sk-or-v1-abc'\n")
        self.assertEqual(pwa_router.jev_credentials()[0].name, "openrouter")

    def test_the_env_file_wins_and_hermes_keys_are_the_fallback(self):
        with patch.dict(os.environ, {"HERMES_PWA_JEV_API_KEY": "vck_old"}):
            self.write_env("HERMES_PWA_JEV_API_KEY=vck_new\n")
            self.assertEqual(pwa_router.jev_credentials()[1], "vck_new")
        self.write_env("AI_GATEWAY_API_KEY=vck_hermes\n")
        self.assertEqual([*map(lambda x: getattr(x, "name", x), pwa_router.jev_credentials())], ["vercel", "vck_hermes"])
        self.write_env("OPENROUTER_API_KEY=sk-or-hermes\nHERMES_PWA_JEV_API_KEY=op://vault/item/key\n")
        self.assertEqual(pwa_router.jev_credentials()[0].name, "openrouter")

    def test_status_says_which_service_without_the_key(self):
        self.assertEqual(pwa_router.status()["keyConfigured"], False)
        self.assertIsNone(pwa_router.status()["provider"])
        self.write_env("HERMES_PWA_JEV_API_KEY=vck_secret_value\n")
        status = pwa_router.status()
        self.assertEqual((status["keyConfigured"], status["provider"], status["keyName"]), (True, "Vercel AI Gateway", "HERMES_PWA_JEV_API_KEY"))
        self.assertNotIn("vck_secret_value", json.dumps(status))

    def test_status_lists_bots_on_an_older_copy_with_the_fix(self):
        self.assertEqual((pwa_router.status()["staleBots"], pwa_router.status()["updateCommand"]), ([], ""))
        with patch.object(pwa_router.plugin_copies, "stale_bots", return_value=["manager", "gmail-connector"]):
            status = pwa_router.status()
        self.assertEqual(status["staleBots"], ["manager", "gmail-connector"])
        self.assertEqual(
            status["updateCommand"],
            'for bot in manager gmail-connector; do hermes -p "$bot" plugins update hermes-pwa; done',
        )


class ReachTests(TempHome):
    def write(self, relative, text):
        path = Path(self.tmp.name) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_status_lists_the_bots_the_router_cannot_reach_with_a_first_draft_of_their_line(self):
        self.assertEqual(pwa_router.status()["unreachable"], [])
        pwa_router.save_settings({"enabled": True, "bot": "router"})
        graph = {"nodes": {
            "router": {"reportsTo": None, "canMessage": ["claude-cowork-driver", "gmail-connector", "signal-connector"], "role": ""},
            "claude-cowork-driver": {"reportsTo": "router", "canMessage": [], "role": ""},
            "gmail-connector": {"reportsTo": "router", "canMessage": [], "role": ""},
            "signal-connector": {"reportsTo": "router", "canMessage": [], "role": "Reads Signal chats."},
        }}
        bot_graph.save(graph)
        self.write(
            "profiles/router/config.yaml",
            "delegation:\n  backend: profile_routes\n  backends:\n    profile_routes:\n      profiles:\n"
            "        - name: gmail-connector\n          description: Reads email.\n",
        )
        self.write(
            "profiles/claude-cowork-driver/SOUL.md",
            "# Claude Cowork\n\n**Role:** Claude Cowork\n**Mission:** connect to claude cowork and claude code.\n\nYou are...\n",
        )
        self.assertEqual(
            pwa_router.status()["unreachable"],
            [
                {"name": "claude-cowork-driver", "suggestion": "Connect to claude cowork and claude code"},
                # Its role on the map comes first.
                {"name": "signal-connector", "suggestion": "Reads Signal chats."},
            ],
        )
        # Once the routes include them, none is left.
        self.write(
            "profiles/router/config.yaml",
            "delegation:\n  backend: profile_routes\n  backends:\n    profile_routes:\n      profiles:\n"
            "        - name: gmail-connector\n        - name: claude-cowork-driver\n        - name: signal-connector\n",
        )
        self.assertEqual(pwa_router.status()["unreachable"], [])

    def test_soul_mission_reads_only_the_mission_line(self):
        self.write("profiles/kahunas-connector/SOUL.md", "Mission: " + "pulls coaching data " * 30 + "\n")
        line = pwa_router.soul_mission("kahunas-connector")
        self.assertTrue(line.startswith("Pulls coaching data"))
        self.assertLessEqual(len(line), pwa_router.MAX_SUGGESTION_CHARS)
        self.write("profiles/manager/SOUL.md", "# Manager\nCoordinates the team.\n")
        self.assertEqual(pwa_router.soul_mission("manager"), "")
        self.assertEqual(pwa_router.soul_mission("nobody-here"), "")
        self.assertEqual(pwa_router.soul_mission("../etc"), "")


class HookAndLogTests(TempHome):
    def hook(self, message, session="s-1", **kwargs):
        with patch.object(pwa_router, "delegation_routes", return_value=(ROUTES, False)):
            return pwa_router.hook_context(session, message, bot=kwargs.pop("bot", "router"), **kwargs)

    def test_off_until_turned_on_and_only_for_the_router(self):
        bot_graph.save(ROUTER_ON_TOP)
        self.assertIsNone(self.hook("hello"))
        pwa_router.save_settings({"enabled": True})
        self.assertIn("Jev did not decide this time", self.hook("hello"))
        self.assertIsNone(self.hook("hello", bot="manager"))
        self.assertIsNone(self.hook("hello", parent_session_id="parent"))
        self.assertIsNone(self.hook("[Background process notification] job 4 finished"))
        self.assertIsNone(self.hook("   "))

    def test_a_key_added_later_works_without_a_restart(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        self.assertIn("no Jev key on the Mac", self.hook("hello"))
        (Path(self.tmp.name) / ".env").write_text("HERMES_PWA_JEV_API_KEY=vck_test\n", encoding="utf-8")
        post = vercel_answer("answer", 0.97)
        self.assertIn("picked you to answer it yourself (97% sure)", self.hook("what is 15% of 2340?", post=post))
        self.assertEqual(post.calls[0]["headers"]["Authorization"], "Bearer vck_test")
        self.assertEqual((pwa_router.recent()[0]["provider"], pwa_router.recent()[0]["zdr"]), ("vercel", True))

    def test_logs_each_decision_without_the_message(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["OPENROUTER_API_KEY"] = "sk-or-test"
        self.addCleanup(os.environ.pop, "OPENROUTER_API_KEY", None)
        message = "Please check my inbox for anything from the Kahunas clients about Friday and draft replies"
        text = self.hook(message, post=jev_answer("gmail-connector", 0.88))
        self.assertIn("Jev picked Gmail Connector (@gmail-connector)", text)
        self.hook("2+2?", session="s-2", post=jev_answer("answer", 0.97))
        newest = pwa_router.recent()
        self.assertEqual([d["route"] for d in newest], ["answer", "gmail-connector"])
        entry = pwa_router.recent(session_id="s-1")[0]
        self.assertEqual(entry["key"], pwa_router.text_key(message))
        self.assertTrue(entry["preview"].endswith("…"))
        self.assertLessEqual(len(entry["preview"]), pwa_router.PREVIEW_CHARS)
        self.assertEqual((entry["source"], entry["confidence"], entry["sessionId"]), ("jev", 0.88, "s-1"))
        raw = pwa_router.decisions_path().read_text(encoding="utf-8")
        self.assertNotIn("draft replies", raw)
        self.assertEqual(oct(pwa_router.decisions_path().stat().st_mode & 0o777), "0o600")

    def test_a_message_with_a_picture_sends_jev_only_its_words(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["AI_GATEWAY_API_KEY"] = "vck_test"
        self.addCleanup(os.environ.pop, "AI_GATEWAY_API_KEY", None)
        picture = "data:image/png;base64," + "iVBORw0KGgo" * 400
        parts = [
            {"type": "text", "text": "What is in this photo?"},
            {"type": "image_url", "image_url": {"url": picture}},
            {"type": "text", "text": "Keep it short."},
        ]
        post = vercel_answer("answer", 0.95)
        self.assertIn("picked you to answer it yourself", self.hook(parts, post=post))
        sent = post.calls[0]["body"]
        self.assertEqual(sent["state"]["message"], "What is in this photo?\nKeep it short.")
        self.assertNotIn("base64", json.dumps(sent))
        self.assertEqual(pwa_router.recent()[0]["key"], pwa_router.text_key("What is in this photo?\nKeep it short."))
        # Only pictures, no words: nothing to route on.
        self.assertIsNone(self.hook([{"type": "image_url", "image_url": {"url": picture}}], post=post))
        self.assertEqual(len(post.calls), 1)

    def test_a_follow_up_after_a_restart_still_carries_the_earlier_message(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["AI_GATEWAY_API_KEY"] = "vck_test"
        self.addCleanup(os.environ.pop, "AI_GATEWAY_API_KEY", None)
        self.hook("Check my inbox for anything from Friday", post=vercel_answer("gmail-connector", 0.95))
        pwa_router.forget_previous()  # a gateway restart: nothing is left in memory
        history = [
            {"role": "user", "content": "Check my inbox for anything from Friday\n\n[Router note from Sean's phone app, for this message only.] Jev picked Gmail Connector"},
            {"role": "assistant", "content": "Two emails came in on Friday."},
            {"role": "user", "content": "and Saturday?"},
        ]
        post = vercel_answer("gmail-connector", 0.9)
        self.assertIn("Jev picked Gmail Connector", self.hook("and Saturday?", post=post, history=history))
        state = post.calls[0]["body"]["state"]
        self.assertEqual((state["previous_message"], state["previous_route"]), ("Check my inbox for anything from Friday", "gmail-connector"))
        # Another chat has no earlier message of its own.
        other = vercel_answer("answer", 0.9)
        self.hook("hello", session="s-9", post=other, history=[{"role": "user", "content": "hello"}])
        self.assertNotIn("previous_message", other.calls[0]["body"]["state"])

    def test_logs_a_pick_the_router_cannot_reach(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["AI_GATEWAY_API_KEY"] = "vck_test"
        self.addCleanup(os.environ.pop, "AI_GATEWAY_API_KEY", None)
        self.assertIn("cannot run it", self.hook("Anything new on Signal?", post=vercel_answer("signal-connector", 0.92)))
        entry = pwa_router.recent()[0]
        self.assertEqual((entry["route"], entry["blocked"], entry["split"]), ("signal-connector", True, False))
        self.hook("Any new email?", session="s-2", post=vercel_answer("gmail-connector", 0.96))
        self.assertFalse(pwa_router.recent()[0]["blocked"])

    def test_logs_when_the_router_splits_a_team_job(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        os.environ["AI_GATEWAY_API_KEY"] = "vck_test"
        self.addCleanup(os.environ.pop, "AI_GATEWAY_API_KEY", None)
        text = self.hook("Plan my week across email and calendar", post=vercel_answer("manager", 0.96))
        self.assertIn("a job for Manager's team", text)
        self.assertEqual((pwa_router.recent()[0]["route"], pwa_router.recent()[0]["split"]), ("manager", True))
        self.hook("Any new email?", session="s-2", post=vercel_answer("gmail-connector", 0.96))
        self.assertEqual((pwa_router.recent()[0]["route"], pwa_router.recent()[0]["split"]), ("gmail-connector", False))

    def test_earlier_message_reads_the_chat_before_this_turn(self):
        history = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "[Background process notification] job 4 finished"},
            {"role": "user", "content": [{"type": "text", "text": "second"}, {"type": "image_url", "image_url": {"url": "data:,"}}]},
            {"role": "user", "content": "now"},
        ]
        self.assertEqual(pwa_router.earlier_message(history, "now"), "second")
        self.assertEqual(pwa_router.earlier_message(history[:-1], "now"), "second")  # this turn not in it yet
        self.assertEqual(pwa_router.earlier_message(history[:2], "first"), "")
        self.assertEqual(pwa_router.earlier_message(None, "now"), "")

    def test_message_text_keeps_only_text_parts(self):
        self.assertEqual(pwa_router.message_text("plain"), "plain")
        self.assertEqual(pwa_router.message_text([{"type": "input_text", "text": "a"}, "b", {"text": "c"}, {"type": "file", "text": "x"}]), "a\nb\nc")
        self.assertEqual(pwa_router.message_text(None), "")
        self.assertEqual(pwa_router.message_text({"type": "text", "text": "solo"}), "solo")

    def test_log_keeps_the_newest(self):
        with patch.object(pwa_router, "LOG_KEEP", 3):
            for i in range(5):
                pwa_router.record({"route": "answer", "source": "jev"}, bot="router", session_id="s", message=f"m{i}")
        self.assertEqual([d["preview"] for d in pwa_router.recent()], ["m4", "m3", "m2"])

    def test_text_key_matches_the_app(self):
        # The phone app computes the same fingerprint (packages/web/src/lib/routerDecisions.test.ts).
        self.assertEqual(pwa_router.text_key("  Hello   world \n"), "594d29c7")
        self.assertEqual(pwa_router.text_key("Draft an email to Kahunas clients about Friday’s check-ins \U0001F680"), "28d37499")


class RouteTests(TempHome):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.anonymous = TestClient(app)

    def test_requires_dashboard_auth(self):
        self.assertIn(self.anonymous.get("/router").status_code, (401, 403))
        self.assertIn(self.anonymous.put("/router", json={"enabled": True}).status_code, (401, 403))
        self.assertIn(self.anonymous.get("/router/decisions").status_code, (401, 403))

    def test_status_save_and_decisions(self):
        body = self.client.get("/router").json()
        self.assertEqual(body["settings"]["enabled"], False)
        self.assertEqual(body["keyConfigured"], False)
        self.assertEqual(body["decisions"], [])
        saved = self.client.put("/router", json={"enabled": True, "bot": "router"})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["settings"]["enabled"])
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}):
            body = self.client.get("/router").json()
            self.assertEqual((body["keyConfigured"], body["provider"]), (True, "OpenRouter"))
        bad = self.client.put("/router", json={"minConfidence": 5})
        self.assertEqual(bad.status_code, 400)
        pwa_router.record({"route": "manager", "source": "jev", "confidence": 0.8}, bot="router", session_id="s-1", message="plan my week")
        pwa_router.record({"route": "answer", "source": "jev", "confidence": 0.9}, bot="router", session_id="s-2", message="hi")
        only = self.client.get("/router/decisions", params={"session_id": "s-1"}).json()["decisions"]
        self.assertEqual([d["route"] for d in only], ["manager"])
        self.assertEqual(len(self.client.get("/router").json()["decisions"]), 2)

    def write_profile_config(self, bot, text):
        folder = Path(self.tmp.name) / "profiles" / bot
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "config.yaml").write_text(text, encoding="utf-8")

    def test_try_a_message_asks_jev_with_the_routers_own_routes_and_logs_nothing(self):
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True, "bot": "router"})
        # The router bot's own config, as the dashboard (running as the default bot) reads it.
        self.write_profile_config(
            "router",
            "delegation:\n  backend: profile_routes\n  backends:\n    profile_routes:\n      profiles:\n"
            "        - name: manager\n          description: Coordinates the other bots.\n"
            "        - name: gmail-connector\n          description: Reads and sends email in Sean's Gmail.\n",
        )
        (Path(self.tmp.name) / ".env").write_text("HERMES_PWA_JEV_API_KEY=vck_test\n", encoding="utf-8")
        post = vercel_answer("manager", 0.96)
        with patch.object(pwa_router, "_post_json", post):
            response = self.client.post("/router/try", json={"message": "Plan my week across email and calendar"})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result["route"], result["source"], result["split"], result["team"]), ("manager", "jev", True, ["gmail-connector"]))
        self.assertEqual(
            sorted(post.calls[0]["body"]["questions"]["route"]["criteria"]), ["answer", "gmail-connector", "manager", "signal-connector"]
        )
        self.assertFalse(result["blocked"])
        self.assertEqual(pwa_router.recent(), [])  # nothing logged
        self.assertEqual(self.client.post("/router/try", json={"message": "   "}).status_code, 400)
        self.assertIn(self.anonymous.post("/router/try", json={"message": "hi"}).status_code, (401, 403))
        cross = self.client.post("/router/try", json={"message": "hi"}, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(cross.status_code, 403)

    def test_try_without_a_key_says_so(self):
        pwa_router.save_settings({"enabled": True, "bot": "router"})
        self.write_profile_config(
            "router",
            "delegation:\n  backend: profile_routes\n  backends:\n    profile_routes:\n      profiles:\n"
            "        - name: gmail-connector\n          description: Reads email.\n",
        )
        result = self.client.post("/router/try", json={"message": "hi"}).json()
        self.assertEqual((result["route"], result["reason"]), (None, "no Jev key on the Mac"))


class RuntimeHookTests(TempHome):
    def test_pre_llm_call_adds_the_team_map_and_the_router_note(self):
        root = Path(__file__).resolve().parents[2]
        module_name = "hermes_pwa_router_runtime_test"
        for key in [k for k in sys.modules if k == module_name or k.startswith(f"{module_name}.")]:
            sys.modules.pop(key, None)
        spec = importlib.util.spec_from_file_location(module_name, root / "__init__.py", submodule_search_locations=[str(root)])
        runtime = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = runtime
        spec.loader.exec_module(runtime)
        graph_module = sys.modules[f"{module_name}.bot_graph"]
        router_module = sys.modules[f"{module_name}.pwa_router"]
        bot_graph.save(ROUTER_ON_TOP)
        pwa_router.save_settings({"enabled": True})
        post = jev_answer("manager", 0.86)
        with patch.object(graph_module, "_root_hermes_home", return_value=Path(self.tmp.name)), patch.object(
            graph_module, "_current_bot", return_value="router"
        ), patch.object(router_module, "delegation_routes", return_value=(ROUTES, True)), patch.object(
            router_module, "_post_json", post
        ), patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}):
            first = runtime._on_pre_llm_call(session_id="s-1", user_message="Plan my week across email and calendar")["context"]
            self.assertIn("You are Router (@router).", first)
            self.assertIn('Jev picked Manager (@manager) for this (86% sure). Hand it over with delegate_task, profile "manager".', first)
            second = runtime._on_pre_llm_call(session_id="s-1", user_message="thanks")["context"]
            self.assertNotIn("You are Router", second)
            self.assertIn("Jev picked Manager", second)
            # Hermes passes a message with a picture as a list of parts; Jev gets the words only.
            third = runtime._on_pre_llm_call(
                session_id="s-1",
                user_message=[{"type": "text", "text": "Who is this from?"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}],
            )["context"]
            self.assertIn("Jev picked Manager", third)
            self.assertEqual(post.calls[-1]["body"]["state"]["message"], "Who is this from?")
            # The chat history Hermes passes reaches the router as the earlier message.
            runtime._on_pre_llm_call(
                session_id="s-1",
                user_message="and the one before?",
                conversation_history=[{"role": "user", "content": "Who is this from?"}, {"role": "assistant", "content": "Kim."}],
            )
            self.assertEqual(post.calls[-1]["body"]["state"]["previous_message"], "Who is this from?")
            # A delegated child of the router is left alone.
            self.assertIsNone(runtime._on_pre_llm_call(session_id="c-1", parent_session_id="s-1", user_message="do it"))


if __name__ == "__main__":
    unittest.main()
