import base64
import importlib
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import pwa_speech
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")

SAY_VOICES = """\
Albert              en_US    # Hello! My name is Albert.
Ava (Premium)       en_US    # Hello! My name is Ava.
Bad News            en_US    # Hello! My name is Bad News.
Daniel              en_GB    # Hello! My name is Daniel.
Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
Karen               en_AU    # Hello! My name is Karen.
Samantha            en_US    # Hello! My name is Samantha.
Thomas              fr_FR    # Bonjour, je m'appelle Thomas.
Zoe (Enhanced)      en_US    # Hello! My name is Zoe.
not a voice line
"""


class FakeSay:
    """Stands in for ``say``: lists SAY_VOICES and writes a small audio file."""

    def __init__(self, returncode: int = 0, write_audio: bool = True):
        self.calls: list[tuple[list[str], bytes | None]] = []
        self.returncode = returncode
        self.write_audio = write_audio

    def __call__(self, args, input=None, capture_output=False, timeout=None, check=False):
        if args[1:] == ["-v", "?"]:
            return subprocess.CompletedProcess(args, 0, stdout=SAY_VOICES.encode(), stderr=b"")
        self.calls.append((list(args), input))
        if self.write_audio:
            Path(args[args.index("-o") + 1]).write_bytes(b"AAC-AUDIO")
        return subprocess.CompletedProcess(args, self.returncode, stdout=b"", stderr=b"")


class SpeechModuleTests(unittest.TestCase):
    def setUp(self):
        pwa_speech.clear_voice_cache()
        self.addCleanup(pwa_speech.clear_voice_cache)

    def test_parses_names_languages_and_quality(self):
        voices = {v.id: v for v in pwa_speech.parse_voices(SAY_VOICES)}
        self.assertEqual(voices["Ava (Premium)"].name, "Ava")
        self.assertEqual(voices["Ava (Premium)"].quality, "premium")
        self.assertEqual(voices["Ava (Premium)"].lang, "en-US")
        self.assertEqual(voices["Zoe (Enhanced)"].quality, "enhanced")
        self.assertEqual(voices["Eddy (English (UK))"].name, "Eddy")
        self.assertEqual(voices["Eddy (English (UK))"].lang, "en-GB")
        self.assertEqual(voices["Samantha"].quality, "standard")
        self.assertNotIn("not a voice line", voices)

    def test_reading_voices_put_quality_first_and_drop_novelty_voices(self):
        ranked = [v.id for v in pwa_speech.reading_voices(pwa_speech.parse_voices(SAY_VOICES))]
        self.assertEqual(ranked[:3], ["Ava (Premium)", "Zoe (Enhanced)", "Samantha"])
        for left_out in ("Albert", "Bad News", "Eddy (English (UK))", "Thomas"):
            self.assertNotIn(left_out, ranked)
        self.assertIn("Daniel", ranked)

    def test_embedded_speech_commands_and_control_characters_are_neutralized(self):
        cleaned = pwa_speech.clean_for_say("Hi [[rate 400]] there\x07\n\n\n\nnext")
        self.assertNotIn("[[", cleaned)
        self.assertNotIn("]]", cleaned)
        self.assertNotIn("\x07", cleaned)
        self.assertEqual(cleaned, "Hi [ [rate 400] ] there \n\nnext")

    def test_speed_is_clamped(self):
        self.assertEqual(pwa_speech.words_per_minute(1), pwa_speech.BASE_WORDS_PER_MINUTE)
        self.assertEqual(pwa_speech.words_per_minute(10), pwa_speech.MAX_WORDS_PER_MINUTE)
        self.assertEqual(pwa_speech.words_per_minute(0.01), pwa_speech.MIN_WORDS_PER_MINUTE)
        self.assertEqual(pwa_speech.words_per_minute("fast"), pwa_speech.BASE_WORDS_PER_MINUTE)
        self.assertEqual(pwa_speech.words_per_minute(float("nan")), pwa_speech.BASE_WORDS_PER_MINUTE)

    def test_synthesize_sends_text_on_stdin_with_the_best_voice(self):
        fake = FakeSay()
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", fake
        ):
            audio, voice = pwa_speech.synthesize("Client notes for today.", None, 1.2)
        self.assertEqual(audio, b"AAC-AUDIO")
        self.assertEqual(voice, "Ava (Premium)")
        args, stdin = fake.calls[0]
        self.assertEqual(stdin, b"Client notes for today.")
        # The reply text never appears in the process arguments.
        self.assertFalse(any("Client notes" in arg for arg in args))
        self.assertEqual(args[1:3], ["-v", "Ava (Premium)"])
        self.assertIn("-r", args)
        self.assertEqual(args[args.index("-r") + 1], str(pwa_speech.words_per_minute(1.2)))
        self.assertEqual(args[-2:], ["-f", "-"])

    def test_synthesize_refuses_unknown_voices_and_oversized_text(self):
        fake = FakeSay()
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", fake
        ):
            with self.assertRaises(ValueError):
                pwa_speech.synthesize("hello", "-o /tmp/evil", 1)
            with self.assertRaises(ValueError):
                pwa_speech.synthesize("x" * (pwa_speech.MAX_TEXT_CHARS + 1), None, 1)
            with self.assertRaises(ValueError):
                pwa_speech.synthesize("   ", None, 1)
        self.assertEqual(fake.calls, [])

    def test_synthesize_reports_failures(self):
        with patch.object(pwa_speech, "say_binary", return_value=None):
            with self.assertRaises(pwa_speech.SpeechUnavailable):
                pwa_speech.synthesize("hello")
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", FakeSay(returncode=1)
        ):
            with self.assertRaises(pwa_speech.SpeechError):
                pwa_speech.synthesize("hello")


