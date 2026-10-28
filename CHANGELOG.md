# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## Unreleased

### Chrome connector: a bot drives its own Chrome fast, in batches, and can audit every change

- **Why.** The Kahunas bot drove Sean's own Chrome with AppleScript, Python and screenshots: 126
  tool calls and 22 screenshots for one task, while Chrome kept jumping to the front. A bot with a
  connector now gets two tools instead, `chrome` and `chrome_history`, shown only in a profile that
  has `<HERMES_HOME>/chrome/connector.json` (port, headless). Today that is Kahunas.
- **Its own Chrome.** The real Google Chrome binary on a separate profile folder (a copy of Sean's,
  so sites stay signed in), headless by default, on a fixed local port. It starts when the dashboard
  starts (in the background; a failure never holds the dashboard up, `HERMES_PWA_CHROME_PREWARM=0`
  turns it off) or on first use (1.3 s), and stays up between tasks; Sean's own Chrome is never
  touched or quit. `browser show` opens a
  visible window when Sean needs to watch or sign in; `browser hide` goes back to headless.
- **One call, many steps.** Steps go one per line (`go`, `click`, `type e5 = text`, `fill A = 1 ; B = 2`,
  `select`, `check`, `press`, `wait text:Saved`, `read table`, `upload`, `download`, tabs, dialogs) and
  run in order on one persistent DevTools connection. The answer says what each step did, every
  change with its value before and after (read back from the page) and a short map of the page with
  refs (`e12`) for the next call; after the first map only what changed comes back. Waits end when
  the page has been quiet for 250 ms with no request in flight, not after fixed sleeps, and a target
  that is still loading gets up to 3 s. Big reads go to a file with a summary. On the bench of 46
  local scenarios and 16 live sites the first version passed 72% and 88%; after the fixes it found
  (shadow DOM, late lists, stale refs, radio groups, custom dropdowns), 98% and 100%, at a median of
  0.6 s per scenario.
- **Faster ways to get data.** `read api` shows the JSON a page loaded from its own server and `api`
  asks that server directly with the page's session (same site only); `each` reads many pages in
  parallel tabs; `fast on` skips images, fonts, video and trackers; recipes save steps that worked and
  replay them without thinking. `auto` (Jev picks each click, like Jev Ultrafast) and `ask` (a small
  model answers from a long page) are built but stay off until zero data retention is settled: the
  Vercel team is on Hobby, which refuses it, and they send nothing from the page without it.
- **Measured with the bot itself.** A bench of 14 tasks that need real interaction (search then the
  second result's infobox, late content, unlabelled checkboxes, a JS prompt, upload, download, a to-do
  app, GitHub stars and release, pagination, a docs search, a cookie banner, a travel form) runs the
  Kahunas bot's own turns and checks each answer and, for changes, its chrome history. What it found
  and what changed: the tool now says it is the browser for every site (the bot refused non-Kahunas
  sites and reached for web_extract, which once answered with a stale release, or curl); `dialog
  accept = text` answers a prompt and a dialog step placed after the click says to click again; a
  see-through checkbox over a styled label (to-do lists, many design systems) and an unlabelled one
  named by the text beside it are in the map, controls that share a name show the row they sit in, and
  `check milk` ticks the box in that item's row; `read section:Syntax` and `read Born` read a section
  or the value next to a label, text inside web components (shadow roots) is read too, and a long
  `read text` names the sections it left out; a call that ends with a read or a download answers with
  the page line instead of every control; a ref used before any map says so; downloads report their
  exact size; steps sent with a literal `\n` are split.
- **Safe by design.** It never types into a password field or returns a password: `login` signs in
  with Hermes's vault, which fills the page without the model seeing the password. Every change is
  logged per session in `chrome/history/`, and `chrome_history` (with `verify`) lets the bot audit its
  work before it reports. Uploads come only from Sean's usual folders; `eval` cannot touch cookies,
  storage or the network; page text is marked as content, never instructions.

### Obsidian: Notes from Sean, written and edited from the phone

- **A section for Sean's own notes.** The Obsidian tab has a switch at the top: Bot notes (the
  notes the bots wrote, as before) and Notes from Sean, the notes in the "Notes from Sean" folder of
  the vault on the Mac. They are listed newest first, as the Notes app lists them: the title, when
  it was last edited and its first line. A tap reads one the way the note viewer shows notes, with
  Open in Obsidian next to Edit. The tab opens on whichever side was used last.
