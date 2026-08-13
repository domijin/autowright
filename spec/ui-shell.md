# Autowright SPEC — UI shell: navigation, onboarding, agents & secrets, menu bar

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 9. Navigation & app shell

One 100 vh dark window with macOS traffic lights. The window drags from its top edge, Apple
Music-style: a fixed 18 px full-width drag strip spans the whole window top (above sidebar and
content, z-index 100), and the content pane always carries its own 40 px sticky drag strip —
every surface — so page content sits at a constant vertical offset. Both shell strips are pure
OS drag surfaces: they carry `pointer-events: none`, so DOM clicks pass through to whatever
renders beneath them (drag-region collection ignores pointer-events, so window dragging still
works); they must never hold children. Interactive controls inside drag regions stay clickable
(`no-drag` on buttons/links/inputs). Real OS clicks on a button swallowed by a drag region start
a window drag; synthetic/Playwright clicks bypass drag regions entirely and won't catch that
mistake.

The sidebar is a **hover-expanding floating rail** anchored to the left window edge: a panel
(`position: fixed`, `left: 0, top: 46, bottom: 12`, z 90) with square left corners and a 12 px
radius on the right corners (`0 12px 12px 0`), `--bg-sidebar` background and a hairline border.
Its top edge (46 px) sits **below** the traffic lights — the lights are pinned at
`trafficLightPosition: { x: 14, y: 14 }` (`titleBarStyle: 'hidden'`, one fixed position in
every window state) and end around y ≈ 28, so panel and lights never overlap. Collapsed
(default, no hover) the rail is 58 px wide and shows icons only: logo at top, nav icons
(Automations, Executions, Agents, Secrets, Settings), and the About icon pinned at the bottom
below a flexible spacer — About is meta, not a working surface. While the store holds §9.4
`updateAvailable` (the §3 update-available event — a known, not-yet-installed update), an
extra nav row appears directly above About (`data-testid="nav-update"`): fa-circle-down icon
and "Update available" label, both `--accent`-colored so the icon alone signals in the
collapsed rail; no count pill, never in the active state. Clicking it navigates to the About
page, which opens pre-armed (§9.4) — the download itself still starts from that row's
button. The row follows the §3 clearing rule: gone when a later check answers up-to-date,
otherwise only with the restart that installs. On `:hover` the panel's width
animates 58 px → 212 px (200 ms — `var(--t-enter)` — pure CSS on the `.ad-rail` class) **overlaying** the content
pane, which never reflows: the layout reserves a constant 58 px spacer, so the content pane
always spans the rest of the window. Inner sidebar content keeps a fixed 212 px width with
`overflow: hidden` on the panel, so nav rows never reflow or squish mid-animation — the
wordmark ("Autowright"), row labels, and live count pills (Settings and About carry none) are
revealed by the widening clip **plus** an opacity fade (`.ad-rail-reveal`, hidden at rest,
shown on rail hover): the clip alone would leave the labels' first characters peeking past
58 px. Icons are horizontally centered in the 58 px rail (rail
center x ≈ 29: nav-group 10 px padding + row 11 px padding + 16 px icon slot; logo 26 px at
16 px left padding). There is no collapse toggle and no persisted sidebar state — hover is the
only mechanism, identical in the app shell and the create/edit shell. The panel sits below the
two drag strips in z-order but both are pointer-transparent, and it starts below their rects
(y 46 > 40), so it needs no `no-drag` handling. Navigation is state-driven (`surface` → `page` → detail ids); browser/OS back works,
but once past onboarding back never re-enters it. Page navigation (`go()`) always lands in the app
shell: if the create/edit surface is active, it exits back to `surface: app` — so sidebar tabs work
while editing an automation. Popovers close on outside mousedown. Modals render through a React portal on
`document.body`: page containers animate `transform` (`.ad-anim-page`, fill
both), which makes them the containing block for `position: fixed` — an
in-tree modal would anchor to the scrolled page instead of the viewport and
get dragged offscreen on any page tall enough to scroll. Toasts:
bottom-center, ~2.8 s default (some 2.6–5.8 s). One toast at a time — a new message replaces the
current one and replays the fade-up entrance. Centering must not use `transform` (the fade-up
animation animates `transform` and would knock the toast off-center while it plays); it uses
`left/right: 0` + auto margins + fit-content width.

**Interaction conventions** (every page, both windows):

- Anything clickable is a real `<button>` (or an anchor for links) — cards, list/table rows,
  picker rows, chips, tags. Every interactive surface is reachable with
  Tab and activates with Enter/Space. Row/card buttons reset button chrome
  (`.ad-btn-bare`: no background/border, inherit font/color/text-align, full width) and then
  carry their surface class (`.ad-card-click`, `.ad-hover-row`, …).
  **Sole carve-out — nested controls.** A clickable surface that must nest another
  interactive control cannot be a `<button>` (nested `<button>`s are invalid HTML). It
  renders as a `div` with `role="button"`, `tabIndex={0}`, and an Enter/Space keydown
  handler that ignores key events originating in the nested control — the same
  Tab/Enter/Space guarantee holds. Exactly four surfaces ship this pattern: the
  automations-list card (nests the inline Execute-now button), the agent card (nests the
  overflow-menu button), the menu-bar panel's automation row (nests the inline Execute-now
  button), and the §11 section-card header (nests its `right`-slot action buttons).
  Everything else stays a real `<button>` — no other `div onClick`.
- Icon-only buttons always carry an `aria-label` (the `title` tooltip stays for sighted
  users). `Toggle` renders `role="switch"` + `aria-checked`; radio groups (`RadioRing`
  rows) render `role="radio"`/`aria-checked` inside a `role="radiogroup"`; a segmented
  filter's buttons carry `aria-pressed`.
- The `Modal` shell's card renders `role="dialog"` + `aria-modal="true"`;
  `ConfirmModal` upgrades it to `role="alertdialog"` labelled by its title. This also
  gives tests an unambiguous scope — a confirm button whose label matches a row action
  (e.g. "Delete secret") is queried inside the dialog role.
- The §14 focus ring must never be clipped: controls inside an `overflow: hidden` card use
  the inset variant (`.ad-focus-inset` — outline-offset −2 px) so the ring draws inside the
  clip instead of being cut.
- A page whose data hasn't loaded yet renders a centered `LoadingRow` — never a blank pane.
- One-click destructive actions (delete, remove trigger, clear) always confirm first —
  `ConfirmModal` or the row's inline confirm swap; never a bare instant delete.
- Popover menus with unbounded content scroll inside (`ScrollArea`) — rows never render
  past the window edge: the version menus cap at 60 vh; the timezone picker's list scrolls
  in a fixed 240 px `ScrollArea` (its filter input sits above, outside the scroll).
- Modal cards cap at 84 vh and scroll inside (`ScrollArea`, built into the `Modal` shell) —
  content and footer buttons can never render off-screen. (The §9.4 doc modal keeps its
  tighter 62 vh body.)
- Buttons that fire a multi-request commit disable **and** show busy feedback (spinner or
  label swap) while in flight; sibling actions that would double-fire the commit disable
  with them.

Text selection: all text is selectable by default — any piece of information on screen
(titles, badges, chips, labels, list rows, logs, paths, parameter values, scripts) can be
highlighted and copied. The only unselectable elements are buttons and the title-bar drag
region (`.ad-drag`). The
sandboxed result iframe is selectable (its own document). Copying is native: highlight, then
right-click — the Electron main process shows a context menu with Copy on any selection (both
windows); text fields get Cut/Copy/Paste/Select All. There are no in-UI copy buttons.

