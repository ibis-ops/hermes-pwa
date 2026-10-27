"""Read-aloud audio for the phone, made on the Mac with macOS's own voices.

A web app on iPhone only gets Apple's compact voices through the Web Speech
API; the downloadable Premium and Enhanced voices are kept from websites. The
Mac's ``say`` can use any voice installed there, Premium neural voices
included, and it runs on the machine itself: reply text never goes to a
speech service. The phone asks for one short piece of a reply at a time and
plays it while the next piece is made.

Nothing here reads or writes Hermes configuration. Hosts without ``say``
(Linux, or a Mac without it on PATH) report speech as unavailable, and the
phone falls back to its own voice.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass

# One request carries one piece of a reply; the phone cuts longer text up.
MAX_TEXT_CHARS = 2000
# ``say -r`` is in words per minute. The phone sends a speed multiplier.
BASE_WORDS_PER_MINUTE = 185
MIN_WORDS_PER_MINUTE = 100
MAX_WORDS_PER_MINUTE = 360
SYNTH_TIMEOUT_SECONDS = 60
VOICE_LIST_TIMEOUT_SECONDS = 10
VOICE_CACHE_SECONDS = 300
# A Premium voice keeps a core busy; two at a time leaves the Mac responsive.
MAX_CONCURRENT_SYNTH = 2
SLOT_WAIT_SECONDS = 30

# Sound effects and character voices: never offered for reading replies.
_NOVELTY_VOICES = frozenset({
    "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "deranged", "good news",
    "hysterical", "jester", "organ", "pipe organ", "princess", "superstar", "trinoids", "whisper",
    "wobble", "zarvox", "fred", "junior", "kathy", "ralph",
})
# The Eloquence voices (a 1990s screen-reader engine): clear, but robotic.
_ELOQUENCE_VOICES = frozenset({"eddy", "flo", "grandma", "grandpa", "reed", "rocko", "sandy", "shelley"})
# Voices that read long passages well, best first, within a quality tier.
_PREFERRED_NAMES = (
    "ava", "zoe", "evan", "nathan", "noelle", "joelle", "jamie", "samantha", "allison", "susan",
    "tom", "serena", "daniel", "karen", "moira", "tessa", "rishi",
)
_QUALITY_RANK = {"premium": 0, "enhanced": 1, "standard": 2}

# ``say -v '?'``: "Name   lang   # sample". Names may hold spaces and nested
# parentheses ("Eddy (English (UK))"); the language code is the last field
# before the sample.
_VOICE_LINE = re.compile(r"^(?P<name>\S.*?)\s+(?P<lang>[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})+)\s+#")
_QUALITY_SUFFIX = re.compile(r"\s*\((premium|enhanced)\)\s*$", re.IGNORECASE)
_LANGUAGE_SUFFIX = re.compile(r"\s*\([^()]*(?:\([^()]*\))?[^()]*\)\s*$")
# Control characters other than tab and newline.
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class SpeechUnavailable(Exception):
    """This host cannot make speech (no ``say``)."""


class SpeechBusy(Exception):
    """Every synthesis slot stayed taken for too long."""


class SpeechError(Exception):
    """``say`` ran and failed, or wrote nothing."""


@dataclass(frozen=True)
class Voice:
    id: str
    """The exact name ``say -v`` takes."""
    name: str
    """The name to show, without the quality or language suffix."""
    lang: str
    """BCP 47, e.g. ``en-US``."""
    quality: str
    """``premium``, ``enhanced`` or ``standard``."""

    def as_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "lang": self.lang, "quality": self.quality}


def say_binary() -> str | None:
    """The ``say`` executable on a Mac, else None."""
    if sys.platform != "darwin":
        return None
    return shutil.which("say")


def available() -> bool:
    return say_binary() is not None


def parse_voices(output: str) -> list[Voice]:
    """The voices ``say -v '?'`` lists, in its order."""
    voices: list[Voice] = []
    seen: set[str] = set()
    for line in output.splitlines():
        match = _VOICE_LINE.match(line.rstrip())
        if not match:
            continue
        voice_id = match.group("name").strip()
        if not voice_id or voice_id in seen:
            continue
        seen.add(voice_id)
        quality_match = _QUALITY_SUFFIX.search(voice_id)
        quality = quality_match.group(1).lower() if quality_match else "standard"
        name = _QUALITY_SUFFIX.sub("", voice_id)
        name = _LANGUAGE_SUFFIX.sub("", name).strip() or voice_id
        lang = match.group("lang").replace("_", "-")
        voices.append(Voice(id=voice_id, name=name, lang=lang, quality=quality))
    return voices


def is_reading_voice(voice: Voice) -> bool:
    """False for sound effects, character voices and the Eloquence set."""
    base = voice.name.lower()
    return base not in _NOVELTY_VOICES and base not in _ELOQUENCE_VOICES


def _rank(voice: Voice, preferred_lang: str) -> tuple[int, int, int, str]:
    lang = voice.lang.lower()
    wanted = preferred_lang.lower()
    lang_rank = 0 if lang == wanted else 1 if lang.split("-")[0] == wanted.split("-")[0] else 2
    base = voice.name.lower()
    name_rank = _PREFERRED_NAMES.index(base) if base in _PREFERRED_NAMES else len(_PREFERRED_NAMES)
    return (_QUALITY_RANK.get(voice.quality, 3), lang_rank, name_rank, voice.id.lower())


def reading_voices(voices: list[Voice], preferred_lang: str = "en-US") -> list[Voice]:
    """Voices fit for reading replies in the preferred language, best first.

    Quality leads: a Premium voice in another English accent beats a
    standard one in the exact locale.
    """
    base = preferred_lang.split("-")[0].lower()
    fit = [v for v in voices if is_reading_voice(v) and v.lang.split("-")[0].lower() == base]
    return sorted(fit, key=lambda v: _rank(v, preferred_lang))


_voice_cache: tuple[float, list[Voice]] | None = None
_voice_cache_lock = threading.Lock()


def list_voices(force: bool = False, now: float | None = None) -> list[Voice]:
    """Every voice installed on this Mac, cached for a few minutes."""
    global _voice_cache
    binary = say_binary()
    if not binary:
        raise SpeechUnavailable("say is not available on this host")
    current = time.monotonic() if now is None else now
    with _voice_cache_lock:
        if not force and _voice_cache and current - _voice_cache[0] < VOICE_CACHE_SECONDS:
            return list(_voice_cache[1])
    try:
        proc = subprocess.run(
            [binary, "-v", "?"],
            capture_output=True,
            timeout=VOICE_LIST_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SpeechError("could not list voices") from exc
    if proc.returncode != 0:
        raise SpeechError("could not list voices")
    voices = parse_voices(proc.stdout.decode("utf-8", "replace"))
    with _voice_cache_lock:
        _voice_cache = (current, voices)
    return list(voices)


def clear_voice_cache() -> None:
    global _voice_cache
    with _voice_cache_lock:
        _voice_cache = None


def clean_for_say(text: str) -> str:
    """Text as ``say`` should get it.

    ``[[...]]`` is the speech synthesizer's embedded command syntax (rate,
    volume, input mode); text from a reply must never steer the voice, so the
    brackets are broken up. Control characters go, whitespace collapses.
    """
    cleaned = _CONTROL.sub(" ", text)
    cleaned = cleaned.replace("[[", "[ [").replace("]]", "] ]")
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def words_per_minute(rate: object) -> int:
    """The phone's speed multiplier (1 is normal) as ``say -r`` words per minute."""
    try:
        multiplier = float(rate)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        multiplier = 1.0
    if multiplier != multiplier or multiplier <= 0:  # NaN or nonsense
        multiplier = 1.0
    wpm = round(BASE_WORDS_PER_MINUTE * multiplier)
    return max(MIN_WORDS_PER_MINUTE, min(MAX_WORDS_PER_MINUTE, wpm))


