import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from push_common import (
    approval_push_payload,
    claim_push_dedupe,
    clear_pending_approval,
    endpoint_hash,
    load_pending_approvals,
    load_push_subscriptions,
    record_pending_approval,
    safe_subscription_record,
    sanitize_error_text,
    sanitize_notification_text,
    turn_complete_push_payload,
    upsert_push_subscription,
    validate_browser_subscription,
    send_web_push_record,
    send_web_push_to_enabled,
)


def _subscription(endpoint: str = "https://push.example/sub/1"):
    return {"endpoint": endpoint, "keys": {"p256dh": "p256", "auth": "auth"}}


_ENV = {"HERMES_PWA_PUSH_ALLOW_ANY_ENDPOINT": "1"}


def setUpModule():
    os.environ.update(_ENV)


def tearDownModule():
    for key in _ENV:
        os.environ.pop(key, None)


class PushCommonTests(unittest.TestCase):
    def test_missing_or_corrupt_subscription_file_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.json"
            self.assertEqual(load_push_subscriptions(missing), [])

            corrupt = Path(tmp) / "corrupt.json"
            corrupt.write_text("not-json", encoding="utf-8")
            self.assertEqual(load_push_subscriptions(corrupt), [])

    def test_validate_subscription_requires_endpoint_and_keys(self):
        with self.assertRaisesRegex(ValueError, "endpoint"):
            validate_browser_subscription({"keys": {"p256dh": "p", "auth": "a"}})
        with self.assertRaisesRegex(ValueError, "p256dh"):
            validate_browser_subscription({"endpoint": "https://push.example/sub", "keys": {"auth": "a"}})
        with self.assertRaisesRegex(ValueError, "auth"):
            validate_browser_subscription({"endpoint": "https://push.example/sub", "keys": {"p256dh": "p"}})

    def test_upsert_subscription_roundtrip_and_safe_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "push_subscriptions.json"
            first = upsert_push_subscription(_subscription(), profile="default", label="iPhone", path=path)
            second = upsert_push_subscription(_subscription(), profile="default", label="iPhone updated", path=path)

            records = load_push_subscriptions(path)
            self.assertEqual(len(records), 1)
            self.assertEqual(first["id"], endpoint_hash("https://push.example/sub/1"))
            self.assertEqual(second["id"], endpoint_hash("https://push.example/sub/1"))
            self.assertEqual(second["label"], "iPhone updated")
            self.assertNotIn("endpoint", second)
            self.assertNotIn("keys", second)
            self.assertEqual(records[0]["endpoint"], "https://push.example/sub/1")

    def test_safe_subscription_record_never_exposes_endpoint_or_keys(self):
        safe = safe_subscription_record({**_subscription(), "profile": "default", "enabled": True})
        self.assertTrue(safe["id"].startswith("sha256:"))
        self.assertNotIn("endpoint", safe)
        self.assertNotIn("keys", safe)

    def test_sanitize_notification_text_strips_controls_truncates_and_redacts(self):
        text = sanitize_notification_text("hello\npassword=supersecret token:abc world", limit=32)
        self.assertNotIn("\n", text)
        self.assertNotIn("supersecret", text)
        self.assertNotIn("abc", text)
        self.assertLessEqual(len(text), 32)

    def test_sanitize_error_text_redacts_bare_tokens_after_urls(self):
        bare_hex = "0123456789abcdef0123456789abcdef"
        bare_b64url = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-TOKEN"
        text = sanitize_error_text(
            f"failed https://push.example/sub/{bare_hex} body {bare_hex} auth {bare_b64url} short abc123",
            limit=240,
        )
        self.assertIn("[redacted-url]", text)
        self.assertNotIn("https://push.example", text)
        self.assertNotIn(bare_hex, text)
        self.assertNotIn(bare_b64url, text)
        self.assertIn("short abc123", text)

    def test_sanitize_error_text_still_redacts_key_value_and_limits(self):
        text = sanitize_error_text("token=abc123 " + "x" * 500, limit=48)
        self.assertNotIn("abc123", text)
        self.assertLessEqual(len(text), 48)

    def test_approval_push_payload_is_safe_and_routes_to_approvals(self):
        payload = approval_push_payload(
            description="Run dangerous command password=secret with long details" * 10,
            session_key="telegram:123",
            turn_id="turn-1",
            tool_call_id="tool-1",
        )
        self.assertEqual(payload["type"], "approval.request")
        self.assertEqual(payload["title"], "Hermes needs approval")
        self.assertEqual(payload["url"], "./index.html#/approvals")
        self.assertEqual(payload["tag"], "approval:telegram:123:turn-1:tool-1")
        self.assertEqual(payload["session_id"], "telegram:123")
        self.assertTrue(payload["approval_id"].startswith("approval:"))
        self.assertNotIn("secret", payload["body"].lower())
        self.assertLessEqual(len(payload["body"]), 180)

    def test_pending_approval_roundtrip_is_safe_and_profile_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pending_approvals.json"
            with patch("push_common.pending_approvals_path", return_value=path):
                record = record_pending_approval(
                    session_key="telegram:123",
                    command="rm -rf /tmp/example password=secret",
                    description="delete in temp",
                    pattern_key="rm-rf",
                    profile="default",
                )
                self.assertEqual(record["kind"], "approval")
                self.assertEqual(record["session_id"], "telegram:123")
                self.assertNotIn("secret", record["summary"])

                self.assertEqual(len(load_pending_approvals(profile="default")), 1)
                self.assertEqual(load_pending_approvals(profile="dev"), [])

                removed = clear_pending_approval(
                    session_key="telegram:123",
                    command="rm -rf /tmp/example password=secret",
                    pattern_key="rm-rf",
                )
                self.assertEqual(removed, 1)
                self.assertEqual(load_pending_approvals(profile="default"), [])

    def test_profiled_pending_approval_load_prunes_expired_records_without_dropping_other_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pending_approvals.json"
            path.write_text(
                json.dumps(
                    [
                        {"id": "old-default", "profile": "default", "created_at": 1},
                        {"id": "old-dev", "profile": "dev", "created_at": 1},
                        {"id": "new-default", "profile": "default", "created_at": 9999},
                        {"id": "new-dev", "profile": "dev", "created_at": 9999},
                    ]
                ),
                encoding="utf-8",
            )

            with patch("push_common.now_ts", return_value=10000):
                active = load_pending_approvals(profile="default", max_age_seconds=330, path=path)

            self.assertEqual([item["id"] for item in active], ["new-default"])
            kept = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in kept], ["new-default", "new-dev"])

    def test_turn_complete_push_payload_is_safe_and_session_tagged(self):
        payload = turn_complete_push_payload(
            session_id="live-session-1",
            turn_id="turn-1",
            assistant_response="Sensitive answer password=secret with details that must not be shown",
        )
        self.assertEqual(payload["type"], "turn.complete")
        self.assertEqual(payload["title"], "Hermes replied")
        self.assertEqual(payload["body"], "Answer ready.")
        self.assertEqual(payload["tag"], "hermes-turn:live-session-1")
        self.assertEqual(payload["dedupe_key"], "turn:live-session-1:turn-1")
        self.assertEqual(payload["url"], "./index.html#/chat")
        self.assertNotIn("Sensitive", payload["body"])
        self.assertNotIn("secret", payload["body"].lower())

    def test_claim_push_dedupe_allows_once_and_prunes_old_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            self.assertTrue(claim_push_dedupe("turn:s:1", ttl_seconds=60, path=path))
            self.assertFalse(claim_push_dedupe("turn:s:1", ttl_seconds=60, path=path))
            self.assertTrue(claim_push_dedupe("turn:s:2", ttl_seconds=60, path=path))

    def test_send_web_push_record_passes_raw_vapid_private_key(self):
        webpush = Mock()
        fake_module = types.SimpleNamespace(webpush=webpush)
        with patch.dict(sys.modules, {"pywebpush": fake_module}):
            with patch.dict(
                os.environ,
                {
                    "HERMES_PWA_VAPID_PRIVATE_KEY": "raw-base64url-private-key",
                    "HERMES_PWA_VAPID_SUBJECT": "mailto:test@example.com",
                },
                clear=False,
            ):
                send_web_push_record(_subscription(), {"title": "test"})

        kwargs = webpush.call_args.kwargs
        self.assertEqual(kwargs["vapid_private_key"], "raw-base64url-private-key")
        self.assertEqual(kwargs["vapid_claims"], {"sub": "mailto:test@example.com"})

    def test_send_web_push_to_enabled_skips_duplicate_endpoint_records(self):
        duplicate_records = [
            {**_subscription("https://push.example/sub/dupe"), "id": endpoint_hash("https://push.example/sub/dupe"), "profile": "default", "enabled": True},
            {**_subscription("https://push.example/sub/dupe"), "id": endpoint_hash("https://push.example/sub/dupe"), "profile": "default", "enabled": True},
            {**_subscription("https://push.example/sub/other"), "id": endpoint_hash("https://push.example/sub/other"), "profile": "default", "enabled": True},
        ]
        with patch("push_common.push_sender_availability", return_value=(True, None)):
            with patch("push_common.load_push_subscriptions", return_value=duplicate_records):
                with patch("push_common.save_push_subscriptions"):
                    with patch("push_common.send_web_push_record") as send:
                        sent = send_web_push_to_enabled({"title": "test"}, profile="default")

        self.assertEqual(sent, 2)
        self.assertEqual(send.call_count, 2)

    def test_send_web_push_to_enabled_is_profile_exact(self):
        records = [
            {**_subscription("https://push.example/sub/default"), "id": endpoint_hash("https://push.example/sub/default"), "profile": "default", "enabled": True},
            {**_subscription("https://push.example/sub/work"), "id": endpoint_hash("https://push.example/sub/work"), "profile": "work", "enabled": True},
            {**_subscription("https://push.example/sub/dev"), "id": endpoint_hash("https://push.example/sub/dev"), "profile": "dev", "enabled": True},
            {**_subscription("https://push.example/sub/legacy"), "id": endpoint_hash("https://push.example/sub/legacy"), "enabled": True},
        ]
        with patch("push_common.push_sender_availability", return_value=(True, None)):
            with patch("push_common.load_push_subscriptions", return_value=records):
                with patch("push_common.save_push_subscriptions"):
                    with patch("push_common.send_web_push_record") as send:
                        sent = send_web_push_to_enabled({"title": "test"}, profile="work")

        self.assertEqual(sent, 1)
        self.assertEqual(send.call_args.args[0]["profile"], "work")

    def test_send_web_push_to_enabled_falls_back_to_every_device_for_an_unsubscribed_profile(self):
        records = [
            {**_subscription("https://push.example/sub/default"), "id": endpoint_hash("https://push.example/sub/default"), "profile": "default", "enabled": True},
            {**_subscription("https://push.example/sub/default"), "id": endpoint_hash("https://push.example/sub/default"), "profile": "work", "enabled": True},
            {**_subscription("https://push.example/sub/off"), "id": endpoint_hash("https://push.example/sub/off"), "profile": "default", "enabled": False},
        ]
        with patch("push_common.push_sender_availability", return_value=(True, None)):
            with patch("push_common.load_push_subscriptions", return_value=records):
                with patch("push_common.save_push_subscriptions"):
                    with patch("push_common.send_web_push_record") as send:
                        sent = send_web_push_to_enabled({"title": "test"}, profile="manager")
                        strict = send_web_push_to_enabled({"title": "test"}, profile="manager", fallback_to_any=False)

        # One phone, two profile rows, same endpoint: the bot's turn reaches it once.
        self.assertEqual(sent, 1)
        self.assertEqual(strict, 0)
        self.assertEqual(send.call_count, 1)

    def test_send_web_push_to_enabled_defaults_to_default_profile_only(self):
        records = [
            {**_subscription("https://push.example/sub/default"), "id": endpoint_hash("https://push.example/sub/default"), "profile": "default", "enabled": True},
            {**_subscription("https://push.example/sub/work"), "id": endpoint_hash("https://push.example/sub/work"), "profile": "work", "enabled": True},
            {**_subscription("https://push.example/sub/legacy"), "id": endpoint_hash("https://push.example/sub/legacy"), "enabled": True},
        ]
        with patch("push_common.push_sender_availability", return_value=(True, None)):
            with patch("push_common.load_push_subscriptions", return_value=records):
                with patch("push_common.save_push_subscriptions"):
                    with patch("push_common.send_web_push_record") as send:
                        sent = send_web_push_to_enabled({"title": "test"})

        self.assertEqual(sent, 2)
        self.assertEqual([call.args[0].get("profile", "default") for call in send.call_args_list], ["default", "default"])

    def test_send_web_push_to_enabled_sanitizes_errors_and_disables_gone_endpoint(self):
        class Response:
            status_code = 410

        class PushGone(Exception):
            response = Response()

        records = [
            {**_subscription("https://push.example/sub/dead-secret-token"), "id": endpoint_hash("https://push.example/sub/dead-secret-token"), "profile": "default", "enabled": True},
        ]
        captured_records = []

        def save(records_arg):
            captured_records.extend(records_arg)

        with patch("push_common.push_sender_availability", return_value=(True, None)):
            with patch("push_common.load_push_subscriptions", return_value=records):
                with patch("push_common.save_push_subscriptions", side_effect=save):
                    with patch("push_common.send_web_push_record", side_effect=PushGone("410 Gone https://push.example/sub/dead-secret-token token=abc")):
                        sent = send_web_push_to_enabled({"title": "test"}, profile="default")

        self.assertEqual(sent, 0)
        self.assertFalse(captured_records[0]["enabled"])
        self.assertNotIn("https://push.example", captured_records[0]["last_error"])
        self.assertNotIn("abc", captured_records[0]["last_error"])
        safe = safe_subscription_record(captured_records[0])
        self.assertNotIn("https://push.example", safe["last_error"])
        self.assertNotIn("abc", safe["last_error"])


if __name__ == "__main__":
    unittest.main()
