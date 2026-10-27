import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


_RUNTIME_ROOT = Path(__file__).resolve().parents[2]


def _load_runtime_module():
    module_name = "hermes_pwa_runtime_test"
    sys.modules.pop(module_name, None)
    sys.modules.pop(f"{module_name}.push_common", None)
    spec = importlib.util.spec_from_file_location(
        module_name,
        _RUNTIME_ROOT / "__init__.py",
        submodule_search_locations=[str(_RUNTIME_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load runtime plugin module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class RuntimeHookTests(unittest.TestCase):
    def test_registers_approval_and_turn_complete_hooks(self):
        runtime = _load_runtime_module()
        calls = []

        class Ctx:
            def register_hook(self, name, callback):
                calls.append((name, callback.__name__))

        runtime.register(Ctx())

        self.assertEqual(
            calls,
            [
                ("pre_approval_request", "_on_pre_approval_request"),
                ("post_approval_response", "_on_post_approval_response"),
                ("post_llm_call", "_on_post_llm_call"),
            ],
        )

    def test_approval_hook_dedupes_duplicate_hook_delivery(self):
        runtime = _load_runtime_module()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"HERMES_HOME": tmp}, clear=False):
                with patch.object(runtime, "send_web_push_to_enabled", return_value=1) as send:
                    kwargs = {
                        "session_key": "gateway-session-1",
                        "command": "rm -rf /tmp/example",
                        "description": "Dangerous command approval required",
                        "pattern_key": "rm-rf",
                        "surface": "gateway",
                        "request_id": "req-7",
                    }
                    runtime._on_pre_approval_request(**kwargs)
                    runtime._on_pre_approval_request(**kwargs)
                    self.assertTrue(runtime._push_worker.flush())

                pending_path = Path(tmp) / "plugins" / "hermes-pwa" / "pending_approvals.json"
                records = json.loads(pending_path.read_text(encoding="utf-8"))

        self.assertEqual(send.call_count, 1)
        payload = send.call_args.args[0]
        self.assertEqual(payload["type"], "approval.request")
        self.assertEqual([record["request_id"] for record in records], ["req-7"])

    def test_approval_hook_returns_before_the_push_is_sent(self):
        runtime = _load_runtime_module()
        release = threading.Event()
        started = threading.Event()

        def slow_send(payload, profile=None):
            started.set()
            release.wait(timeout=10)
            return 1

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"HERMES_HOME": tmp}, clear=False):
                with patch.object(runtime, "send_web_push_to_enabled", side_effect=slow_send) as send:
                    before = time.monotonic()
                    runtime._on_pre_approval_request(
                        session_key="gateway-session-2",
                        command="rm -rf /tmp/example",
                        description="Dangerous command approval required",
                        pattern_key="rm-rf",
                        surface="gateway",
                    )
                    elapsed = time.monotonic() - before
                    # The record and the dedupe claim are written before the hook returns.
                    pending_path = Path(tmp) / "plugins" / "hermes-pwa" / "pending_approvals.json"
                    self.assertTrue(pending_path.exists())
                    self.assertTrue(started.wait(timeout=5))
                    self.assertFalse(runtime._push_worker.flush(timeout=0.2))
                    release.set()
                    self.assertTrue(runtime._push_worker.flush())

        self.assertLess(elapsed, 2.0)
        self.assertEqual(send.call_count, 1)
        self.assertTrue(runtime._push_worker._thread.daemon)

    def test_approval_hook_ignores_cli_surface(self):
        runtime = _load_runtime_module()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"HERMES_HOME": tmp}, clear=False):
                with patch.object(runtime, "send_web_push_to_enabled", return_value=1) as send:
                    runtime._on_pre_approval_request(
                        session_key="local-cli-session",
                        command="rm -rf /tmp/example",
                        description="Dangerous command approval required",
                        pattern_key="rm-rf",
                        surface="cli",
                    )
                    self.assertTrue(runtime._push_worker.flush())

                pending_path = Path(tmp) / "plugins" / "hermes-pwa" / "pending_approvals.json"
                self.assertFalse(pending_path.exists())

        self.assertEqual(send.call_count, 0)

    def test_approval_hook_ignores_telegram_origin(self):
        runtime = _load_runtime_module()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"HERMES_HOME": tmp}, clear=False):
                with patch.object(runtime, "send_web_push_to_enabled", return_value=1) as send:
                    runtime._on_pre_approval_request(
                        session_key="agent:main:telegram:dm:5326786243",
                        command="rm -rf /tmp/example",
                        description="Dangerous command approval required",
                        pattern_key="rm-rf",
                        surface="gateway",
                    )
                    runtime._on_pre_approval_request(
                        session_key="desktop-session",
                        platform="telegram",
                        command="rm -rf /tmp/example",
                        description="Dangerous command approval required",
                        pattern_key="rm-rf",
                        surface="gateway",
                    )
                    self.assertTrue(runtime._push_worker.flush())

                pending_path = Path(tmp) / "plugins" / "hermes-pwa" / "pending_approvals.json"
                self.assertFalse(pending_path.exists())

        self.assertEqual(send.call_count, 0)

    def test_turn_complete_hook_sends_once_for_tui_turns_only(self):
        runtime = _load_runtime_module()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {"HERMES_HOME": tmp}, clear=False):
                with patch.object(runtime, "send_web_push_to_enabled", return_value=1) as send:
                    runtime._on_post_llm_call(
                        platform="tui",
                        session_id="live-1",
                        turn_id="turn-1",
                        assistant_response="done",
                    )
                    runtime._on_post_llm_call(
                        platform="tui",
                        session_id="live-1",
                        turn_id="turn-1",
                        assistant_response="done",
                    )
                    runtime._on_post_llm_call(
                        platform="tui",
                        session_id="live-1",
                        turn_id="turn-2",
                        assistant_response="second internal turn done",
                    )
                    runtime._on_post_llm_call(
                        platform="telegram",
                        session_id="live-2",
                        turn_id="turn-2",
                        assistant_response="done",
                    )
                    runtime._on_post_llm_call(
                        platform="tui",
                        session_id="live-3",
                        turn_id="turn-3",
                        assistant_response="",
                    )
                    self.assertTrue(runtime._push_worker.flush())

        self.assertEqual(send.call_count, 1)
        payload = send.call_args.args[0]
        self.assertEqual(payload["type"], "turn.complete")
        self.assertEqual(payload["tag"], "hermes-turn:live-1")
        self.assertEqual(payload["body"], "Answer ready.")


if __name__ == "__main__":
    unittest.main()