_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SYNTH)


def synthesize(text: str, voice_id: str | None = None, rate: object = 1.0) -> tuple[bytes, str]:
    """AAC audio (an .m4a file's bytes) of ``text``, and the voice that read it.

    ``voice_id`` must be one of this Mac's voices; None picks the best
    English reading voice installed. The text goes to ``say`` on stdin, so
    it never appears in the process list.
    """
    binary = say_binary()
    if not binary:
        raise SpeechUnavailable("say is not available on this host")
    spoken = clean_for_say(text if isinstance(text, str) else "")
    if not spoken:
        raise ValueError("there is no text to read")
    if len(spoken) > MAX_TEXT_CHARS:
        raise ValueError(f"text is longer than {MAX_TEXT_CHARS} characters")
    voices = list_voices()
    if voice_id:
        if voice_id not in {v.id for v in voices}:
            raise ValueError("that voice is not installed on this Mac")
        chosen: str | None = voice_id
    else:
        ranked = reading_voices(voices)
        chosen = ranked[0].id if ranked else None
    if not _slots.acquire(timeout=SLOT_WAIT_SECONDS):
        raise SpeechBusy("speech is busy")
    try:
        with tempfile.TemporaryDirectory(prefix="hermes-pwa-say-") as tmp:
            out_path = os.path.join(tmp, "speech.m4a")
            args = [binary]
            if chosen:
                args += ["-v", chosen]
            args += [
                "-r", str(words_per_minute(rate)),
                "--file-format=m4af",
                "--data-format=aac",
                "-o", out_path,
                "-f", "-",
            ]
            try:
                proc = subprocess.run(
                    args,
                    input=spoken.encode("utf-8"),
                    capture_output=True,
                    timeout=SYNTH_TIMEOUT_SECONDS,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise SpeechError("speech failed") from exc
            if proc.returncode != 0 or not os.path.isfile(out_path):
                raise SpeechError("speech failed")
            with open(out_path, "rb") as fh:
                audio = fh.read()
    finally:
        _slots.release()
    if not audio:
        raise SpeechError("speech produced no audio")
    return audio, chosen or ""
