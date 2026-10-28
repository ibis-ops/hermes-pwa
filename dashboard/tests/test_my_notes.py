import hashlib
import importlib
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import my_notes
from dashboard.plugin_api import router

_web_server = importlib.import_module("hermes_cli.web_server")
_SESSION_HEADER_NAME = getattr(_web_server, "_SESSION_HEADER_NAME")
_SESSION_TOKEN = getattr(_web_server, "_SESSION_TOKEN")
AUTH = {_SESSION_HEADER_NAME: _SESSION_TOKEN}
BASE = "/api/plugins/hermes-pwa/obsidian/my-notes"


class _Vaults(unittest.TestCase):
    """A home with two vaults (General open, Archive not) and nothing else: every test runs in a temp dir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.vault = self.home / "Desktop" / "General"
        (self.vault / ".obsidian").mkdir(parents=True)
        self.archive = self.home / "Documents" / "Archive"
        self.archive.mkdir(parents=True)
        self.outside = self.home / "outside"
        self.outside.mkdir()
        self.folder = self.vault / my_notes.NOTES_FOLDER
        self._registry({self.vault: True, self.archive: False})
        self.env = patch.dict(
            os.environ,
            {
                "HERMES_PWA_OBSIDIAN_HOME": str(self.home),
                "HERMES_PWA_OBSIDIAN_VAULTS": "",
                "HERMES_PWA_OBSIDIAN_PHONE_VAULT": "",
                "HERMES_PWA_NOTES_VAULT": "",
            },
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def _registry(self, vaults):
        registry = self.home / "Library" / "Application Support" / "obsidian"
        registry.mkdir(parents=True, exist_ok=True)
        entries = {f"id{index}": {"path": str(path), "open": is_open} for index, (path, is_open) in enumerate(vaults.items())}
        registry.joinpath("obsidian.json").write_text(json.dumps({"vaults": entries}), encoding="utf-8")

    def _note(self, name, text="", mtime=None, folder=None):
        path = (folder or self.folder) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def _folder_names(self):
        return sorted(os.listdir(self.folder))

    def assertRefused(self, status, call, *args, **kwargs):
        with self.assertRaises(my_notes.NotesError) as ctx:
            call(*args, **kwargs)
        self.assertEqual(ctx.exception.status, status, ctx.exception.detail)
        return ctx.exception


class VaultChoiceTests(_Vaults):
    def test_the_open_vault_until_a_vault_has_the_folder(self):
        place = my_notes.choose_vault(self.home)
        self.assertEqual((place.vault.name, place.chosen_by), ("General", "open"))
        self.assertEqual(place.folder, os.path.join(os.path.realpath(self.vault), "Notes from Sean"))
        # A vault that already has the folder wins, open or not.
        (self.archive / "Notes from Sean").mkdir()
        place = my_notes.choose_vault(self.home)
        self.assertEqual((place.vault.name, place.chosen_by), ("Archive", "folder"))
        # With both, the open vault comes first.
        self.folder.mkdir()
        self.assertEqual(my_notes.choose_vault(self.home).vault.name, "General")

    def test_a_link_named_like_the_folder_does_not_pick_a_vault(self):
        (self.archive / "Notes from Sean").symlink_to(self.outside, target_is_directory=True)
        place = my_notes.choose_vault(self.home)
        self.assertEqual((place.vault.name, place.chosen_by), ("General", "open"))

    def test_with_no_vault_open_the_first_by_name(self):
        self._registry({self.vault: False, self.archive: False})
        place = my_notes.choose_vault(self.home)
        self.assertEqual((place.vault.name, place.chosen_by), ("Archive", "first"))

    def test_the_setting_names_a_vault_by_name_or_path_and_never_falls_back(self):
        (self.vault / "Notes from Sean").mkdir()
        with patch.dict(os.environ, {"HERMES_PWA_NOTES_VAULT": "Archive"}):
            self.assertEqual(my_notes.choose_vault(self.home).chosen_by, "setting")
            self.assertEqual(my_notes.choose_vault(self.home).vault.name, "Archive")
        with patch.dict(os.environ, {"HERMES_PWA_NOTES_VAULT": str(self.archive) + "/"}):
            self.assertEqual(my_notes.choose_vault(self.home).vault.name, "Archive")
        with patch.dict(os.environ, {"HERMES_PWA_NOTES_VAULT": "Nope"}):
            error = self.assertRefused(404, my_notes.choose_vault, self.home)
            self.assertIn("HERMES_PWA_NOTES_VAULT", error.detail)
            self.assertEqual(error.reason, "bad_setting")
            listing = my_notes.list_notes(home=self.home)
            self.assertFalse(listing["available"])
            self.assertIn("HERMES_PWA_NOTES_VAULT", listing["error"])
            self.assertEqual(listing["reason"], "bad_setting")
            self.assertRefused(404, my_notes.create_note, "Gym ideas", "x", home=self.home)
        self.assertEqual(self._folder_names(), [])
        self.assertFalse((self.archive / "Notes from Sean").exists())

    def test_no_vault_at_all(self):
        self._registry({})
        listing = my_notes.list_notes(home=self.home, now=1.0)
        self.assertEqual(
            listing,
            {
                "available": False,
                "vault": None,
                "phone_vault": None,
                "chosen_by": None,
                "folder": "Notes from Sean",
                "exists": False,
                "notes": [],
                "total": 0,
                "scanned_at": 1.0,
                "max_bytes": my_notes.MAX_NOTE_BYTES,
                "error": "no Obsidian vault was found on this Mac",
                "reason": "no_vault",
            },
        )


class ListTests(_Vaults):
    def test_before_the_first_save_the_folder_does_not_exist(self):
        listing = my_notes.list_notes(home=self.home)
        self.assertTrue(listing["available"])
        self.assertFalse(listing["exists"])
        self.assertEqual((listing["vault"], listing["chosen_by"], listing["notes"]), ("General", "open", []))
        self.assertFalse(self.folder.exists())

    def test_newest_first_with_a_preview_and_only_notes(self):
        t0 = 1_790_000_000.0
        self._note("Gym ideas.md", "# Gym ideas\n\nLeg day: **squats**, [[Deadlift plan|deadlifts]]\n", t0 - 100)
        self._note("Groceries.md", "---\ntags: [list]\nsource: phone\n---\n- [ ] Milk\n- [x] Eggs\n", t0 - 10)
        self._note("Empty.md", "", t0 - 50)
        self._note("Plan.md", "```\ncode first\n```\n---\n> A quote with a [link](https://example.com)\n", t0 - 70)
        # Not notes in this folder: hidden files, a save in progress, other files, subfolders, links.
        self._note(".hidden.md", "x", t0)
        self._note(".hermes-note-0123.tmp", "x", t0)
        self._note("photo.png", b"\x89PNG", t0)
        self._note("Inner.md", "x", t0, folder=self.folder / "Sub")
        (self.folder / "Folder.md").mkdir()
        secret = self.outside / "secret.md"
        secret.write_text("private", encoding="utf-8")
        (self.folder / "Link.md").symlink_to(secret)

        listing = my_notes.list_notes(home=self.home, now=t0)
        self.assertTrue(listing["exists"])
        self.assertEqual(listing["total"], 4)
        self.assertEqual(listing["scanned_at"], t0)
        self.assertEqual(
            [(n["name"], n["title"], n["preview"]) for n in listing["notes"]],
            [
                ("Groceries.md", "Groceries", "Milk"),
                ("Empty.md", "Empty", ""),
                ("Plan.md", "Plan", "code first"),
                ("Gym ideas.md", "Gym ideas", "Leg day: squats, deadlifts"),
            ],
        )
        first = listing["notes"][0]
        self.assertEqual(first["path"], "Notes from Sean/Groceries.md")
        self.assertEqual(first["modified_at"], t0 - 10)
        self.assertEqual(first["size"], len("---\ntags: [list]\nsource: phone\n---\n- [ ] Milk\n- [x] Eggs\n"))
        self.assertEqual(my_notes.list_notes(home=self.home, limit=2)["total"], 4)
        self.assertEqual(len(my_notes.list_notes(home=self.home, limit=2)["notes"]), 2)

    def test_preview_is_one_short_line(self):
        long_line = "word " * 80
        self._note("Long.md", f"{long_line}\nsecond")
        preview = my_notes.list_notes(home=self.home)["notes"][0]["preview"]
        self.assertEqual(len(preview), my_notes.PREVIEW_CHARS)
        self.assertTrue(preview.endswith(chr(0x2026)))
        self.assertEqual(my_notes.preview_of("---\nunterminated: true\n", "x"), "")
        self.assertEqual(my_notes.preview_of("Plan the trip\nBook flights", "Plan the trip"), "Book flights")
        # The first line is skipped only when it is the title again, numbered or cut from a long line.
        self.assertEqual(my_notes.preview_of("# Plan the trip\nBook flights", "Plan the trip 1"), "Book flights")
        self.assertEqual(my_notes.preview_of("Gym ideas for Monday\nSquats", "Gym"), "Gym ideas for Monday")
        cut = "Remember to call the physio about the knee and book the next"
        self.assertEqual(my_notes.preview_of(f"{cut} three sessions\nBefore Friday", cut), "Before Friday")

    def test_a_link_in_place_of_the_folder_is_refused(self):
        self.folder.symlink_to(self.outside, target_is_directory=True)
        (self.outside / "secret.md").write_text("private", encoding="utf-8")
        listing = my_notes.list_notes(home=self.home)
        self.assertTrue(listing["available"])
        self.assertEqual(listing["notes"], [])
        self.assertIn("not a plain folder", listing["error"])
        self.assertEqual(listing["reason"], "not_allowed")
        self.assertRefused(403, my_notes.read_note, "secret.md", home=self.home)
        self.assertRefused(403, my_notes.create_note, "New", "x", home=self.home)
        self.assertEqual(sorted(os.listdir(self.outside)), ["secret.md"])


class CreateTests(_Vaults):
    def test_creates_the_folder_and_a_readable_file_name(self):
        note = my_notes.create_note("Gym ideas", "Leg day\n\nSquats", home=self.home)
        self.assertTrue(self.folder.is_dir())
        self.assertEqual((self.folder / "Gym ideas.md").read_bytes(), b"Leg day\n\nSquats")
        self.assertEqual(
            {key: note[key] for key in ("vault", "folder", "name", "title", "path", "text", "size", "editable")},
            {
                "vault": "General",
                "folder": "Notes from Sean",
                "name": "Gym ideas.md",
                "title": "Gym ideas",
                "path": "Notes from Sean/Gym ideas.md",
                "text": "Leg day\n\nSquats",
                "size": 15,
                "editable": True,
            },
        )
        self.assertEqual(note["version"], hashlib.sha256(b"Leg day\n\nSquats").hexdigest())
        self.assertEqual(note["modified_at"], os.stat(self.folder / "Gym ideas.md").st_mtime)

    def test_never_replaces_a_note(self):
        my_notes.create_note("Gym ideas", "first", home=self.home)
        second = my_notes.create_note("Gym ideas", "second", home=self.home)
        third = my_notes.create_note("gym IDEAS", "third", home=self.home)
        self.assertEqual([second["name"], third["name"]], ["Gym ideas 1.md", "gym IDEAS 2.md"])
        self.assertEqual((self.folder / "Gym ideas.md").read_text(encoding="utf-8"), "first")
        self.assertEqual(self._folder_names(), ["Gym ideas 1.md", "Gym ideas.md", "gym IDEAS 2.md"])

    def test_a_name_taken_between_the_check_and_the_write_is_not_replaced(self):
        self._note("Gym ideas.md", "on the Mac")
        with patch.object(my_notes.os, "listdir", return_value=[]):
            note = my_notes.create_note("Gym ideas", "from the phone", home=self.home)
        self.assertEqual(note["name"], "Gym ideas 1.md")
        self.assertEqual((self.folder / "Gym ideas.md").read_text(encoding="utf-8"), "on the Mac")

    def test_titles_become_safe_names_inside_the_folder(self):
        cases = [
            ("Q3/Q4: plan?", "Q3-Q4 plan.md"),
            ("../../etc/passwd", "-..-etc-passwd.md"),
            (".hidden", "hidden.md"),
            ("notes.md", "notes.md"),
            ("CON", "CON note.md"),
            ("  Tabs\tand\nnew lines  ", "Tabs and new lines.md"),
            ("a" + chr(0x202E) + "b" + chr(7) + " [[c]] #d ^e", "ab c d e.md"),
            ("???", "Untitled.md"),
        ]
        for title, expected in cases:
            self.assertEqual(my_notes.create_note(title, "", home=self.home)["name"], expected, title)
        long_note = my_notes.create_note("x" * 300, "", home=self.home)
        self.assertEqual(long_note["name"], "x" * my_notes.MAX_TITLE_CHARS + ".md")
        wide = my_notes.create_note(chr(0x1F3CB) * 100, "", home=self.home)
        self.assertLessEqual(len(wide["name"].encode("utf-8")), my_notes.MAX_TITLE_BYTES + 3)
        self.assertEqual(sorted(os.listdir(self.vault)), [".obsidian", "Notes from Sean"])
        self.assertFalse(any(name.startswith(".") for name in self._folder_names()))
        self.assertEqual(sorted(os.listdir(self.outside)), [])

    def test_without_a_title_the_first_line_names_the_note(self):
        note = my_notes.create_note("", "# Plan the week\n\nGym on Monday", home=self.home)
        self.assertEqual(note["name"], "Plan the week.md")
        long_first = "Remember to call the physio about the knee and book the next three sessions before Friday"
        named = my_notes.create_note("  ", long_first, home=self.home)
        # Cut at a word, about 60 characters in.
        self.assertEqual(named["name"], "Remember to call the physio about the knee and book the next.md")
        self.assertRefused(400, my_notes.create_note, "", "", home=self.home)
        self.assertRefused(400, my_notes.create_note, " ", " \n ", home=self.home)

    def test_refuses_what_it_cannot_save(self):
        self.assertRefused(413, my_notes.create_note, "Big", "x" * (my_notes.MAX_NOTE_BYTES + 1), home=self.home)
        self.assertRefused(400, my_notes.create_note, "Nul", "a" + chr(0) + "b", home=self.home)
        self.assertRefused(400, my_notes.create_note, "Half", "a" + chr(0xD800), home=self.home)
        self.assertRefused(400, my_notes.create_note, 5, "x", home=self.home)
        self.assertRefused(400, my_notes.create_note, "x", None, home=self.home)
        exact = my_notes.create_note("Exact", "x" * my_notes.MAX_NOTE_BYTES, home=self.home)
        self.assertEqual(exact["size"], my_notes.MAX_NOTE_BYTES)
        self.assertEqual(self._folder_names(), ["Exact.md"])

    def test_a_failed_write_leaves_nothing_behind(self):
        with patch.object(my_notes.os, "replace", side_effect=OSError("disk full")):
            self.assertRefused(500, my_notes.create_note, "Gym ideas", "x", home=self.home)
        self.assertEqual(self._folder_names(), [])


class ReadTests(_Vaults):
    def test_reads_a_note_with_its_version(self):
        path = self._note("Gym ideas.md", "---\ntags: [gym]\n---\n# Gym\n")
        note = my_notes.read_note("Gym ideas.md", home=self.home)
        self.assertEqual(note["text"], "---\ntags: [gym]\n---\n# Gym\n")
        self.assertEqual(note["version"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(note["modified_at"], os.stat(path).st_mtime)
        self.assertEqual((note["title"], note["editable"], note["phone_vault"]), ("Gym ideas", True, None))

    def test_only_note_files_directly_in_the_folder(self):
        self._note("Gym ideas.md", "x")
        self._note("Inner.md", "x", folder=self.folder / "Sub")
        (self.vault / "Elsewhere.md").write_text("vault root", encoding="utf-8")
        for name in ["../Elsewhere.md", "Sub/Inner.md", "/etc/hosts.md", ".hidden.md", "photo.png", "", ".md", "a\\b.md", None, 7]:
            self.assertRefused(400, my_notes.read_note, name, home=self.home)
        self.assertRefused(404, my_notes.read_note, "Missing.md", home=self.home)
        (self.folder / "Folder.md").mkdir()
        self.assertRefused(404, my_notes.read_note, "Folder.md", home=self.home)
        secret = self.outside / "secret.md"
        secret.write_text("private", encoding="utf-8")
        (self.folder / "Link.md").symlink_to(secret)
        self.assertRefused(403, my_notes.read_note, "Link.md", home=self.home)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "needs named pipes")
    def test_a_pipe_named_like_a_note_does_not_hang(self):
        self.folder.mkdir()
        os.mkfifo(self.folder / "Pipe.md")
        self.assertRefused(404, my_notes.read_note, "Pipe.md", home=self.home)
        self.assertEqual(my_notes.list_notes(home=self.home)["notes"], [])

    def test_too_large_or_not_text(self):
        self._note("Big.md", "x" * 20)
        with patch.object(my_notes, "MAX_NOTE_BYTES", 10):
            self.assertRefused(413, my_notes.read_note, "Big.md", home=self.home)
        self._note("Latin1.md", "caf".encode("ascii") + bytes([0xE9]))
        note = my_notes.read_note("Latin1.md", home=self.home)
        self.assertFalse(note["editable"])
        self.assertEqual(note["text"], "caf" + chr(0xFFFD))

    def test_before_the_folder_exists(self):
        self.assertRefused(404, my_notes.read_note, "Gym ideas.md", home=self.home)
        self.assertFalse(self.folder.exists())


class SaveTests(_Vaults):
    def _read(self, name="Gym ideas.md"):
        return my_notes.read_note(name, home=self.home)

    def _temp_files(self):
        return [name for name in os.listdir(self.folder) if name.startswith(".")]

    def test_saves_the_version_it_was_given_and_keeps_the_file_mode(self):
        path = self._note("Gym ideas.md", "Leg day")
        os.chmod(path, 0o600)
        opened = self._read()
        saved = my_notes.save_note("Gym ideas.md", "Leg day\nSquats", opened["version"], home=self.home)
        self.assertEqual(path.read_text(encoding="utf-8"), "Leg day\nSquats")
        self.assertEqual(saved["text"], "Leg day\nSquats")
        self.assertEqual(saved["version"], hashlib.sha256(b"Leg day\nSquats").hexdigest())
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(self._temp_files(), [])
        # The same text again writes nothing.
        before = os.stat(path).st_mtime_ns
        again = my_notes.save_note("Gym ideas.md", "Leg day\nSquats", saved["version"], home=self.home)
        self.assertEqual(again["version"], saved["version"])
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_a_note_changed_on_the_mac_is_never_overwritten(self):
        path = self._note("Gym ideas.md", "Leg day")
        opened = self._read()
        path.write_text("Leg day, edited on the Mac", encoding="utf-8")
        error = self.assertRefused(409, my_notes.save_note, "Gym ideas.md", "from the phone", opened["version"], home=self.home)
        self.assertEqual(error.reason, "changed")
        self.assertEqual(error.extra["version"], hashlib.sha256(b"Leg day, edited on the Mac").hexdigest())
        self.assertEqual(error.extra["modified_at"], os.stat(path).st_mtime)
        self.assertEqual(path.read_text(encoding="utf-8"), "Leg day, edited on the Mac")

    def test_a_change_made_while_saving_still_stops_the_save(self):
        path = self._note("Gym ideas.md", "Leg day")
        opened = self._read()
        real_fsync = os.fsync
        edits = []

        def fsync_then_edit_on_the_mac(fd):
            real_fsync(fd)
            if not edits:
                edits.append(fd)
                path.write_text("typed on the Mac meanwhile", encoding="utf-8")

        with patch.object(my_notes.os, "fsync", fsync_then_edit_on_the_mac):
            self.assertRefused(409, my_notes.save_note, "Gym ideas.md", "from the phone", opened["version"], home=self.home)
        self.assertEqual(path.read_text(encoding="utf-8"), "typed on the Mac meanwhile")
        self.assertEqual(self._temp_files(), [])

    def test_refusals(self):
        self.assertRefused(404, my_notes.save_note, "Gym ideas.md", "x", "v", home=self.home)
        path = self._note("Gym ideas.md", "Leg day")
        version = self._read()["version"]
        gone = self.assertRefused(404, my_notes.save_note, "Missing.md", "x", version, home=self.home)
        self.assertEqual(gone.reason, "gone")
        self.assertRefused(400, my_notes.save_note, "../Gym ideas.md", "x", version, home=self.home)
        self.assertRefused(400, my_notes.save_note, "Gym ideas.md", "x", "", home=self.home)
        self.assertRefused(400, my_notes.save_note, "Gym ideas.md", "x", None, home=self.home)
        self.assertRefused(400, my_notes.save_note, "Gym ideas.md", None, version, home=self.home)
        too_large = self.assertRefused(
            413, my_notes.save_note, "Gym ideas.md", "x" * (my_notes.MAX_NOTE_BYTES + 1), version, home=self.home
        )
        self.assertEqual(too_large.reason, "too_large")
        os.chmod(path, 0o444)
        read_only = self.assertRefused(403, my_notes.save_note, "Gym ideas.md", "x", version, home=self.home)
        self.assertEqual(read_only.reason, "read_only")
        os.chmod(path, 0o644)
        secret = self.outside / "secret.md"
        secret.write_text("private", encoding="utf-8")
        (self.folder / "Link.md").symlink_to(secret)
        link = self.assertRefused(403, my_notes.save_note, "Link.md", "x", hashlib.sha256(b"private").hexdigest(), home=self.home)
        self.assertEqual(link.reason, "not_allowed")
        self.assertEqual(secret.read_text(encoding="utf-8"), "private")
        self.assertEqual(path.read_text(encoding="utf-8"), "Leg day")
        self.assertEqual(self._temp_files(), [])


class RouteTests(_Vaults):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(router, prefix="/api/plugins/hermes-pwa")
        self.client = TestClient(app)

    def test_every_route_needs_the_dashboard_session(self):
        self.assertEqual(self.client.get(BASE).status_code, 401)
        self.assertEqual(self.client.post(BASE, json={"title": "x", "text": "y"}).status_code, 401)
        self.assertEqual(self.client.get(f"{BASE}/note?name=x.md").status_code, 401)
        self.assertEqual(self.client.put(f"{BASE}/note", json={"name": "x.md", "text": "y", "version": "v"}).status_code, 401)
        self.assertFalse(self.folder.exists())

    def test_write_list_read_and_edit(self):
        created = self.client.post(BASE, json={"title": "Gym ideas", "text": "Leg day"}, headers=AUTH)
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.headers["cache-control"], "private, no-store")
        note = created.json()
        self.assertEqual((note["name"], note["text"]), ("Gym ideas.md", "Leg day"))

        listing = self.client.get(BASE, headers=AUTH)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual([(n["name"], n["preview"]) for n in listing.json()["notes"]], [("Gym ideas.md", "Leg day")])
        self.assertEqual(listing.headers["cache-control"], "private, no-store")

        read = self.client.get(BASE + "/note", params={"name": "Gym ideas.md"}, headers=AUTH)
        self.assertEqual(read.status_code, 200)
        self.assertEqual(read.json()["version"], note["version"])

        saved = self.client.put(
            f"{BASE}/note", json={"name": "Gym ideas.md", "text": "Leg day\nSquats", "version": note["version"]}, headers=AUTH
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual((self.folder / "Gym ideas.md").read_text(encoding="utf-8"), "Leg day\nSquats")

        stale = self.client.put(
            f"{BASE}/note", json={"name": "Gym ideas.md", "text": "older", "version": note["version"]}, headers=AUTH
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"], "the note changed on the Mac after it was opened")
        self.assertEqual(stale.json()["reason"], "changed")
        self.assertEqual(stale.json()["version"], saved.json()["version"])
        self.assertEqual((self.folder / "Gym ideas.md").read_text(encoding="utf-8"), "Leg day\nSquats")

    def test_refusals_come_back_as_json(self):
        bad_name = self.client.get(BASE + "/note", params={"name": "../secret.md"}, headers=AUTH)
        self.assertEqual((bad_name.status_code, bad_name.json()), (400, {"detail": "invalid note name"}))
        missing = self.client.get(BASE + "/note", params={"name": "Missing.md"}, headers=AUTH)
        self.assertEqual((missing.status_code, missing.json()), (404, {"detail": "note not found", "reason": "gone"}))
        absolute = self.client.get(BASE + "/note", params={"name": "/etc/hosts.md"}, headers=AUTH)
        self.assertEqual(absolute.status_code, 400)
        empty = self.client.post(BASE, json={"title": "", "text": ""}, headers=AUTH)
        self.assertEqual(empty.status_code, 400)
        not_object = self.client.post(BASE, json=["Gym ideas"], headers=AUTH)
        self.assertEqual(not_object.status_code, 400)
        broken = self.client.post(BASE, content="{not json", headers={**AUTH, "content-type": "application/json"})
        self.assertEqual(broken.status_code, 400)
        cross_site = self.client.post(BASE, json={"title": "x", "text": "y"}, headers={**AUTH, "sec-fetch-site": "cross-site"})
        self.assertEqual(cross_site.status_code, 403)
        as_form = self.client.post(BASE, content="title=x", headers={**AUTH, "content-type": "text/plain"})
        self.assertEqual(as_form.status_code, 415)
        self.assertFalse(self.folder.exists())

    def test_a_note_body_may_be_larger_than_other_requests_but_not_unbounded(self):
        text = "line\n" * 40_000  # 200 KB: over the 64 KB other routes take, under the note cap
        created = self.client.post(BASE, json={"title": "Long", "text": text}, headers=AUTH)
        self.assertEqual(created.status_code, 201)
        self.assertEqual((self.folder / "Long.md").read_text(encoding="utf-8"), text)
        with patch.object(my_notes, "MAX_REQUEST_BYTES", 100):
            too_big = self.client.post(BASE, json={"title": "Big", "text": "x" * 200}, headers=AUTH)
        self.assertEqual(too_big.status_code, 413)
        self.assertFalse((self.folder / "Big.md").exists())

    def test_unexpected_failures_are_reported_not_raised(self):
        with self.assertLogs("hermes_pwa.files", level="WARNING") as logs:
            with patch.object(my_notes, "list_notes", side_effect=RuntimeError("database is locked")):
                listing = self.client.get(BASE, headers=AUTH)
            with patch.object(my_notes, "create_note", side_effect=RuntimeError("boom")):
                failed_save = self.client.post(BASE, json={"title": "x", "text": "y"}, headers=AUTH)
            with patch.object(my_notes, "read_note", side_effect=RuntimeError("boom")):
                failed_read = self.client.get(BASE + "/note", params={"name": "x.md"}, headers=AUTH)
        self.assertEqual(len(logs.records), 3)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["error"], "scan failed")
        self.assertEqual(listing.json()["notes"], [])
        self.assertEqual((failed_save.status_code, failed_save.json()), (500, {"detail": "could not save the note"}))
        self.assertEqual((failed_read.status_code, failed_read.json()), (500, {"detail": "could not read the note"}))


if __name__ == "__main__":
    unittest.main()
