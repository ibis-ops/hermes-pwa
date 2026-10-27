# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## Unreleased

### Router: team jobs, follow-ups and spend

- **Team jobs work with flat delegation.** Hermes lets only the top of a delegation hand work on
  unless `delegation.max_spawn_depth` is raised, so a job Jev gave Manager reached a Manager that
  could not use its team. When Jev picks a bot that runs a team on the map and delegation is flat,
  the router now gives each piece to the bot that owns it, side by side in one call, and puts the
  answers together. With deeper delegation it still hands the job to that bot. The router no
  longer asks for an "orchestrator" role, which Hermes ignores.
- **Follow-ups keep their context.** The message before a follow-up comes from the chat history
  Hermes passes the hook and the decision log, so "and Saturday?" still goes where the last
  message went after a gateway restart, and the router is told to put the earlier ask in the
  goal, since the bot it hands work to does not see the chat.
- **What Jev costs.** The Router sheet sums what Jev's latest answers cost.

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
