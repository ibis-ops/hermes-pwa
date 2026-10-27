# DESIGN_SYSTEM.md — Hermes Mobile

> The visual and interaction language. Mobile-first; it takes visual cues from the Hermes desktop app (our reference) so it feels familiar to Hermes users, while remaining an **independent, unofficial** client — its own reimplementation, not a copy.
> Implemented as CSS-variable tokens (`packages/web/src/styles/tokens.css`) so values can be re-expressed natively later (ADR-0007).
>
> **`packages/web/src/styles/tokens.css` is the single source of truth for token values.** The blocks below mirror it; if they ever disagree, the CSS wins — update this doc.

---

## 1. Design principles

1. **Messages, not a dashboard.** The chat reads like Messages on iPhone: bubbles, a quiet tool strip, time stamps between turns, a pill composer. Everything else follows iOS Settings: grouped lists, one accent, system type.
2. **Mobile-first, not a shrunk desktop.** Big tap targets, a bottom tab bar, sheets from the bottom edge, minimal tables.
3. **The main agent is the center.** The app opens on Chat. Bots, sessions and the system screens are a tap away, never in the way.
4. **Approval-first safety.** Commands are shown in full before they run; Deny sits left and Run right; a command the safety check flagged takes a second tap; anything lasting or destructive asks once more in a sheet.
5. **Fast by default.** The cached transcript is on screen at launch, loading shows the shape of what is coming, and nothing polls while the app is in the background.
6. **Tell the person what to do.** Errors and empty states say what happened and what to try, in plain words.

---

## 2. Theming

Two themes following iOS: light (grouped gray background, white cells) and dark (true black base). With no `data-theme` on `:root` the phone's setting decides (`prefers-color-scheme`); Settings → Appearance can force light or dark, which sets `data-theme` before the first paint (`lib/appearance.ts`) and updates the `theme-color` metas. Components only read tokens.

Key light values (`tokens.css` is the source of truth):

```css
:root {
  --hm-color-bg:        #f2f2f7;   /* grouped background */
  --hm-color-surface:   #ffffff;   /* cells, cards, sheets */
  --hm-color-fill:      rgba(120, 120, 128, 0.12);
  --hm-color-bubble:    #e9e9eb;   /* assistant bubble */

  --hm-color-text:       #000000;
  --hm-color-text-muted: rgba(60, 60, 67, 0.74);   /* iOS secondaryLabel, darkened for AA */

  --hm-color-primary:      #0071e3;   /* fills: user bubbles, primary buttons, toggles */
  --hm-color-primary-text: #ffffff;   /* text on primary */
  --hm-color-accent-text:  #0060c0;   /* blue used as text on light surfaces and tints */
  --hm-color-danger-text:  #d70015;   /* red used as text */
  --hm-color-badge:        #d70015;   /* count badges, both themes */
}
```

Dark keeps the same blue fill (`#0071e3`, white on it reads 4.7:1) and uses lighter text variants (`accent-text #409cff`, `danger-text #ff6961`). The `*-strong` tokens are the AA text colors on the matching tinted `*-bg`.

### Color semantics (do not improvise meanings)

| Token | Meaning |
|---|---|
| `success` / green | ready, success, safe |
| `warning` / amber | attention, setup required, degraded |
| `danger` / red | dangerous, destructive, failure |
| `running` / blue | active / running agent or task |
| `primary` / blue | primary action, selected, the user's own bubble |
| `accent-text` | blue text: links, text buttons, active labels |
| `text-faint` / gray | inactive, archived, disabled, decorative only |

---

## 3. Spacing, radius, elevation

4px spacing scale (`--hm-space-1` 4px to `--hm-space-8` 48px). Radii follow iOS: 10px grouped cells, 12px tiles, 18 to 20px bubbles, 14px action-sheet groups. Shadows are rare; separators are 0.5px hairlines.

---

## 4. Typography

The system stack (`-apple-system`, SF Pro on Apple devices) at iOS Dynamic Type sizes, in rem against a 17px root:

```css
--hm-fs-display: calc(34rem / 17);  /* Large Title */
--hm-fs-title:   calc(22rem / 17);  /* Title 2 */
--hm-fs-heading: 1rem;              /* Headline, 17px */
--hm-fs-body:    1rem;              /* Body, 17px */
--hm-fs-small:   calc(15rem / 17);  /* Subheadline */
--hm-fs-label:   calc(13rem / 17);  /* Footnote */
--hm-fs-mono:    calc(14rem / 17);
```

On iPhone the root follows Settings → Display & Brightness → Text Size (`lib/textSize.ts` reads the system body font), held between 14px and 23px so fixed-height controls do not clip. Elsewhere the root is 17px and the sizes read as the px values above.

---

## 5. Layout (mobile-first)

```text
┌──────────────────────────┐
│ ‹ / ☰   Title     Status │  header: back chevron when there is somewhere to go back
├──────────────────────────┤
│  Screen content (scroll) │
├──────────────────────────┤
│ Chat │Approvals│Sessions│More │  tab bar + safe-area inset; hidden while the keyboard is up
└──────────────────────────┘
```