class SpeechRouteTests(unittest.TestCase):
    def setUp(self):
        pwa_speech.clear_voice_cache()
        self.addCleanup(pwa_speech.clear_voice_cache)
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN})
        self.anonymous = TestClient(app)

    def test_routes_require_dashboard_auth(self):
        self.assertEqual(self.anonymous.get("/speech/voices").status_code, 401)
        self.assertEqual(self.anonymous.post("/speech", json={"text": "hi"}).status_code, 401)

    def test_voices_list_best_first_with_a_default(self):
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", FakeSay()
        ):
            response = self.client.get("/speech/voices")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["available"])
        self.assertEqual(body["default"], "Ava (Premium)")
        self.assertEqual(body["voices"][0], {"id": "Ava (Premium)", "name": "Ava", "lang": "en-US", "quality": "premium"})
        self.assertEqual(response.headers["cache-control"], "private, no-store")

    def test_voices_say_unavailable_without_say(self):
        with patch.object(pwa_speech, "say_binary", return_value=None):
            body = self.client.get("/speech/voices").json()
        self.assertEqual(body, {"available": False, "voices": [], "default": None})

    def test_speech_returns_base64_audio(self):
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", FakeSay()
        ):
            response = self.client.post("/speech", json={"text": "Read this.", "voice": "Samantha", "rate": 1})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(base64.b64decode(body["audio"]), b"AAC-AUDIO")
        self.assertEqual(body["mimeType"], "audio/mp4")
        self.assertEqual(body["voice"], "Samantha")

    def test_speech_rejects_bad_requests(self):
        with patch.object(pwa_speech, "say_binary", return_value="/usr/bin/say"), patch.object(
            pwa_speech.subprocess, "run", FakeSay()
        ):
            self.assertEqual(self.client.post("/speech", json={"text": ""}).status_code, 400)
            self.assertEqual(self.client.post("/speech", json={"text": "hi", "voice": 3}).status_code, 400)
            self.assertEqual(self.client.post("/speech", json={"text": "hi", "voice": "Nobody"}).status_code, 400)
            self.assertEqual(self.client.post("/speech", json=["hi"]).status_code, 400)
        with patch.object(pwa_speech, "say_binary", return_value=None):
            self.assertEqual(self.client.post("/speech", json={"text": "hi"}).status_code, 501)

    def test_speech_refuses_cross_site_posts(self):
        response = self.client.post("/speech", json={"text": "hi"}, headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