- **Writing and editing.** New note sits at the bottom of the list, where a thumb reaches, and
  takes a title and text. The Mac turns the title into a readable file name ("Q3/Q4: plan?" is
  saved as "Q3-Q4 plan.md"), never replaces a file (a taken name becomes "Gym ideas 1.md") and makes
  the folder on the first save. Edit changes a note in place. While typing, the sheet ends where the
  keyboard begins, so the text and Save stay in view. Nothing can be deleted from the phone.
- **No typing is lost, and no edit overwrites the Mac.** What is typed stays on the phone until the
  Mac has it: after closing the sheet, a dropped connection or iOS closing the app, the text comes
  back the next time, and the list marks a note with unsaved edits. An edit carries the version of
  the note it started from; when the note changed on the Mac since, the Mac keeps its copy and the
  phone offers to save the text as a new note or discard it (discarding asks once more). Notes are
  capped at 1 MB.
- **Safe on the Mac.** New plugin routes under `/obsidian/my-notes` (dashboard auth) list, read,
  create and save notes, and touch only `.md` files directly inside the folder: no paths, hidden
  files or links, wherever they point. Every write goes to a hidden file in the same folder first
  and replaces the note in one step. The vault is the one `HERMES_PWA_NOTES_VAULT` names when it is
  set, else the vault that already has the folder, else the vault Obsidian has open on the Mac.

### Bots: a list that scrolls, and what each bot is doing

- **The Bots list scrolls.** With Sean's 13 bots the list was cut off at the tab bar with no way to
  reach the rest, while the Team view scrolled. The rounded list clips its own corners, and a flex
  item that clips has no minimum height, so it shrank to the screen instead of making the screen
  scroll. Every scrolling screen now keeps what is on it at full height.
- **What each bot is working on.** The Team view shows a green "Working" line under every bot in the
  middle of something: the chat's title or the job another bot handed it, the step it is on in plain
  words ("Using the terminal", "Searching files", "Thinking") and which bot asked. An idle bot says
  when it was last active, and a line above the map names the bots at work. It comes from a new
  read-only plugin route, `/bots/activity`, which reads the step labels Hermes stamps on each bot's
  sessions during a turn (titles, labels and times, never message text). The map asks again every 8
  seconds while it is open and on screen.

### Router: asks for what Sean asked and trusts the answer

- **Handoffs ask for what Sean asked.** Tested on the Mac: "how many events are on my calendar
  tomorrow? just the count" went to Google Calander as "count them, include every calendar Sean
  has, and list times and titles", and the bot spent three extra tool calls on the extras. The
  router note now says to add no checks or scope Sean did not ask for and to keep his format
  ("just the count" means a number).
- **No rechecking a bot's answer.** The router reopened a bot's log, or redid its search, before
  it replied, which added 4 to 10 seconds to every handoff. It now passes the answer on in Sean's
  format and looks closer only when a bot failed, came back empty or contradicts itself; for
  anything sent, created or changed it says only what the bot's result confirms.
- **Quick checks on the Mac stay with the router.** Free disk space, a screenshot or what is
  running are now part of the router's own share, so Jev picks the router for them with
  confidence instead of wavering between it and the default bot (45% sure before).
- **What each teammate does.** A bot that runs a team or can hand work on now sees each of those
  bots' roles from the team map, not just their names.

### Router: team jobs, follow-ups and spend

- **Team jobs work with flat delegation.** Hermes lets only the top of a delegation hand work on
  unless `delegation.max_spawn_depth` is raised, so a job Jev gave Manager reached a Manager that
  could not use its team. When Jev picks a bot that runs a team on the map and delegation is flat,
  the router now gives each piece to the bot that owns it, side by side in one call, and puts the
  answers together, and the note under the reply says "Split across Manager's team". With deeper
  delegation it still hands the job to that bot. The router no longer asks for an "orchestrator"
  role, which Hermes ignores.
- **Follow-ups keep their context.** The message before a follow-up comes from the chat history
  Hermes passes the hook and the decision log, so "and Saturday?" still goes where the last
  message went after a gateway restart, and the router is told to put the earlier ask in the
  goal, since the bot it hands work to does not see the chat.
- **Handoffs that reach the right bot, and no borrowed logins.** Tested on the Mac: the router once
  delegated without a profile, which sends the task down the default route instead of to the bot
  that owns it, and when Gmail Connector had no Gmail login of its own the router searched
  `~/.hermes` for another bot's Google token and used it. The router note now says to give every
  task its profile name, and when a bot cannot do its part, to tell Sean what it was missing
  instead of doing it with another bot's access.