- The tab bar is the primary navigation; More opens the drawer with every other screen.
- In-app navigation and open sheets are entries in the browser history, so the system Back gesture steps back through them (tab taps replace instead of push).
- Detail views, pickers and confirmations are bottom sheets (Done or Cancel at top right, drag down, scrim, Escape or Back to close). Destructive and lasting choices use the action sheet (`ActionSheet` / `ConfirmSheet`), never `window.confirm`.
- Respect `env(safe-area-inset-*)`.

---

## 6. Component inventory

Each component: variants, states, a11y note. Built as design-system primitives in `packages/web/src/components/`.

### Primitives
- **Button**: variants: `primary`, `secondary` (surface+border), `ghost`, `danger`. States: default/hover/active/disabled/loading. Min height `--hm-tap-min`.
- **IconButton**: 44×44, accessible name required.
- **Card**: `surface`, `--hm-radius-card`, `--hm-elev-1`, padding `--hm-space-4`.
- **BottomSheet**: drag handle, `--hm-elev-sheet`, backdrop, focus trap, swipe/scrim dismiss.
- **StatusDot**: semantic color; used for connection + worker state.
- **Badge / Pill**: status labels (`running`, `done`, `blocked`).
- **Input / Textarea**: 44px min, clear focus ring `2px primary`.
- **Skeleton**: loading states in the shape of the content; spinners only inside controls.
- **Toast**: transient feedback (non-blocking).
- **EmptyState**: icon + title + instructional copy + optional action.

### Domain components
- **MessageBubble**: `user` (primary fill, white text, right) vs `assistant` (gray bubble, left, markdown). Meta (time, duration, Copy) shows under the last bubble of a turn, or under any bubble after a tap. Typing dots while a reply starts.
- **ToolGroup**: wraps one or more tool calls under a shared header (`Tool actions · 2 steps · done`). Each row shows the tool name and target; tapping expands the raw output. Never dump raw logs inline.
- **ApprovalCard / ApprovalInline**: the full command (folded past 8 lines), a risk pill, Deny left and Run right; a flagged command needs a second tap; "Allow for this session" and "Always allow" ask in a sheet first.
- **ActionSheet / ConfirmSheet**: the iOS action sheet; destructive items in red, irreversible ones ask a second time in place.
- **SkeletonRows**: loading placeholders in the shape of the content (list, chat, cards).
- **TaskCard**: title, status pill, assignee/profile, priority, last update.
- **ConnectionBanner**: offline/reconnecting state with the network recipe.
- **UpdateNotification**: banner when a newer plugin release is available.

---

## 7. Interaction & motion

- Motion is functional and quick: `--hm-duration-fast` (150ms) / `--hm-duration-normal` (220ms) with `--hm-ease-out` for sheets/toasts; no decorative animation.
- Streaming chat appends tokens smoothly; auto-scroll only when the user is already at the bottom.
- Honor `prefers-reduced-motion`: `tokens.css` globally reduces animation/transition durations.
- Destructive confirmations: two steps inside one action sheet. Irreversible buttons are never adjacent to their opposite.

---

## 8. Iconography

- Sparse, consistent line icons (inline SVG via the `Icon` component). Icons support meaning, never decorate.
- The dashboard tab icon is `Smartphone` (per `dashboard/manifest.json`).
- App icons: maskable 192×192 and 512×512, plus an Apple touch icon; calm mark on a solid surface — readable at small sizes.

---

## 9. Accessibility (target WCAG 2.1 AA)

- Text contrast at least 4.5:1 (3:1 for large text) in both themes; `styles/accessibility-source.test.ts` checks the text tokens against white and the grouped gray.
- Every control has an accessible name and a 44×44pt hit area. Small-looking controls keep their look and get an invisible `::after` hit area (see the Pass 11 block in `apple.css`).
- Text follows the iPhone Text Size setting (section 4).
- Don't encode meaning in color alone: pair status color with an icon or label.
- Respect `prefers-reduced-motion` (skeleton shimmer, typing dots, switches and sheets stop animating).
- The chat log is a polite live region; errors use `role="alert"`.

---

## 10. Install / readiness page

The dashboard `Mobile` tab doubles as a readiness/landing page. Layout: hero + a vertical stack of status cards + actions.

```text
✅ Plugin installed
✅ API reachable
✅ Auth configured
⚠️ HTTPS required
⚠️ Phone network access not verified

[Open Hermes Mobile]  [Setup Tailscale Serve]
```

It should read as *"this is polished; Hermes is a real operating layer"* — not *"another chatbot webview."*

---

## 11. Visual cues from the desktop app

The desktop Hermes app is the visual reference (not a source to copy). Take cues — the light neutral surface palette, the calm single accent, the status-bar idiom (Gateway state · model · version), and the restrained, technical tone — and **translate** them into the mobile-first layout above. Do not reproduce desktop's multi-pane density on mobile, and do not copy its code or assets (see [`NOTICE`](./NOTICE)).