Boot gate: until the renderer connects to the backend and loads the state snapshot, only the
plain window background renders. If boot is still pending after 300 ms, a centered logo +
spinner appears with "Connecting…" (or "Waiting for the Autowright backend…" once a connection
attempt has failed; boot retries every 1.2 s). Fast boots therefore show no splash flash.
If connection attempts keep failing for 15 s, a second muted line appears under the first:
"Still waiting — quitting and reopening Autowright restarts the backend service." (reopening
re-runs the §3 ensure-backend step). Retrying never stops.
While waiting, the splash polls the §3 ensure-backend status (`backend-status` IPC, every 2 s);
if it reports `failed`, the second line shows the failure detail instead (e.g. "The backend
service was registered but never started — macOS Gatekeeper may be blocking an unsigned build.
Details in app.log."). Connection retries continue even in this state.

**Page-header actions.** Every page's top-right header actions render in one shared cluster
(`HeaderActions` — flex row, 10 px gap, vertically centered), whether the page uses the shared
`PageTitle` right slot or a hand-rolled title row. Order left → right by rising prominence:
dim text buttons, then ghost, then danger-ghost, then the single accent primary — the primary
is always rightmost, with one exception: an icon-only overflow ellipsis (⋯) sits at the far
right edge, after the primary. At most one primary per header, and a list page's main create
action is that primary (New automation, Add agent, Add secret). Icons appear only on stateful
primaries (e.g. Execute now / Executing…) and icon-only buttons — text secondaries carry no
icons. Filters (the Executions page's segmented All / Succeeded / Failed control) are not
actions and sit alone in the right slot.

### 9.1 Automations list

1200 px page, "Automations" title + New button. When the §4.4 pending create-mode slot
holds a draft (`pendingDraft` on `GET /state`), the header shows two buttons: a bordered
**Resume draft** button (opens the create flow, which resumes the slot straight on Review)
to the left of the primary **New automation** button — which then starts fresh: a danger
confirm (title "Start a new automation?", body "Your unsaved draft “`<name>`” will be
discarded. This can't be undone." — the draft's name in curly quotes, omitted when the
draft has none; confirm button "Discard and start new") deletes the slot
(`DELETE /draft/pending`) before opening the create flow. Without a
pending draft, the single New automation button opens the create flow directly. Left of
these sits a ghost **Import…** button (always present): it opens the **import modal**
(§5.2 two-phase import). Input step: title "Import automation" over a one-line muted intro
("Add an automation someone shared — from a link, or a file on this Mac."), an
eyebrow-labeled URL field (FROM A LINK; mono text, placeholder
`https://github.com/… or a direct .autowright link`) with a faint caption underneath
("A GitHub repository page, a release, or any https link to an .autowright file."), a
centered hairline OR divider, and a full-width dashed choose-file button (`.ad-btn-dashed`,
file-import icon, "Choose an .autowright file on this Mac…" — native open dialog,
main-process IPC, filtered to `.autowright`). Footer: quiet Cancel / accent **Import**
(disabled while the field is empty; Enter submits). The URL POSTs to §19
`/automations/import/url`; a chosen file's bytes to `/automations/import/preview`; while in
flight the buttons disable. A 422 shows inline in red — under the field for URL failures,
under the dashed button for file failures — never as a toast. Success swaps the modal to
the **preview step**: the automation's name + description, a source row (inset box — link or
file-zipper icon, mono text: the resolved URL, or the chosen file's name), then only the
sections that apply — TRIGGERS as §4.3 `triggerLabel` chips, STEPS as numbered rows (faint
mono index, step name, accent AGENT mini-badge where `agent`), SECRETS (amber NOT SET
mini-badge when `exists` is false — it will be created as a placeholder; gray ON THIS MAC
when true), AGENTS (gray REUSED / plain when new) — and a hairline-divided footer note:
the packages count when any, plus "Its triggers arrive off — review the scripts in the
editor before enabling them." Footer: quiet **Back** (returns to the input step) / accent
**Import** — POSTs `/automations/import/confirm` with the preview's token, closes the
modal, and opens the **import summary modal** (a 404 — expired token — surfaces inline on
the preview step).
The summary modal: title "Imported "`<name>`"", a fixed muted intro line under it ("Its
triggers are off until you enable them."), then only the sections that apply — "Secrets that
need values" (one row per created placeholder: name + amber Not set tag — "add values on
the Secrets page"), "Already on this Mac — not granted" (pre-existing secrets/agents the
automation references, §5.1: "review and grant them on the edit page"), "Agents added"
(created agent names; a not-ready harness shows the §12 Needs setup badge), and a packages
note ("`<n>` packages install on the first execution") when the manifest declares any.
Footer: accent **Open automation** (navigates to the new detail page) / quiet Close. One card per automation: name, description,
status badge, trigger chip (`triggerChip`, plus an OFF tag when `triggersOff`), result-summary chip when
the last execution set one (tinted by `resultStatus` with the §7 chip colors — same tint as the detail
and execution pages), and
a square accent-filled **inline execute button** per card (rounded square, solid accent/orange
background with a dark play icon — same fill treatment as the primary button; hover brightens;
while that automation is executing it swaps to a spinner, dims, and is disabled — tooltip
explains why). The card carries no last-execution label — `lastExecutionLabel` appears on the detail page and in the
menu bar. The card name stays on one line — ellipsized with the full name as a `title`
tooltip (same treatment as the detail-page title), so long names never wrap and desync card
heights across a grid row. Empty state (dashed card):
"No automations yet. Describe a job in plain words — your AI writes it as scripts you can read,
and Autowright executes them on your schedule." with accent CTA "Create your first automation".

### 9.2 Automation detail

Back link ("‹ Automations"), title row: name (single line, shrinks with ellipsis, full name in
its tooltip — the row never wraps; read-only here — renaming lives on the §11 edit page).
Under the title row, a lede row: the automation's `description` (§4.1) as a muted single-line lede
(ellipsis on overflow, full text in its tooltip); read-only — editing lives on the §11 edit
page — and beside it, on the same row, the §4.3 detail-page trigger status chip (never
shrinks; the description ellipsizes first). When the description is empty the description text is omitted
and the chip stands alone on the row.
Then the version chip dropdown (§4.4 Execute once + footer
explainer), status badge, then the §9 header-action cluster: Edit (ghost), Execute now (accent
primary), ellipsis menu at the far right edge (**Export…**, then Delete automation… in red). Export… opens a small modal — "Export "`<name>`"" with one toggle row,
"Include parameter values" (on; help: "Your saved parameter values travel with the file — turn
this off when sharing with someone else."), footer note "Secret values and memory never leave
this Mac", accent Export / quiet Cancel — then a native save dialog (main-process IPC, default
name `<name>.autowright` in Downloads) writes the §19 export response; success toasts
"Exported to `<file>`."
Sections top to bottom:

- Optional **Draft banner** (§4.4), then **LATEST RESULT** card — the execution's chip (if it set one)
  + metadata chips, then a **trimmed** version of the §7 result view stack for the latest
  execution: one file view for `result.md` (that exact name) expanded, and nothing else in the
  top slot no matter how many renderable files the run wrote — then the §7 **FILES footer**,
  collapsed, its "FILES · N" count covering every file in the dir including `result.md`. A run
  that wrote no `result.md` gets no top view and the footer **expanded** instead, so the card is
  never blank; its rows still start collapsed and still expand to the same previews. Chip rules,
  per-session collapse state, and the no-files dashed placeholder are §7's, unchanged. The full
  every-file stack stays one click away on the execution page. The card is **live**: on
  `execution.finished` the page refetches the full record (§19 client rule), so the finished
  run's result replaces the previous one — and replaces the no-executions empty state after a
  first run — without leaving the page. With parallel executions the card shows the most
  recently **started** run that has finished with a result (§4.1 `latest` ordering — the same
  run the status chip reflects), so an older run finishing later never replaces a newer run's
  result. When the latest
  execution **failed**, the card opens with a red-tinted **failure notice** ahead of any result
  views: "Failed at step “`<name>`”" (the step name in curly quotes; "Execution failed" when
`error.step` is null), the §4.5 possible reason as plain text when present, the
  error message in mono, a "View execution" link to the execution page, and the §7 quiet
  **"Fix with AI"** button (same behavior: opens the editor, seeds the chat thread, sends
  the §11 canned analyze chat message). No-executions empty
  state (dashed
  card): "No executions yet / Press Execute now — the first result will appear right here."
- **TRIGGERS** card — one row per trigger (kind icon — fa-clock for
  cron, fa-calendar-day for time, fa-rocket for app start, fa-brands fa-discord for discord,
  fa-comment for imessage;
  §4.3 `label`; a fa-pen **edit** button — every kind except app start, which has nothing to
  edit; per-row on/off toggle;
  remove × — removing confirms first (`ConfirmModal`: "Remove this trigger?" /
  "`<label>` is removed from this automation. Its settings are gone — add it again to get
  it back." / Cancel / red Remove trigger)), the §4.3
  status line beneath the rows, and an **"+ Add trigger"** button opening an inline editor.
  The editor fades up on entry (`.ad-anim-item`) — both from Add trigger and from a row's
  edit swap; a row's connecting/error status line enters the same way.
  Unlike the other detail-page cards this card does not clip its overflow (it has no
  full-bleed hover rows to mask) — the editor's popovers (timezone picker, secret picker)
  must overhang the card edge rather than be cut off.
  Pressing a row's edit button swaps that row for the same inline editor pre-filled with the
  trigger's values (kind picker included; the mention checkbox reflects the stored value, not
  the checked-by-default for new triggers); the submit button reads **Save** instead of Add,
  and saving replaces the trigger in place — `id` and on/off state kept — via the same §19
  PATCH, toast "Trigger updated — `<short>`."; Cancel restores the row unchanged. The
  editor:
  kind picker (Cron / One time / App start / Discord / iMessage — each chip leads with the
  same kind icon its trigger row uses) then either a
  cron-expression input
  with a live preview line (the humanized label
  when simple, plus "next: `<time>`"; an invalid expression gets the red input border and
  blocks Add) or the One time pair: a native date input (Chromium's calendar popup — date
  only, so no AM/PM field) beside a **segmented 24-hour time group** — one `ad-input`-styled
  box holding three two-digit mono fields with colon separators (muted placeholders
  HH/MM/SS; aria-labels hours/minutes/seconds; seconds pre-filled `00` for a new trigger).
  Segment behavior: digits only; focusing a segment selects its content; a segment completed
  to two digits auto-advances focus to the next; ↑/↓ step the value with wrap (hours 0–23,
  minutes/seconds 0–59; from empty the first press lands on `00`); Backspace in an empty
  segment jumps back; a lone digit zero-pads on blur ("9" → "09"); pasting a full time into
  any segment distributes the digit pairs across it and the following segments. The three
  segments and the date combine into the stored `at`. An out-of-range time reddens the group
  with preview "Hours go 0–23, minutes and seconds 0–59"; a complete pair in the past
  reddens date and group, and the preview shows the §19 `/triggers/preview` error verbatim —
  the copy comes from the backend: "the time must be in the future";
  either state blocks Add. App start shows no
  input — just the preview line "On app start — executes when you launch the app", and its
  picker chip renders disabled (title "Already added") while the list holds one. A discord or
  imessage
  trigger row whose §4.3 `connection` state is `error` shows the error as a red mono line under the
  row; state `connecting` shows a muted "connecting…" line; `connected` shows nothing. The
  **Discord editor**: a channel-id input (ASCII digits; red border otherwise), then a secret
  row — a **secret picker** for the bot token (the app's standard popover pattern: an
  `ad-btn-pill` trigger button — fa-key icon, the selected secret's mono name or the muted
  placeholder "Choose the bot-token secret…", fa-caret-down — opening a `PopMenu` with one
  row per stored secret: accent check column for the selected one, mono name with the §12
  amber NOT SET badge when the secret is a placeholder, the secret's `description` as a muted
  sub-line when present; picking closes the menu; always rendered, even when no secrets
  exist — the empty menu shows the muted note "No secrets yet — press New secret.") with a
  quiet **New secret** button directly beside it (the row hugs left — the pill and the button
  sit together, not pushed to opposite edges), opening the shared §12 secret modal in add
  mode; saving it
  auto-selects the new name in the picker — no hint text under the row; the picker
  placeholder and the setup guide carry the explanation. A
  **setup guide** disclosure sits directly below the kind-picker chip row while Discord is the
  selected kind, above the editor inputs (quiet toggle link "New to Discord bots? Step-by-step
  setup", chevron flips open/closed, the list animating through the §14 Collapse primitive —
  both setup guides) expanding to a numbered list that
  assumes no prior Discord-bot knowledge: (1) open
  discord.com/developers/applications — an external link (target _blank, opens in the default
  browser), sign in — skip any onboarding page Discord shows first — press New Application and
  name it; (2) on its Bot tab press Reset Token and copy the token — it shows only once; (3)
  still on the Bot tab, under Privileged Gateway Intents turn on Message Content Intent —
  without it the bot can't read messages; (4) press the New secret button below, paste the
  token as the value and Save to Keychain — the secret is selected automatically; (5) in the
  portal's left sidebar click OAuth2 and scroll to the OAuth2 URL
  Generator section; (6) tick the `bot` scope — a Bot Permissions grid appears below — tick
  View Channels there (if an Integration Type selector shows, leave it on Guild Install); (7)
  copy the Generated URL at the bottom, open it in the browser, pick the server, press
  Continue then Authorize — needs Manage Server on that server; the bot showing offline is
  fine; (8) in Discord open User Settings (gear icon), scroll the settings sidebar to the
  bottom, click Developer and turn on Developer Mode; close settings, right-click the
  channel → Copy Channel ID; (9) paste
  the channel id below, choose the bot-token secret, press Add. The editor then has an
  optional message-filter text input (§4.3 `pattern`; placeholder "Message filter — only
  messages containing… (optional)", title "Fires only when the message contains this text —
  case-insensitive, plain substring"), an optional sender-filter text input (§4.3 `author`;
  placeholder "Sender filter — only messages from these user ids (optional)"; accepts
  comma-separated ids, each digits only, same invalid styling as the channel input; directly
  below it a visible helper line (11.5px, `--text-muted`): "Fires only on messages from
  these Discord users — comma-separate several ids. A user id is a long number like
  234567890123456789 — right-click their name → Copy User ID (needs Developer Mode, enabled
  in step 8)."), and an
  "Only when the bot
  is mentioned" checkbox (§4.3 `mention`) — checked by default, so a fresh trigger fires only
  on @-mentions unless the user unticks it; the label hugs its content (`align-self:
  flex-start`) so the click target doesn't span the editor's full width; preview line "On Discord message in `<channel>`";
  Add stays disabled until the channel is digits, a secret is chosen, and the sender filter
  is empty or a comma-separated list of digit ids. The
  **iMessage editor**: while iMessage is the selected kind, a **setup guide** disclosure sits
  directly below the kind-picker chip row (where the Discord setup guide sits; same pattern:
  quiet toggle link "How iMessage triggers work"): (1) this Mac's
  Messages account is the identity — no bot, no token: when the sender below texts it, the
  automation executes; (2) loop-safety note — messages this Mac sends never trigger, and
  iMessage can't text yourself anyway (your own messages come from the same Apple ID), so the
  sender must be someone else; to trigger it yourself, either create a new Apple ID, sign
  Messages on this Mac into it, and text that account — or use a Discord trigger instead,
  where a bot in your own server can receive your own messages; (3) grant the two permissions
  below; (4) enter the sender below exactly as Messages knows them — phone numbers in
  international form (`+1…`), or an email; to see the stored handle, open the conversation in
  Messages and press the ⓘ info button (formatting like spaces and dashes is fine — it's
  stripped automatically). Below the guide a **permission checklist** — two rows, each an
  icon + name + live status + action button:
  - **Full Disk Access** — status from §19 `GET /imessage/permissions` (`fullDisk`), re-polled
    every 3 s while the checklist is visible: granted → green check, "Granted"; missing →
    amber dot, "Needed — Autowright reads incoming messages from the Messages database" and
    an **Open System Settings** button (opens
    `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` externally,
    like every external link), so the status flips to granted moments after the user toggles
    it there.
  - **Messages automation** — the same endpoint's `automation`: granted → green check;
    denied → amber dot, "Denied — turn it on in System Settings → Privacy & Security →
    Automation" (plain text, no deep link — macOS has no pane-level URL for one app's
    Automation row); unknown → muted dot, "Not asked yet — Autowright sends replies through
    Messages" and a **Grant** button calling §19 `POST /imessage/permissions/automation-probe`
    (spinner while it blocks on the macOS prompt; the row re-renders from the result).
  Neither state blocks Add — a trigger saved without permissions parks in the §4.3 `connection`
  error state and heals when granted. Then the editor
  inputs: a **sender input** (placeholder "Sender — +15551234567 or an email"; §4.3 `from`;
  red border while invalid per the §4.3 rule — email, or `+`-prefixed phone after
  formatting strips; the invalid-input preview line reads "Needs a country code (+1…) or an
  email") and the same optional message-filter
  input as Discord (§4.3 `pattern`). Preview line "On iMessage from `<from>`" showing the
  normalized handle; Add stays
  disabled until the sender is valid. Cron and
  One time add a
  **timezone picker** below the input — the app's standard popover pattern (an `ad-btn-pill`
  trigger button: fa-globe icon, the chosen zone's mono name or the muted default "Local
  time", fa-caret-down — opening a `PopMenu`): a filter input at the top (placeholder "Filter
  timezones…", auto-focused, cleared on every open) narrows the list by case-insensitive
  substring; below it a scrollable list — "Local time" first (the default; stores no `timezone`;
  shown only while the filter is empty), then every IANA zone
  (`Intl.supportedValuesOf('timeZone')`), the current choice marked active; picking closes
  the menu. A non-local choice is
  stored as the trigger's §4.3 `timezone`, and the preview line (labels and "next:") reflects it,
  with "next:" always shown in local time. Empty list renders a
  dashed "No triggers" row. Trigger edits apply immediately (§19 PATCH) — no version, no AI.
  No Execute-now button here — manual execution lives in the title row and the menu bar.
- **PARAMETERS** — directly editable here per the §4.2 edit behaviors; caption "Changes apply on
  the next execution — no new version, no AI involved." Row layout splits by control size:
  `toggle` and `number` rows keep label + control on one line — the label side flexes to the
  available width, the control sits vertically centered at the row's right edge, and the help
  text runs below the label at full width. `text`, `list`, and `kv` rows stack — label (with
  the amber NOT SET tag when a text param has no value) and full-width help on top, the editor
  underneath spanning the full card width (text inputs capped at 520px).
- **CONCURRENCY** card — the §6 settings, rendered only when the automation has at least one
  message trigger (nothing else can queue, so the card would be inert otherwise). Two `number`
  rows using the §9.2 row layout: **"Run at once"** (`maxParallel`, min 1) with caption "How many
  executions of this automation may run at the same time." and **"Queue when busy"**
  (`maxQueued`, min 0) with caption "How many incoming messages wait for a free slot. Beyond
  this they're answered with a busy notice instead." Both PATCH immediately like parameters —
  no version, no AI. Below the rows, when at least one firing is waiting, a live line "N waiting"
  with a quiet **Clear queue** button (§19 queue-clear; confirm copy "Cancel N waiting message(s)?
  Each sender is told." — the running execution is not affected, which the copy says).
  The waiting line and the memory caution enter with `.ad-anim-item` when they appear.
  N counts the automation's `queued` execution records (§4.6) held client-side — the same
  source the §7 Waiting section lists, never a separate count carried on the automation.
  One source is what makes the number right: a promoted entry becomes `executing` on its own
  record the moment §19 `execution.started` arrives, so a running execution can never still be
  counted as waiting, and the line can never disagree with the Waiting list.
  Raising `maxParallel` above 1 on an automation whose current version has a step referencing
  memory shows a persistent amber caution under the row, naming those steps: "`<step>` writes
  to memory. Parallel executions share one memory directory (§6), so two runs updating the same
  value can lose one of the updates." No modal and no block — the caution is inline, specific,
  and stays visible while the setting is above 1. An automation whose steps never touch memory
  gets no caution.
- **RECENT EXECUTIONS** — execution history rows (status badge, then the execution id's
  first 8 chars in faint mono — same short id the Executions page rows show — then
  trigger·version — a message-triggered row puts the §4.5 `triggerSender` between them,
  "Discord · Dave · v3" — time, duration, note text when present), linking to execution
  pages.
- **MEMORY** card — mono size/updated info line; "Show in Finder", "Snapshot" and "Clear
  memory" buttons. Clear swaps the button row to an inline confirm: "Next execution starts
  fresh, like the first time. Current memory is snapshotted first." (pre-clear toggle off:
  "Next execution starts fresh, like the first time. Automatic snapshots are off — this
  can't be undone.") with red Clear / quiet Keep. Snapshot swaps it to a name input
  (placeholder "Name — optional", Enter saves) with
  Save / quiet Cancel; the button is disabled when memory is empty (title "Memory is empty").
  Below the info row, the §6.3 snapshot list (absent when there are none): one row per
  snapshot — title (the name, else "Snapshot"), mono meta "reason · version · size · files ·
  when", quiet row actions Restore / Rename / Delete. Restore swaps the row to an inline
  confirm "Replaces current memory — the current state is snapshotted first." (pre-restore
  toggle off: "Replaces current memory — automatic snapshots are off, so the current state
  is lost.") (accent
  Restore / quiet Keep; while an execution is live the row's Restore action is `disabled`
  with the tooltip "Blocked while an execution is live" — never a silent no-op click — and
  a raced 409 still surfaces as a toast);
  Rename swaps to a name input (Save / Cancel; empty clears the name back to "Snapshot");
  Delete swaps to "Delete this snapshot?" (red Delete / quiet Keep). Every inline swap —
  the card's button row and the snapshot rows alike — fades in (`.ad-anim-fade`, a keyed
  remount of the row): opacity only, so nothing jumps. The snapshot list itself enters with
  `.ad-anim-item` when the first snapshot lands. Toasts: "Snapshot
  saved." / "Memory restored — the next execution continues from the snapshot." / "Snapshot
  deleted."
  At the card's bottom, the "Automatic snapshots" section — the §6.3 toggles, one `Toggle`
  row per automatic reason, each with a plain-language explanation so users know exactly
  what they're switching off:
  - "Before a new version executes" — "Saves a copy of memory right before the first
    execution of a newly saved version, so you can restore how memory was if the new
    version mishandles it." (pre-version)
  - "Before clearing memory" — "Saves a copy right before Clear memory empties the
    directory, so a clear can be undone." (pre-clear)
  - "Before restoring a snapshot" — "Saves a copy of the current memory right before a
    restore replaces it, so a restore can be undone." (pre-restore)
  Edits apply immediately (§19 PATCH `snapshotSettings`) — no version, no AI.
- **STEPS** card — read-only step rows (number, name, description; the whole row is a click-to-expand
  disclosure whose only right-edge affordance is a caret — no "view script" text label, so
  narrow windows don't crush the row's middle column; the caret carries a "View script" /
  "Hide script" `title` tooltip; expanding shows the script with §11 `PyCode`
  highlighting; agent steps show the "Why an agent" note when expanded). Steps expand
  independently — opening one never closes another, so each §14 collapse animates alone
  instead of cancelling against a simultaneous close above it. Step tags are
  display-only — never menus, and every tag carries a plain-language tooltip (the §14 Tag
  tooltip bubble — custom, not the native `title`) explaining
  what it shows: an agent step carries one microchip-icon tag per entry in its `agents`
  list (tooltip = the entry's `why` — the §4.1 per-agent role note — falling back to the
  step's `why`, then to "This step calls the `<name>` AI agent."; an empty list shows a
  single tag naming the automation's first enabled agent, fallback "agent", with the
  step-`why` tooltip rule), a step carries one key-icon tag per secret it
  uses (its `secrets` entries' names unioned with the `secrets.NAME` references in its code;
  tooltip = the declared entry's `why` — the §4.1 per-use note — falling back to "This step
  uses the `<NAME>` secret from your Keychain" for code-referenced names with no declared
  entry), and every
  step carries one clock-icon tag showing its §4.1 time limit: the step's `timeout` humanized
  ("60s", "15m", "1h" — hours when divisible by 3600, else minutes when divisible by 60, else
  seconds), the 900 s default ("15m") when the step sets none, "no limit" for `noTimeout`
  steps. Tooltip: "This step is stopped if it runs longer than `<label>`" / no-limit: "No time
  limit — this step runs until it finishes or you cancel or skip it." Agents and
  secrets are changed on the edit page.
- **SPEC panel** — collapsible (expand/collapse header toggle), expanded by default; the automation's spec blocks rendered through the shared §4.5 Markdown renderer, footer: "The AI regenerates the steps from this
  document when you edit it. Every change mints a new version — older ones live in the Version
  menu on the edit page."

**Delete confirm modal** — "Delete this automation?" / "`<name>` will be deleted — its triggers
stop, and its versions and memory go with it. Past results stay in Executions." When an execution is
live an amber line is added: "An execution is in progress — deleting cancels it." (confirming cancels
the execution, then deletes). Buttons Cancel / red "Delete automation".

### 9.3 Developer log overlay

A low-priority debug surface, ComfyUI-style: with the §4.9 `developerMode` setting on, pressing
`` ` `` (Backquote) in the main window toggles a full-window log overlay; Escape also closes it. The
key is ignored while focus is in an editable element (input, textarea, contenteditable) and the
whole feature is inert — no listener effect, overlay never renders — while `developerMode` is off
(turning the setting off closes an open overlay). Main-window surfaces only, never the menu-bar
panel.

The overlay is a fixed panel covering the entire window (full width and height,
z-index above the shell, `--bg-code` well, mono text at 11.5 px,
`pre-wrap`). A slim header row, padded down 38 px so it clears the macOS traffic
lights (pinned at 14,14), holds a `requests` tab first, then one tab per log file —
`app.log`, `backend.out.log`, `backend.err.log`, `vite.log` — file tabs showing only files
that exist, plus a close ×. Active tab persists only for the overlay's open lifetime;
default is the `requests` tab (always present).

Data path (log-file tabs): the renderer polls `window.autowright.tailLogs()` (preload →
`tail-logs` IPC in main) every 1 s while the overlay is open — no file watchers, nothing runs
while closed. Main resolves the logs dir exactly like §5 (`~/Library/Logs/Autowright`, or
`<AUTOWRIGHT_HOME>/logs` when set) and returns `[{ name, text }]` for each existing file of
the four, where `text` is the file's last 64 KiB (partial first line trimmed when the read is
mid-file). The body auto-follows the tail while scrolled to the bottom; scrolling up pauses
the follow until the user returns to the bottom.

**Requests tab** — browses the §5 request-log files (one file per HTTP/agent request under
`<logs dir>/requests/`). Two-pane body: a left column (280 px, scrollable, mono 11 px) lists
the file names **sorted descending** (newest first — the timestamp prefix makes name order
chronological); the right pane renders the selected file's full content with the same
mono styling as the log tabs (no tail-follow — request files are written once,
complete). Clicking a name selects it; the selection persists across list refreshes and is
cleared if its file was pruned. While this tab is active the renderer polls
`window.autowright.listRequestLogs()` (→ `list-request-logs` IPC: sorted-descending name
array, `[]` when the directory is missing) every 1 s; selecting a name fetches it once via
`window.autowright.readRequestLog(name)` (→ `read-request-log` IPC: file text, `null` when
gone; main rejects any `name` that is not a plain basename) — request files are written once,
complete, so no re-fetch is needed. Empty states: "No request logs
yet — make a request with Developer mode on" (empty list) / "Select a request" (no selection
while the list holds files; with an empty list the right pane is blank — the list's own
empty note carries the message).

### 9.4 About page

640 px page (Settings' width), "About" title, reached from the About nav row
pinned at the sidebar bottom (fa-circle-info, no count pill, §9). Three eyebrow
sections with Settings' anatomy (mono eyebrow + card of rows) — **APP**,
**UPDATES**, **LEGAL** — and new about-ish content (credits, support links)
lands in one of these or a new eyebrow here, never on Settings.

Document rows (Privacy policy, Open-source libraries) share one **doc modal**:
width 680, `h2` title, body caps at 62 vh and scrolls, content
rendered through the shared §4.5 Markdown renderer, quiet Close in the footer.
Each document loads through a dynamic `?raw` import so it stays out of the main
bundle, fetched once on first open. A failed load never strands the modal on
"Loading…": the body swaps to a `--red-text` line ("Couldn't load the document.")
with a bordered **Retry** button that re-attempts the import.

**APP**

- **Autowright** — title with the running version beside it in mono (`v<version>` from
  `GET /state`); sub-line "Open source, MIT licensed — the whole app runs on this Mac.";
  right-side "View on GitHub ↗" button-styled link to
  https://github.com/hansololz/autowright (plain `target="_blank"` anchor — the main
  window's window-open handler denies the popup and routes the URL to
  `shell.openExternal`, so it lands in the default browser).

  **External-URL policy** (both windows — main and the menu-bar panel carry the same handler):
  a window-open URL is opened only when its scheme is `https:`, `http:`, or `mailto:`, plus the
  one `x-apple.systempreferences:` deep link the §9 permission checklist uses; anything else is
  dropped silently. §7 result HTML is AI-authored and may echo attacker-controlled text from an
  incoming Discord/iMessage message, so a `file:` (or other registered-scheme) link in a result
  must not be able to launch a local app on a user click. Both windows also block top-frame
  navigation (`will-navigate` → `preventDefault` for anything but the app's own URL): the
  preload exposes the backend bearer token, which must never be reachable from a remote origin.
- **Website** — sub-line "The project's home page — a quick tour of what Autowright
  does."; right-side "autowright.ai ↗" link (same external-anchor mechanism) to
  https://autowright.ai (the §17 `docs/` landing page).

**UPDATES**

- **Updates** — checked automatically by default (§4.9 `automaticUpdateCheck`, default
  true; §3 automatic-check bullet); turning the toggle off restores strict manual-only
  checking — no background or launch checks (PRIVACY.md documents both modes).
  Downloads and installs are manual in both modes.
  Everything runs in the Electron main process over the §3 IPC handlers; the renderer
  never talks to GitHub or the feed itself. The row opens **pre-armed** when the store
  holds `updateAvailable` (fed by the §3 update-available event + invoke at store boot;
  set by any check — manual or automatic — that finds a newer version): it renders the
  `available` state below without a button press. Manual results feed the same shared
  state: `available` sets `updateAvailable` (the §9 "Update available" nav row appears and
  persists across navigation), `uptodate` clears it, `error` leaves it alone — the §3
  clearing rule.
  The "Check for updates" button calls
  `update-check` (one fetch of the §3 feed) and reads "Checking…" (disabled) while in
  flight. Results render in the row's sub-line: `available` → "Version `<x.y.z>` is
  available." and the button becomes **"Download update"**; `uptodate` → "You're up
  to date."; `error` → "Couldn't reach autowright.ai — try again later." The version
  compare (in main) is numeric on dot-split parts, ignoring a leading `v`; a
  malformed version counts as not newer. "Download update" calls `update-download`
  and reads "Downloading…" (disabled); while it runs a §14 `ProgressBar` renders
  under the sub-line, fed by the §3 `update-progress` IPC events — determinate
  percent, or indeterminate when the download size is unknown; after the stream
  finishes it holds 100% while Squirrel stages the zip. On `{ ok }` the bar goes
  away and the button becomes **"Restart to
  update"** with sub-line "Update downloaded — restarts the app, not your
  automations."; on `{ error }` the sub-line shows "Update failed: `<error>`" and
  the button reverts to "Check for updates" (an unsigned dev build always lands
  here — same code path, real Squirrel error). "Restart to update" calls
  `update-install`; a `{ busy }` answer renders "An automation is executing — the
  update installs when you restart after it finishes." and keeps the button;
  otherwise the app quits and relaunches updated (the backend restarts on the next
  launch's §3 version-compare flow). Idle sub-line follows the toggle below: off →
  "Updates are only checked when you ask — nothing runs in the background."; on →
  "Checks once a day — downloads still start only when you ask."
- **Check for updates automatically** — toggle row between Updates and What's new,
  bound to §4.9 `automaticUpdateCheck` (default on). Sub-line "Once a day, ask
  autowright.ai whether a newer version exists. Downloads still start only when you
  ask." Writes PATCH `/settings` like the Settings-page toggles (§4.9 one-apply
  path: the renderer pushes apply-settings on every settings change, and the shell's
  reconcile starts or stops the §3 automatic check — turning it on checks
  immediately). The row lives here, not on Settings — updates are About-page
  territory (§4.9).
- **What's new** — sub-line "Release notes for every version live on GitHub.";
  right-side "Release notes ↗" link (same external-anchor mechanism) to
  https://github.com/hansololz/autowright/releases. The changelog is the GitHub
  releases page — the app never duplicates it.

**LEGAL**

- **Privacy policy** — sub-line "What Autowright collects — nothing — and where
  your data lives."; right-side "View" button opens the doc modal (title
  "Privacy policy") rendering the repo-root `PRIVACY.md` (§17) — the canonical
  copy, shipped into the bundle by the raw import, so the same text serves
  GitHub visitors and the app. The file opens with an `# Privacy policy` H1 for
  GitHub; the app strips the first H1 line before rendering (the modal title
  already says it).
- **Open-source libraries** — sub-line "Everything Autowright is built on, with
  each project's license."; right-side "View" button opens the doc modal (title
  "Open-source libraries") rendering
  `app/src/acknowledgements.md`. The file is generated — never hand-edited — by
  `scripts/gen_licenses.py` (§17) and checked in; `build.sh` regenerates it on
  every build so it tracks dependency changes. It lists every shipped component —
  the npm production closure (`npm ls --omit=dev --all --json`) plus Electron
  (dev dependency, but its runtime ships in the bundle), and the backend venv's
  recursive distribution closure of the `autowright` package (dev extras
  excluded) — each entry: name, version, license id, and the package's license
  text when it ships one.

The LEGAL card ends with a muted disclaimer paragraph (footer text inside the
card, below the rows): "Autowright is provided as is, without warranty of any
kind (MIT License). Automations execute scripts written by an AI agent — those
scripts can do anything your user account can do on this Mac. Review every
change before you accept and execute it. You are responsible for what your
automations do; the author accepts no liability for any damage or loss they
cause."

## 10. Onboarding (2 steps, step label top-right in mono)

Onboarding shows whenever `ad-onboarded` (§15) is unset — existing agents or automations do NOT
bypass it: step 1 always renders. When prior data exists (any agent or any automation), step 1's
Continue goes straight to the app shell instead of step 2. The step label ("Step 1 of 2" /
"Step 2 of 2") renders only when no prior data exists — with prior data step 1 is the only
screen, so no counter shows.

**Step 1 — Welcome.** Logo, headline "Recurring jobs, done exactly the same way every time.",
then a live self-check card "Getting Autowright ready" with three steps (Checking your settings,
Loading your automations, Starting the execution engine) with pulsing dots and durations, ending in a "READY / All set"
well with chips (Settings created, Folders in place, plus "Agent found" if an agent is already
configured and "Automations found" if automations already exist). Continue appears only when
done; its label is "Continue →" when prior data exists (going straight to the app), otherwise
"Connect your AI →".

**Step 2 — Connect your AI.** A searching spinner ("Looking for an AI already on this Mac…",
shown ≥1.9 s), then the §19 `GET /agents/detect` result rendered as cards. Detection reports
the four harnesses (Claude Code / Codex / Gemini CLI / OpenCode) with real installed
and signed-in state; installed harnesses render as "FOUND ON THIS MAC" cards (detail line =
real version plus sign-in state, e.g. "1.0.24 · signed in" / "1.0.24 · not signed in yet"),
and every harness that is
**not** installed renders as a suggestion card alongside (the app helps install all four).
Ollama is never a card of its own — the local path lives entirely in the "Free local AI"
card below (a suggestion card, unless every piece is already present — then it renders in
the found section).
Suggestion cards use the same full-width row anatomy as found cards — a single vertical list
(no tile grid), title plus one-line detail on the left, the action slot on the right; busy
states (install/pull progress, sign-in wait, install failure) stack full-width below the title
line. When at least one provider was found, the suggestion list sits behind its own neutral
eyebrow "OR TRY SOMETHING NEW" (neutral text color — accent stays reserved for the detected
section), which acts as a collapse toggle with a chevron icon: the list starts minimized
(collapsed) and clicking the eyebrow expands/collapses it. The expanded/collapsed state
persists across step navigation like the rest of onboarding state. When nothing is detected,
there is no eyebrow and no collapse — the list is always visible, with a note card above it:
"No AI app was found on this Mac — here are some suggestions for moving forward."

Every card resolves inside itself — there is no page-level Continue button, no radio selection,
and no multi-ready banner. All step-2 cards keep the neutral card border in every state —
no accent tint and no "Connected" label on connect; the Use-as-default button alone is the
success signal (the accent "FOUND ON THIS MAC" eyebrow alone marks the detected section). Each card carries a single
action slot that advances through its states in place. All machines are real — backend installs,
real sign-in checks; no simulation in any mode:
- **Found card, signed in** — the connection check runs automatically as soon as
  the cards land; the user never has to ask for it. The card starts on an inline spinner
  "Checking connection…" (real §19 `POST /agents/check-harness`) → a primary
  "Use as default →" button in the same card — one uniform label on every card (the card
  already names the provider); it states the pick's effect (that provider becomes the
  default agent) instead of a bare "Continue". A failed check shows amber
  "Not ready — `<reason>`" with a "Check again" button.
- **Found card, not signed in** — skips the auto-check (it would fail); sign-in help only
  when necessary: amber "Sign in" button →
  §19 `POST /agents/login` → waiting state (amber pulsing dot; copy matches the login method
  the backend reports: browser for Codex — "We opened your browser — sign in there and come
  back. We'll notice on our own."; Terminal for the others — "We opened Terminal — finish
  signing in there and come back. We'll notice on our own."), with "Cancel" returning to idle.
  The UI polls §19 `GET /agents/signin/{id}` every 2 s; once signed in the card runs the
  connection check automatically and lands on Connected + Use as default.
- **Setup status line** — once every found card's auto-check has settled (none still
  checking), a line under the found section says whether the user can move on: "You're
  ready — pick a connected AI as your default, or set up another below." when at least one
  found card is connected, otherwise amber "More setup needed — finish the steps above
  before continuing."
- **Suggestion card** (one per missing harness) — "Claude" ("Set up Claude Code") /
  "Codex" / "Gemini" / "OpenCode" (each "Set up `<name>`"): install via §19
  `POST /agents/install` → labelled progress ("Installing `<name>`…"; determinate bar when the
  `harness.install` stream carries a percent, indeterminate otherwise) → then the sign-in flow
  above **only if the provider needs an account and isn't signed in** → connected:
  "Use as default →" alone. An install failure shows red
  "Install failed — `<first error line>`" with "Try again". There is no sudo step: every
  install lands in user-writable locations (§19 channels), so macOS never prompts for an
  admin password.
- **Free local AI card** — always shown regardless of what was detected: OpenCode driving a
  local model through Ollama (title "Free local AI"). The card owns three pieces: OpenCode
  installed (from detection), Ollama serving, and a model installed (both from §19
  `GET /ollama/status`) — **any** installed model counts: the first model from
  `GET /ollama/status` becomes the card's model, and `qwen3:8b` is only the download
  fallback when none is installed. The card is the last suggestion card — except when all
  three pieces are already present at detection, in which case it renders as the last
  "FOUND ON THIS MAC" card instead (same card and machine; the found-section status line
  counts it like any found card, and its body reads "OpenCode with Ollama and `<model>` —
  local to this Mac, works offline. Best for simple steps — for authoring automations, a
  cloud option gives stronger results."). Placement is decided once at detection and never
  moves mid-flow — the qwen3:8b recovery download below keeps the card in the found
  section. Every body variant of this card ends with the same fit sentence: "Best for
  simple steps — for authoring automations, a cloud option gives stronger results." With no
  model found the body reads "Sets up
  OpenCode with Ollama and Qwen3 8B. Local to this Mac, works offline." plus the fit
  sentence and the button
  "Download and install · 5.2 GB"; with a model found the body reads "Sets up OpenCode with
  Ollama and `<model>`, already on this Mac. Works offline." plus the fit sentence and the
  button "Set up local AI"
  (only the still-missing pieces install — no model download). When every piece is already
  present as the cards land, the card skips the install button and runs the connection check
  automatically (§19 `POST /agents/check-harness` with harness OpenCode and the card's
  model) → "Use as default →". A failed check shows the amber not-ready line (the
  model-missing reason names the card's model) with "Check again" — plus, when the check ran
  against a found model, a "Download Qwen3 8B · 5.2 GB" button that discards the found model
  and pulls `qwen3:8b` instead (recovery for installed models that can't chat, e.g.
  embedding-only ones). Otherwise the install button runs only the **missing** pieces, in
  order — OpenCode (§19 install), Ollama (§19 install), the model (`POST /ollama/pull` of
  `qwen3:8b`, real percent from the pull stream, continues in the background) — labelled
  "Step k of n — Installing OpenCode… / Installing Ollama… / Downloading Qwen3 8B…" where n
  counts the missing pieces, then lands on the same connection check → connected. A failure
  at any piece shows red "Install failed — `<first error line>`" with "Try again", which
  resumes at the still-missing pieces.

Clicking a card's Use-as-default button is what picks the provider and completes onboarding — it lands in
the app shell, where the empty Automations list (§9.1) invites the first automation; there is
no third step. The picked provider becomes the default agent, all
connected/ready cards are committed as agent records — a harness card as
`{ name: null, harness, mode: default, model: null }`, the Free local AI card as
`{ name: null, harness: OpenCode, mode: ollama, model: <the card's model> }` — the found
model, or `qwen3:8b` after a download (a null name always falls
back to the harness name for display, so agent labels read harness · model, e.g.
"OpenCode · qwen3:8b" — never the model twice) — and any existing
automations get the chosen default agent. While committing, all Use-as-default buttons are disabled
and the pressed one swaps its label for a `LoadingRow`-style spinner + "Setting up…" (§9
busy-commit convention), and "Skip for now" disables with them (it fires the same commit —
an enabled skip would double-fire it). Otherwise "Skip for now" is always
available (commits any connected providers, goes to the app). Persistent footer: the two
green-dot promises (§1).

Installs and model downloads run in the backend, so an in-flight model download keeps going
after onboarding hands off to the app — it "finishes in the background" as promised. Installs
never need admin rights (§19 channels are all user-writable), so there is no sudo or
permission-declined state anywhere in the flow.


## 12. Agents & Secrets pages

**Agents.** Tile grid of agent cards — same grid as the Automations list (§9.1,
`repeat(auto-fill, minmax(310px, 1fr))`), not a vertical list. Cards carry no action row —
only the transient `LoadingRow` (Checking locally… / Reconnecting…) pins to the card bottom
(`margin-top: auto`) while a check is in flight. Badge states Checking (cyan) / Connecting / Ready (green) /
Needs setup (amber). Statuses are cached in the renderer for the app session: each agent is
checked once, staggered, on the first Agents page visit that sees it (new agents get checked on
the next visit); later visits render the cached badge with no re-check. The cache entry for an
agent updates when its edit form saves ("Connecting" until the fresh result lands, §4.7 check
re-run right after the save) and when the reconnect flow's check answers (§12 form banner).
Each card shows the agent's `description` detail line — the real §4.7 description only, never
generated marketing copy (the description is drafting input, §8 grants yaml); when the description is empty
the line reads "No description yet — add one in Edit to tell the drafting AI what this agent
is for." —
and a **USED BY** row of clickable automation chips (fallback "Not used by any automation yet.").
USED BY means actual reference, not permission: an automation is listed when the agent is its
writer (`agent_id`) or a current-version step names the agent's grant name in its `agents` list. The
`enabled_agents` grant alone never counts — same rule as secrets, whose usage is step-code
references, not `allowed_secrets` (§12 Secrets).
There is no Edit button —
the whole card is clickable (same hover treatment as the Automations list tiles) and opens the
§12 edit form; a Needs-setup card opens it with the reconnect banner. Clicks on the overflow
menu and on USED BY chips do not navigate. The card's overflow (ellipsis) menu
button sits at the card's top right, on the title row, visible in every badge state (while a
check is in flight only "Remove agent…" is offered); its popover opens right-aligned. The
overflow menu holds, for
ready agents, "Check connection" — a real §19 `/agents/{id}/check` call timed by the
renderer: the badge returns to Checking while it runs, success toasts "`<name>` answered in
X.X s — ready.", failure flips the badge to Needs setup and toasts "`<name>` didn't answer —
needs setup." — and, when not default, "Make default" (toast "`<name>` is now the default —
new automations use it.", the name falling back to the harness name); for every agent it holds
"Remove agent…" (red, confirm modal). Confirming the removal plays the §14 grid-card removal
exit: the card fades out-down at exit timing, then the surviving cards slide (FLIP) into their
new grid slots; if the delete request fails the card is restored in place. Default status is
indicated by the absent "Make default"
menu row — no chip. Empty state (dashed card): "No agents yet. Existing automations still execute on
schedule — but you need an agent to create or edit them." + CTA "Add your first agent".

**New / Edit agent** form (720 px, one form — title "Add an agent" and submit "Add agent",
switching to "Edit agent" / "Save changes" when editing). Edit mode is addressed by navigation state: opening a card puts
the agent's id (`agentEditId`) in the nav snapshot, so browser back/forward re-enters the same
edit form — never a blank add form; navigating anywhere else clears the id, and if the agent no
longer exists the form redirects to the Agents page. The reconnect banner keys off the
session-cached agent check being `needs` for that id. Fields, top to bottom in rendered
order: name (required, placeholder "Name this agent"), optional description ("What this
agent is for — shown on the Agents page and given to the drafting agent"), pick harness
(Claude Code / Gemini CLI / Codex / OpenCode — all four selectable, §4.7), then the MODEL
section — the mode rows live inside it (option labels "Default model" / "A specific model"
(note "Type the model this harness should use") / "A local model" — the specific-model
option renders for every harness; the local-model option renders enabled when the harness is
Claude Code, Codex, or OpenCode (§4.7) and carries the note "Pick a model served on this Mac
through Ollama — best for simple steps"; when the harness is Gemini CLI the local-model row
renders disabled with the note "Gemini CLI can't drive local models." — a disabled row is
never selectable, and switching to Gemini CLI while the local-model mode is picked moves the
selection back to "Default model") — with the model input below (required for specific-model and
local-model modes — the specific-model mode shows a mono free-text input with a per-harness
placeholder: Claude Code "e.g. claude-opus-4-8", Gemini CLI "e.g. gemini-2.5-pro", Codex
"e.g. gpt-5-codex", OpenCode "e.g. anthropic/claude-opus-4-8"; OpenCode expects the
provider/model form).
**Install gating:** the form loads real install state on mount (§19 `GET /agents/detect`; a
failed detect gates nothing). An uninstalled harness's card carries an amber NOT INSTALLED
`MiniBadge` and stays selectable, but while the picked harness is uninstalled the MODEL section
is hidden, saving is gated (submitting toasts "Download and set up `<Harness>` first."), and an
amber notice "`<Harness>` isn't installed on this Mac yet — Autowright can download and set it
up for you." offers **Download & set up** — the real §19 `POST /agents/install`, rendered like
the Ollama install card ("Installing `<Harness>`…", determinate bar only when the
`harness.install` stream carries a percent; failure "Install failed — `<first error line>`" +
Try again; a form that finds the install already running for the picked harness reattaches via
§19 `GET /agents/install/{id}`). After a finished install the form asks §19
`GET /agents/signin/{id}`; when signed out it starts the §19 sign-in help
(`POST /agents/login`) and shows "Finish signing in — Autowright opened Terminal / your
browser. Waiting for the sign-in…" with a **Reopen** button, polling `GET /agents/signin/{id}`
every 2 s. Setup finishes (install done, plus sign-in when it was needed) with a re-detect and
the toast "`<Harness>` is set up — ready to save.", which ungates the form. An
already-installed but signed-out harness never gates — saving such an agent surfaces through
the Needs setup badge and the reconnect banner, as before. The
submit button renders disabled-styled until valid but stays clickable: submitting with a missing
name shows an inline red error "A name is required — give this agent a name before saving." (red
input border, clears on typing); an uninstalled picked harness toasts "Download and set up
`<Harness>` first."; missing Ollama toasts "Install Ollama first."; otherwise "Pick
a harness and a model first." Success toasts: "`<name>` added — ready to write automations." /
"Changes saved — `<name>` is ready." When editing a signed-out agent, the form shows a reconnect
banner: "This agent is signed out — reconnect it to create or edit automations." + Reconnect
button. The local-model mode is gated on Ollama being
installed and ready: while missing, the notice "Local models need Ollama, which isn't
installed on this Mac yet."; once ready, a green check "Ollama is installed and active."
Inline install flow: button "Install Ollama" starts a real §19
`POST /agents/install` for Ollama; the label "Installing Ollama…" renders a determinate bar
when the `harness.install` stream carries a percent (indeterminate otherwise), and failure
shows "Install failed — `<first error line>`" with the button returning to "Install Ollama".
**LOCAL MODEL** picker: radio list of installed Ollama models with
size metadata, empty state "No local models installed yet — download one below and it will show
up here." Model pulls: one at a time — the backend streams raw `ollama pull` output over the
`ollama.pull` WS event and the UI parses the percent out of it (right column shows "N%";
determinate bar when a percent is present, indeterminate otherwise — real `ollama pull` output
may not yield a percent); suggested-model
chips fill the pull input (placeholder "e.g. qwen3-coder:30b"; they don't start the pull); suggested models qwen3-coder:30b (19 GB,
"Best local coding model"), gemma4:e4b (9.6 GB, "Good local default"), deepseek-coder:6.7b
(3.8 GB, "Light and quick"). A suggestion chip is hidden when that model is already installed or
currently downloading; when no chips remain, the whole SUGGESTED section is hidden. Below the
pull input: link "Browse more models on Ollama ↗" (opens https://ollama.com/library).

**Secrets.** List with add/edit modal, masked values, delete confirm (§4.8 — the confirm
modal is titled "Delete this secret?" with the danger action "Delete secret"). The list's NAME
cell shows the secret's `description` as a muted sub-line when present, and an amber **NOT SET** tag
(same tag style as §9.2's NOT SET param tag) when the secret is a §4.8 placeholder — the tag
clears once a value is saved, and the placeholder's VALUE cell shows a faint "—" instead of
the mask. The name field is a
single-line input (Enter saves, Escape closes); its placeholder is a hint, not a literal example
value: "A short name, like MAIL_PASSWORD or CRM_API_KEY". Below the name sits an optional
single-line DESCRIPTION input (placeholder "What this secret is for — helps the drafting agent
pick the right secret"), pre-filled when editing. The value field is a 3-row vertically
resizable textarea (multi-line values allowed, §4.8) masked with `-webkit-text-security` unless
Show is toggled; Enter inserts a newline, Cmd/Ctrl+Enter saves, Escape closes; when editing, a
blank value keeps the stored one (§4.8) and the placeholder says so. A new secret saved with a
blank value becomes a §4.8 placeholder (the add modal's value placeholder reads "Paste the
password or API key — or leave blank to add the value later"; the success toast is then
"Saved — add the value before an automation needs it."). The edit modal is titled
"Edit secret" with submit "Save changes"; add is "New secret" / "Save to Keychain". The
add/edit modal is a shared component (`SecretModal.tsx`) — the §9.2 Discord trigger editor
opens it in add mode from its New secret button and receives the saved name via an
`onSaved` callback. Toasts:
"Saved to your Keychain." / "Secret updated." / "Removed from your Keychain." When no secrets exist, the table is replaced by an
empty state (dashed card, same pattern as the Automations list): "No secrets yet. Add a password
or API key once, and your automations use it by name — the value never appears in a script or a
log." with an accent CTA "Add your first secret" that opens the add modal (all three empty-state
CTAs — automations, agents, secrets — are accent-primary; the page-header Add buttons on Agents
and Secrets are accent-primary too — each page's single main create action, §9 — no icons).

## 13. Menu-bar surface

Tray icon (the §14 app mark, inverse: a solid rounded square with the AW ligature knocked out —
monochrome, so the normal state still works as a macOS template image) with red alert dot when
any automation failed —
implemented as a second, non-template icon variant (`trayAlert.png`, mid-gray glyph + red dot,
generated by `scripts/gen_tray_icon.py`); the normal state uses the black template image. The dot has two
feeders: the renderer updates it live over IPC whenever it refreshes state, and the main
process itself polls `GET /automations` every 60 s — the app can sit tray-only with zero
renderers alive (window closed, panel never opened), and a scheduled failure in that state
must still light the dot (and a later success must clear it). Panel: 334 px translucent
(blur), height grows with content up to the 640 px window cap — past that the automation
rows list scrolls (native overlay scrollbar, per the §14 no-custom-scrollbar rule) while the
header and footer stay pinned. The window tracks the panel's full rendered
(border-box) height, rounded up, via a `ResizeObserver` — a content-only measure
(`scrollHeight`) excludes the 1 px border, and a single measure at first render runs
before fonts finish loading; either way the footer's bottom edge gets clipped. Header row with "AUTOWRIGHT" eyebrow left and aggregate status right (mono 11 px; "All good
· N automation(s)" — pluralized by count — or "N need(s) attention" in red), one row per automation (7 px status dot —
pulsing while executing, name, mono sub-line colored by state: cyan "Executing now…" / red when failed
/ accent for a result chip / faint otherwise, relative time right-aligned in a 56 px column, then
the §9.1 square inline execute button (`ad-btn-exec`, 24 px: solid accent with a play glyph →
spinner + disabled while executing, tooltip explains) at the row's right edge — the same run
button as the Automations list). Row click opens the app on that automation; execute
button triggers a "Menu bar" execution. Footer: accent "Open Autowright" link + version. Click-outside
closes. The panel renders its own `Toast` (the §9 toast, bottom-center of the panel): an
execute that fails (e.g. the §7 409 no-free-slot) toasts the error message — a tray
execute press is never a silent no-op. The panel window is not closable, minimizable, or fullscreenable — the default
application menu stays active, so Cmd+W/Cmd+M must be no-ops for it (a destroyed or
minimized panel would otherwise strand the tray toggle on a dead reference). Belt and
braces: a `closed` handler clears the reference anyway. The panel is visible on all
Spaces including over fullscreen apps (`setVisibleOnAllWorkspaces` with
`visibleOnFullScreen`) — opening it never switches the user out of a fullscreen Space.

**Deep-link mechanism:** a row click sends the target `'/app?auto=<id>'` to the main process.
With no main window, the window is created loading that hash and the renderer's boot reads
`auto=<id>` to land on the automation's detail page. With an existing window, main pushes the
target over IPC (`open-target`) and the renderer navigates in place — never a page reload,
which would drop the WebSocket and all renderer state. The footer link sends plain `'/app'`
(focus only). Deep links are ignored while onboarding hasn't completed.