- **Bots the router cannot reach.** In Sean's own chat, questions about his running Claude Cowork
  projects went to the default bot, because Claude Cowork Driver was on the team map but not in the
  router bot's delegation routes, so Jev never saw it as a choice. Jev now sees every bot on the
  map; when it picks one the routes leave out, the router tells Sean it cannot reach that bot yet
  instead of handing the job to another one, and every router note names those bots. The Router
  card and sheet list them, each with a first draft of its line (its role on the map, else the
  mission in its SOUL.md), and one tap adds it to the router bot's routes through Hermes's own
  delegation API. Asked on the Mac, Jev now picks Claude Cowork Driver for those messages (61 to
  91% sure), and 82 to 100% once its route is in.
- **What Jev costs.** The Router sheet sums what Jev's latest answers cost.
- **Try a message.** The Router sheet asks Jev where a message would go, with the router's own
  delegation routes, and says so ("It would go to Google Calander · Jev 99% sure", or that the
  router would split it across a team). No bot gets the message and nothing is logged, so roles on
  the team map can be tuned without running anything.

### Router audit, and every bot on the same plugin

- **Obsidian works with any bot selected.** The Obsidian list, a note's text, delegated runs,
  backups and the update check are about the whole Mac, so they no longer carry the selected
  bot. With another bot selected, Hermes answered them from that bot's own, older copy of the
  plugin, which had no notes list and showed `{"detail":"Not Found"}`. Errors from the Mac now
  read as words instead of JSON.
- **Long screens scroll.** Obsidian, Messaging and Agents scroll inside the screen; a long notes
  list was cut off at the tab bar with no way to reach the rest.
- **Bots on an older copy of the plugin.** Hermes copies each plugin into a bot when the bot is
  cloned and updates only the copy it is asked about, so bots kept running old hooks without the
  team map or the router notes. Bots, Team names any bot whose copy is behind the dashboard's and
  gives the Terminal command that updates them.
- **Router fixes from the audit.** A message with pictures sends Jev only its words, never image
  data. Vercel's "add a card to unlock your free credits", "no providers available" and an answer
  Jev cannot use each get their own reason instead of "out of credits", "refused the key" or
  "could not be reached", and the Router card says when Jev did not answer the newest message
  instead of a plain "On". Zero data retention shows as on
  only when Vercel's routing notes say it applied (Vercel offers it on Pro and Enterprise plans,
  and a Hobby team's flag does not apply). Router setup names the bot to copy with `clone_from`,
  the field current Hermes reads, and keeps the older one for older Macs.

### Router with Jev, vault sync, and sheets that fit

- **Router.** A router bot can sit on top of the team map. Jev, TypeSafe's decision model, reads
  each message sent to it and picks who takes it: the router answers quick ones itself on a fast
  model, and real work goes to the bot that owns it with `delegate_task`. Jev is called through
  Vercel AI Gateway (`/v1/evaluate`, asking for zero data retention, and without it when the
  Vercel plan does not include it) or through OpenRouter, by the key the Mac has. When Jev is
  unsure, unreachable, out of credits or has no key, the router decides by itself. Bots, Team
  sets the router up in one tap (a bot copied from the default one, on a fast model, placed above
  the manager), and shows its settings, its service and its latest decisions with the reason
  when Jev did not decide. Under each router reply the chat says where the message went and how
  sure Jev was. The key stays in Hermes's `.env` (`HERMES_PWA_JEV_API_KEY`, set with
  `hermes config set`) and is read when needed, so a new key works without a restart; the
  decision log keeps only a short preview and a fingerprint of each message.
- **Obsidian in the tab bar, and Sync vault.** Obsidian has its own tab. Its screen has Sync vault:
  it opens Obsidian on the Mac in the background when it is closed, since Obsidian Sync only runs
  while it is open, rescans the notes, and offers to open Obsidian on the phone to pull them down.
- **Sheets above everything.** Sheets and the image viewer render outside the screen that opens
  them, so the System screen's "Restart gateway" button is no longer cut off behind the tab bar.
- **App walkthrough fixes.** Every sheet had a wider gutter on the right than on the left (a
  containment cap cut off the body's negative margin); sheets are now even. Model names in a bot's
  card end with an ellipsis instead of under the chevron. Cron jobs read as words ("Daily at 03:00",
  "Every 15 minutes") and lost an empty badge. Agents shows bot names as labels and lets a run's
  details wrap. Sessions' second view is "Signal & jobs" and fits. Settings notes keep their
  gutter, the Voice row is shorter, and the Model row shows the model alone. Messaging calls its
  enabled apps "Set up" instead of "Bots". The chat header shows the bot's label. A tool without a
  known shape shows its key argument (the command, the query, the path) instead of raw JSON.
- **Listen without the Mac voice.** The app asks the Mac ahead of time whether it can speak; when it
  cannot, a tap speaks with the phone's voice inside the tap, where iPhone allows it, and says so
  when the phone's voice does not start. Settings says when the Mac voice waits on a dashboard
  restart.

### Bots, read-aloud, and runs that keep going

- **Runs no longer get cut off by accident.** Every send goes to Hermes marked "run after", so a
  message sent while the chat only looked idle waits behind the running turn instead of meeting
  the bot's busy setting, which by default interrupts it. Before a quiet turn is shown as idle the
  app asks Hermes whether it is still running. Stop ignores taps for a moment after a send and takes
  two taps; "Interrupt and send now" asks first; a reply that was stopped says "Stopped".
- **Listen under replies.** Replies are read aloud by a voice on the Mac (macOS speech, Premium
  voices included), in short pieces so playback starts fast, and the text stays on the Mac. When
  Hermes is not on a Mac the phone's own voice reads. Settings has the voice, the speed and a sample.
  Voice-mode replies play again: the app's content security policy refused their `data:` audio.
- **Skills over the composer.** "Use a skill" opens a list over the composer, like the "/" list,
  instead of a half-height sheet; every sheet now dims what is behind it lightly.
- **Bots.** A Bots tab in the bottom bar. The Bots screen lists bots like Messages, newest chat
  first, and tapping a bot opens its chat; each bot's card holds Message, its model settings, its
  name and Delete.
- **Team map.** The Bots screen's Team view draws who reports to whom and which bots can message
  which, starting with the manager on top. The plugin tells each bot its place at the start of a
  chat and after the map changes. It is a guide: nothing is blocked, and Hermes configuration is
  not touched.

### Phone app polish

- **Messages look.** Chat bubbles without headers or avatars, typing dots, time stamps between
  turns, meta and Copy under the last bubble of a turn, a quiet tool strip with long output folded,
  a "New reply" pill when the reply grows below the fold, and a pill composer with the send arrow,
  mic and Stop where Messages has them. On a phone keyboard Return makes a new line.
- **Navigation.** A bottom tab bar (Chat, Approvals with a badge, Sessions, More), the app opens on
  Chat, and the system Back gesture steps back through screens, the drawer and sheets. Sheets have
  Done, drag to dismiss and Back. Every `window.confirm` became an action sheet that asks a second
  time for anything irreversible.
- **Speed.** The cached transcript shows at launch instead of a "Connecting" screen; skeleton rows
  instead of "Loading"; screen chunks are prefetched; polling is slower and pauses in the
  background; narrow store subscriptions; the service worker precaches the entry files and never
  caches an error page. The stylesheets lost 126 unused classes and 923 overridden declarations.
- **Chat reliability.** The live stream is handled at the shell level, so leaving the chat mid-reply
  no longer drops it; the message queue is kept in the store and survives a reload; a send the
  gateway does not take goes back into the composer; drafts persist per bot; switching bots no
  longer throws a running turn away; the history merge no longer duplicates turns.
- **Approvals.** Full commands, a risk pill, Deny left and Run right, a second tap for a command the
  safety check flagged, and cards for questions asked on the socket stay until answered.
- **Settings.** Appearance (Automatic, Light, Dark), one switch for notifications on this phone,
  a confirm before logging out, and "Clear saved chats on this phone".
- **Notes.** `[[wikilinks]]` in the note viewer open the linked note in place, with a way back.
- **Voice.** The level meter no longer re-renders the composer every frame; voice mode no longer
  sticks on "Thinking" after a reply with no text or reads an old reply again; microphone and
  transcription errors are shown instead of swallowed.
- **Accessibility.** AA contrast for muted text, blue and red text and badges in both themes,
  a 44pt hit area on every small control, and text that follows the iPhone Text Size setting.
- **Security.** Hardened file and push routes (frame-ancestors, CORP, vetted file descriptors,
  wider forbidden roots, redaction of bearer tokens), bounded caches, push sends off the request
  thread, locked state files, request ids on every approval answer, markdown images limited to the
  plugin's own file route, and a fuller sign-out that clears drafts, per-bot choices and cards.

### Added

- **Obsidian tab.** Lists the notes Hermes created or edited in the Obsidian vault, grouped by
  day with New/Edited badges and the bot that did the work, and opens each one in the Obsidian
  app through an `obsidian://` link. The plugin's new `/obsidian/activity` route reads the vault
  registry and every profile's tool-call history (paths and times only); the vault name the links
  carry is detected from the phone's iCloud copy and can be changed on the tab. Tapping a note reads
  it straight from the Mac (`/obsidian/note`, vault-scoped) so it is readable before the phone's
  Obsidian has synced it, with "Open in Obsidian" below. Notes written through the Local REST API
  plugin are picked up too.
- **Agent history.** The Agents screen keeps a durable history under the live subagent tree:
  every delegated run across all profiles (`/agents/history`, read from each profile's subagent
  sessions), grouped by day, with the bot that ran it, the goal, status, duration, model, tool and
  token counts, the chat that asked, and the run's final answer on tap.
- **Approvals and clarify questions answered from the phone.** The gateway asks its clients
  questions as server→client JSON-RPC requests (`approval`, `clarify`) and only sends them to a
  client that advertised `client.capabilities {server_requests: true}`; the app never did, so every
  approval was withdrawn as "the attached client cannot answer". The app now advertises on every
  connection, turns the requests into cards (choices as the gateway offers them, a note when the
  safety check refused the command, batch clarify with chips and free text), answers on the same
  request id, honors `request.cancel`, and re-delivers `open_requests` from a reconnect snapshot.
- **Sessions: browse the gateway's own conversations.** A scope toggle on the Sessions screen
  switches from phone chats to Signal, scheduled and delegated sessions across all profiles
  (`/api/profiles/sessions?profile=all&sources=…`), listed read-only with the bot that ran each
  one; a tap opens the transcript in a sheet instead of resuming the session into the chat.
  Delegated runs come from the plugin's `/agents/history` instead, because Hermes hides sub-agent
  sessions from every source-scoped listing (`sessions.show_subagents` only re-admits them to an
  unscoped one); they are merged in newest first, in the delegating profile's store under the
  bot's name.
- **Whole transcript after compaction.** History is requested with the turns Hermes folded away
  (`include_compacted=true`) and the compaction handoff row is dropped, so a long chat keeps
  showing its earlier turns instead of collapsing to the latest page.
- **Bots.** Profiles are presented as bots: Activate now really switches the chat to that profile
  (messages used to go to the gateway's launch profile) and opens a new chat with it. The choice is
  kept on the phone (localStorage) instead of changing the gateway's sticky active profile, which
  also set the `hermes` CLI default on the Mac.

### Fixed

- **Tool action dots.** The pulsing "running" dot on tool actions followed the presence of a stored
  result instead of the turn, so it kept blinking after the reply finished. It now stops with the
  reply, except for a tool that is really paused on an open approval.
- **Push for bot turns.** A turn finished by a profile with no push subscription of its own now
  notifies every subscribed device instead of nobody.

## 0.1.2-beta — 2026-06-28

### Fixed

- **WebSocket connect compatibility with official Hermes backend.** The PWA sent the WS ticket
  only as a subprotocol (`Sec-WebSocket-Protocol: hermes.ws-ticket, <ticket>`), but official
  Hermes-Agent `main` accepts the ticket only as a query param (`/api/ws?ticket=<ticket>`), so a
  fresh install could hang on `Connecting…`. The transport now keeps the subprotocol path as primary
  (no ticket in the URL) and falls back **once** to the legacy query path if the first socket closes
  before it opens. Post-open closes never trigger the fallback.

## 0.1.1-beta — 2026-06-28

First beta. Marked beta to set expectations while it gets real-world testing.

### Fixed

- **Chat transcript order.** History is now rendered in the backend's returned order
  instead of being re-sorted by timestamp. After history compression, a freshly inserted
  user message can carry a newer timestamp than the restored assistant/tool rows below it,
  which made replies jump above their prompt. The PWA now trusts the backend order.

## 0.1.0 — 2026-06-28

Initial public release — an installable, mobile-first PWA control plane for the
self-hosted [Hermes Agent](https://github.com/NousResearch/Hermes-Agent), shipped as a
Hermes Dashboard plugin. Independent, unofficial client.

### Added

- Installable PWA with Add-to-Home-Screen on iOS Safari and Android Chrome.
- Chat with streaming replies; Activity inbox with approvals; Projects/kanban; Agents & system screens.
- Same-origin Dashboard session auth — no separate mobile credentials.
- Web push notifications (VAPID), scoped to the active Hermes profile.
- Read-only update-check endpoint + in-app notification banner with manual update instructions.
- Settings install-prompt button when the browser exposes `beforeinstallprompt`.
- `npx hermes-pwa install` npm installer wrapper.
- Tailscale Serve setup docs and a security/privacy statement.
- GitHub Actions CI and release workflows.

### Security & hardening

- ws-ticket passed via the WebSocket subprotocol (never in the URL); credentials never persisted.
- Local transcript cache purged on logout and on user switch.
- Authenticated Dashboard session required for sensitive plugin endpoints.
- Attachment filename sanitization; sanitized push error state.
