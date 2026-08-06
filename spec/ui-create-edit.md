# Autowright SPEC — Create / edit flow

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 11. Create / edit flow

Entry: New button, onboarding step 3, Edit on a detail page, or a §7/§9.2 **Fix with AI**
button on a failed execution. If no agents exist (outside
onboarding), redirect to Agents with toast "No agent yet — add one here first. Creating and
editing automations needs an AI."

**Editor layout — chat pane + review grid.** The editor is **one screen from birth to
save**: there is no separate Ask screen and no building screen. A **floating chat panel**
sits at the left edge of the content area, matching the §9 nav rail's panel language and
vertical rhythm: `clamp(340px, 26vw, 420px)` wide (420 px on wide windows, shrinking with
the window so the review grid's two columns keep room on small ones), top edge at 46 px and
bottom edge 12 px above the window
bottom (sticky — it never scrolls with the review pane), 12 px radius on all four corners,
card background with a 1 px `--border-card` border, own scroll, and a 12 px gap on its left —
from the rail's 58 px reserve in the shell, from the window edge in onboarding (one geometry
in both modes: the 46 px top clears the traffic lights, so the panel needs no header padding
and no `no-drag` handling — it starts below the §9 drag strips, like the rail). The review
pane's content background shows around the panel. Beside it the **review pane** holds the
Review grid (1800 px max-width, below) and scrolls independently. One gap value between
content columns: the chat pane → grid gap equals the grid's own 18 px column gap (the
review pane's left padding), while the pane keeps 30 px right-edge window padding. The chat pane is the
editor's only conversational surface — agent-mediated spec edits, questions, blockers,
failure analyses, and drafting progress all render in its thread; direct manipulation (the
spec card's Edit, grants, sync, test) stays in the cards. The §9 collapsible sidebar rule
applies unchanged; the chat pane never collapses.

**Chat pane anatomy.**

- **Header:** the **drafting-agent picker** alone, left-aligned — no `CHAT` label; the
  thread and input make the pane self-evident, so the picker pill (`name · model`, menu
  opening downward over the thread, left-aligned so it stays inside the pane) is the
  pane's identity. The picker lives here —
  the agent is a property of the conversation (it answers chat, writes the spec, generates
  the steps), so it is chosen where its output appears. Same gating as every other rewrite
  input (disabled while a §8 job is in flight); picking an agent shows the confirmation
  toast "`<name> · <model>` now writes the spec and steps here." and, in edit mode, marks
  the draft touched.
- **Thread:** scrolling body, newest at the bottom, auto-scrolled on new content. Entry
  kinds (persisted shapes per §4.4; progress is transient editor state):
  - **user** — the message as quiet plain text.
  - **answer** — the agent's reply rendered through the shared §4.5 Markdown renderer.
  - **rewrite** — a "Spec updated" event: the one-line summary, the out-of-sync note
    ("The workflow is out of sync — sync the steps before saving."), a ghost **Undo**
    action shown while the spec-undo snapshot below exists (same visibility rules as the
    spec-card Undo button; both trigger the same restore), and — while the workflow is
    still out of sync — an inline ghost **Sync now** action (the same §8 sync call and
    gating as the panel's button), so the most common next step sits on the event itself.
  - **blockers** — the §8 blocker list as editable cards (below).
  - **system** — a quiet one-line status chip ("Steps synced with the spec.", "Sync
    stopped — the workflow is still out of sync.", the §7 Fix-with-AI failure seed, the
    run-settled entries below, "Build instructions updated.", "Notes updated.",
    "Renamed to `<name>`.", "Description updated.").
  - **error** — a red-tinted failure entry (a failed §8 job's message, the Failures
    paragraph below). Persisted like the other kinds (§4.4), so it survives a reload and
    reaches the agent's CONVERSATION context.
- **Input:** pinned footer, an auto-growing textarea — the **ask-box pattern** referenced
  throughout this spec: sized to its content, never scrolls, no manual resize handle, Enter
  sends, Shift+Enter inserts a newline. The box is sized the moment it mounts (not only
  when the text changes), so the first keystroke never shifts its height. A send button sits beside the textarea — "Draft it"
  in the create empty state, "Send" otherwise — disabled while the input is disabled or
  holds only whitespace. Placeholder "Describe the job — one sentence is
  enough." while the draft has no spec (fresh create), else "Change something, or ask a
  question…"; while viewing an old version the input is disabled with the placeholder
  "Back to the draft to edit or ask." (and while a test executes, "Wait for the test to
  finish." — the busy hint below). Placeholders stay on one line — they truncate with an
  ellipsis rather than wrap when the pane is at its narrow end (the auto-grow sizes to
  typed content only, so a wrapped placeholder would clip). Sending with no spec yet starts the §8 **create** job with the text as the
  description; otherwise it starts a §8 **chat** job with the in-editor draft as `current`
  (spec + steps + instructions + notes), the in-editor grant arrays, and the recent thread
  (§19 `chat`) — answers and rewrites match what's on screen, unsaved edits included; the
  backend adds the §8 RECENT RUNS and PACKAGES context itself, so the agent reads test and
  execution output (success and failure) without any extra ceremony. The
  response decides the outcome (§8) — one response may combine an answer with rewrites and
  actions, applied in this order:
  - an **answer** appends an answer entry (first, when rewrites follow);
  - a **spec rewrite** replaces the spec exactly like a manual spec edit — out-of-sync
    marking, toast "Spec updated — the workflow is out of sync. Sync the steps before
    saving.", the spec-undo snapshot stashed — and appends a rewrite entry (the toast is
    skipped when the response's actions immediately sync);
  - an **instructions rewrite** replaces the Build-instructions text like a manual
    instructions Save (same dirty gating) and appends a system entry ("Build instructions
    updated.");
  - a **notes rewrite** replaces the §4.1 notes document (never dirties the workflow) and
    appends a system entry ("Notes updated.");
  - **actions** (§8 `actions.yaml`) run after the rewrites land: `name`/`desc` apply like
    the pencil edits (create: the draft's fields; edit: the immediate §19 PATCH) with a
    system entry; `sync: true` starts the §8 sync at once — exactly as if the user pressed
    Sync now — unless syncing is gated (a running draft test, viewing an old version), in
    which case a system entry says why ("Sync skipped — finish the running test first.");
    `test: true` arms a **pending test** that starts the moment the workflow is in sync —
    immediately when it already is, after the chained sync succeeds otherwise (`test: true`
    implies the sync when the workflow is out of sync, §8) — using `test_values` as the
    test's §19 `paramValues` (they also pre-fill the panel's expanded test-value editors);
    the pending test is dropped, with the system entry "Test skipped — the steps aren't in
    sync with the spec.", when the sync fails, blocks, or is
    cancelled, or when anything else rewrites the workflow first. Grants and Save/Create
    are never agent actions (§8): the chat can walk the draft all the way to green, but
    permissions and the final commit stay user clicks;
  - a **blocked** job appends a blockers entry (source: chat).

  **Footer action block — the page's only live job surface.** While any §8 job is in
  flight (create, chat, or sync, however started), the footer swaps the input for the
  action block: a spinner, the job's stage label ("Working on the request…" / "Writing the
  spec…" / "Installing the packages…" / "Generating the steps…" / "`<agent>` is rewriting
  the steps from your spec…"), a compact **activity feed** beneath it — up to three of the
  newest §8 `events` lines as dim history (oldest first, single-line ellipsis) above the
  live §8 `detail` line; when `detail` extends the newest event (same message, growing
  ` · N lines` count) that event shows only as the live line, never twice — and a ghost
  **Cancel** anchored to the block's bottom edge, so it holds still while feed lines
  accumulate and the block grows upward
  (`DELETE /drafts/{jobId}`; cancelling a chat/create job returns the request text to the
  input for editing, sync-cancel semantics under Dirty gating below). Pinned like the
  input, so it never scrolls away with the thread; it reverts to the input when the job
  settles, and its outcome lands as ordinary thread entries. Every other place on the page
  shows only static text while a job runs — no second spinner, live `detail` line, or
  Cancel anywhere. The draft **test** is not a §8 job and never appears here: while a test
  is executing the input stays, disabled with the hint "Wait for the test to finish." (a
  rewrite would pull the workflow out from under the running test), and the test's live
  controls (progress, Cancel, View run) stay in the Build & test panel.
- **Create empty state:** headline "What should Autowright do for you?" over the thread
  area, then an "OR START FROM AN EXAMPLE" eyebrow over icon-led example chips (fa icon +
  label; accent-tinted border/background on hover, 1 px press-down on :active): Track manga
  chapters (fa-book-open) / Back up a folder every night (fa-box-archive) / Email me a
  weekly report (fa-envelope) / Watch a product's price (fa-tag) / Tidy my screenshots
  folder (fa-broom). Clicking a chip fills the input (it never sends). Footer reassurance
  line: "Your AI writes the steps — Autowright still executes everything on this Mac."
  Edit-mode empty state (no stored thread): "Ask anything, or describe a change — your AI
  answers here and rewrites the spec when you ask for changes."
- **Thread lifetime:** the thread rides the draft (§4.4 `chat` → §5 `chat.jsonl`): kept on
  every draft-keep path, restored when a draft resumes, deleted when the draft settles
  (discard, save, Create, Start over). The footer action block is transient editor state,
  never persisted.

**Drafting on Review.** The first chat message starts the §8 create job; the review pane
renders in a drafting state and fills in as the pipeline delivers, driven by the job's
`stage` polled from `GET /drafts/{jobId}`:

- **Title row** — name shows the placeholder "New automation…" until the spec lands, then the
  spec's `#` title as the provisional name; call 2's manifest `name` replaces it. The Start
  over ghost cancels any in-flight job, deletes the pending slot (thread included), and
  returns the editor to the create empty state with the description back in the input.
- **Spec card** — force-open, static "Writing the spec…" line (agent label, no spinner —
  the live surface is the footer action block). The moment call 1
  validates, the spec renders — while the steps are still generating — and is readable and
  editable right away.
- **Right column** (steps, triggers, parameters, packages) — static placeholder cards: plain
  text, no spinner and no stage label, one line per card — "Steps appear here once the build
  finishes." / "Triggers appear here once the build finishes." / "Parameters appear here once
  the build finishes." / "Packages appear here once the build finishes.".
- **Live progress** — the footer action block (Input above) is the only live drafting
  surface: the §8 stage label with the activity feed beneath it (recent §8 `events` as dim
  history over the live `detail` line), so a minutes-long call never looks stuck and web
  reads / retries stay visible. The spec card shows its static "Writing the spec…" line
  while call 1 writes, and the Build & test panel shows only the coarse stage label (state
  1 under the panel's spec below). No detail (a non-streaming harness) leaves just the
  stage label.
- **Editing while the steps generate** — any spec / build-instruction / chat-rewrite / grant
  change cancels the in-flight steps call (`DELETE /drafts/{jobId}`), keeps the landed spec,
  and marks the workflow out of sync; the Build & test panel rebuilds the steps. Catching a
  bad spec early costs nothing.
- **Failures** — a `failed` job means a harness error or crash (§8: a validation
  double-failure never ends `failed` — it settles `blocked` with diagnosed blockers, handled
  under Blockers below). A spec-call or chat-call failure renders in the thread as a
  red-tinted error entry with the §8 failure message and, for a spec-call failure, a
  **Try again** action (new create job, same description — the text also returns to the
  input). A steps-call failure renders in the Steps card
  with the failure message and **"Rebuild the steps"**, which runs a §8 `sync` against the
  landed spec.
- **Saving** — blocked while any §8 job is in flight (Dirty gating below); a create draft
  cannot save until steps exist and are in sync.

**Blockers.** When a §8 job ends `blocked`, the
blockers render as **one thread entry** — never a modal, never inline in a card. Headline:
"Your AI hit a blocker" ("Your AI hit N blockers" when several); a job carrying
`diagnosed: true` (§8 build-diagnosis blockers — the build failed validation rather than
the agent refusing) instead headlines "The build failed — your AI suggests these fixes".
Beneath it an explanatory line by source: spec call — "It couldn't write a spec for this
request. Answer below — your answers are added to the request and the spec is rewritten.";
chat — "Answer below — your answers are sent back and the spec is rewritten."; steps call —
"It couldn't build the steps as the spec asks. Edit the fix below, then apply it to the
spec and rebuild."; sync — "It couldn't sync the steps with the spec. Edit the fix below,
then apply it to the spec and sync again." One card per blocker with
three labeled, editable text fields — **Reason** / **How to fix** / **Details** — pre-filled
from the agent's answer; the user edits any of them (usually the fix). Card look: an amber
left accent bar, and — only when the list has several blockers — a "BLOCKER N" eyebrow header.
The fields are auto-growing textareas (ask-box pattern) with comfortable minimum heights —
roughly two text lines for Reason and Details and three for How to fix, the main editing
target, whose box also draws a slightly brighter border and carries the placeholder "What
should change so this can be built". A focused field shows an amber
border. The fields lock (read-only) whenever the entry's primary action is unavailable —
while any §8 job is in flight or an old version is being viewed — and unlock again when
the gate clears. Each blockers entry closes with a quiet **Dismiss** and one primary action, by
source:

- **Spec call** (create) and **chat** — the clarification case: primary **"Answer & rewrite
  the spec"**. On a spec-call block it appends the cards to the description — one line per
  blocker, "`reason` — `fix`", using the edited text — and starts a new create job; on a
  chat block it sends the same lines as a new chat message (a fresh user entry), so the
  agent rewrites with the answers in hand.
- **Steps call** (create) and **blocked `sync`** — primary **"Apply to the spec & sync"**.
  It writes each card into the
  in-editor spec under a `## Constraints & resolutions` section (created on first use,
  extended after), one bullet per blocker — "`reason` — `fix`" — then runs a §8 `sync`
  against the amended spec and the Build & test panel re-enters "Generating the steps". The
  resolutions live in the spec document itself, so they survive later edits and syncs and
  version like any spec text. If the rebuild blocks again the new entry carries a muted
  "Previously resolved" list of this session's earlier resolutions, so a fix that didn't
  take is visible.

Dismiss collapses the entry to a one-line muted summary ("N blockers — dismissed";
singular "1 blocker — dismissed") and, for
steps/sync blocks, leaves the workflow out of sync with the spec editable and the panel
showing out of sync. A completed sync collapses any pending blockers entry the same way —
its blockers describe steps that no longer exist. No automatic loop cap — the cycle is
user-driven and Start over/Dismiss always exits.

**Review.** 1800 px max-width page. Title row: name (single line, shrinks with ellipsis so a long name never pushes the
buttons out of the window), version dropdown (edit mode), Start over ghost
(edit: "Discard draft"), primary Create/Save — labeled "Create automation" in create mode,
"Save as vN+1" in edit mode, and "Restore vX as vN+1" while viewing an old version. The title is the plain automation name in both
modes — never an "Edit …" framing. It is editable in place: a small pencil sits beside it,
always visible on this page (no hover reveal — `.ad-title-rename.always`); clicking the
pencil — only the pencil, never the title text itself — swaps the title to a single-line
input holding the draft's name; Enter or blur
commits, Esc cancels, and a blank result keeps the old name. Create mode: a rename updates
the draft's `name` — it persists with the §4.4 pending slot and lands on Create. Edit mode: a
rename applies immediately through the §19 PATCH —
it is independent of the draft (Discard draft never undoes it; the vN+1 draft doesn't carry a
name). Either way a rename never marks the workflow out of sync or gates Save: name is
user-owned identity (§4.1), not versioned content. The rename affordance hides while a
drafting/sync/agent-rewrite job is in flight and, in edit mode, while viewing anything but
the draft in the Version menu (Restore never renames). In create mode the usual
provisional-name flow (spec `#` title, then the manifest name) still runs — renaming becomes
available once drafting has finished.
Lede line, under the title: the automation's `desc` (§4.1). (The drafting-agent picker
lives in the chat pane header, not here.) The desc is editable in place with the same
pattern as the name (always-visible pencil as the only click target, single-line input,
Enter/blur commits, Esc cancels) and the same gating (hidden while a job runs or while
viewing an old version). The lede row is height-stable: the rendered text and the in-place
input live in one fixed-height row, so entering or leaving desc edit never shifts the page
below. A
blank commit clears the description (it is optional); with no description the line shows the
muted empty state "No description yet — press the pencil to add one." Create mode: until drafting has
finished, the lede instead reads the static drafting lede "Read what your AI wrote. Change
anything — nothing executes until you create it."; once drafting settles it becomes the
editable description. Edit mode: a desc edit applies immediately through the §19 PATCH (like
the name — independent of the draft); create mode: it updates the draft's `desc`, persists
with the §4.4 pending slot, and lands on Create. Sync never touches name or desc (§8: both
are create-only manifest keys). When an execution is live during an edit, a cyan pulsing banner
shows: "An execution is happening right now on vN. Saving won't interrupt it — that execution finishes on vN.
vN+1 takes over from the next execution (`<short label of the next trigger>`)." Sections (left column: spec, notes,
agents, secrets, instructions, framework — the spec and the agent's working notes on top, the
grant cards under them, the standing-rules cards last: build instructions second-last, the
read-only framework reference closing the column; right column: the Build & test panel on top,
then steps, triggers, parameters, packages). Motion on this page follows §14: every collapsible card
animates open/closed through the Collapse primitive — the body **and** the collapsed hint,
which hand off as a crossfade per the §14 collapsible motion (content fades while the rows
resize; open decelerates at `--t-enter`, close accelerates at `--t-exit`) — never clipped
text or two competing height animations; **every** collapsible card header on this page (spec, build
instructions, notes, agents, secrets, framework, packages) follows the framework-card pattern:
the whole header row toggles the card and is an `.ad-hover-row` hover surface (a card held
open — the spec card while writing or being edited, the build-instructions and notes cards
while being edited — keeps its header inert: no hover tint, default cursor, no collapse
mid-edit). The step rows and the agent/secret checklist rows are `.ad-hover-row`
surfaces too. Card-header actions (Edit / Cancel / Save and the ghost Undo / Reset to default)
are compact borderless text buttons at the small text-button size — Edit muted, Cancel / Undo /
Reset to default faint, Save link-styled in accent — never bordered or filled boxes: chat is
the primary way to change these documents, so the manual controls stay quiet. Their line box is
tightened (line-height 1) so they never exceed the eyebrow line: every card header — with or
without actions, open or collapsed — is exactly the framework card's header height. The six
left-column cards render through **one shared card template** (header row, collapsed hint,
body top-hairline), so the treatment cannot drift per card; the collapsed hints and the
in-card empty states share one text style (11.5px/1.5 faint sans) **and one left edge**
(the 43 px eyebrow indent), so an empty card's text stays put when the card opens — a
card's description never changes size or position between its collapsed and open states.
The collapsed line is **status-aware**: a card holding content shows a one-line preview of
that content (single line, ellipsized — notes and build instructions show their first
meaningful text line with markdown markers stripped; agents shows the enabled agent names,
secrets the allowed secret names, packages the package names, each " · "-joined), while an
empty card shows its explainer sentence — the explainer teaches exactly when there is
nothing to preview, and a collapsed filled card reads as a summary of this automation
instead of repeated manual text. Two cards always show their explainer: the spec card (its
first line would duplicate the page title) and the framework card (a static built-in
document). Rendered-markdown card bodies
(spec, build instructions, notes, framework) share **one markdown body wrapper** too: same
padding, same 440 px max height with inner scroll (§14 overlay scrollbar), same full-bleed
table allowance — markdown looks identical in every card. Clicking a header
action never toggles the card it sits in;
in-card notices (grant warnings, failed-test status) and the expanded test-parameter
editors enter with
`.ad-anim-item`; thread entries enter the same way:
- **Spec** — collapsible card (fully-clickable header row like the other cards; defaults open on create — it is
  the drafting surface — and on edit; force-open while the spec is writing
  or being edited, and the Edit/Cancel/Save
  buttons + body hide when collapsed; collapsed, a faint one-line hint shows in their
  place — "What the automation should do, in plain words. The AI regenerates the steps from
  this document when it changes." — and clicking it expands the card, same as the other
  collapsed-section hints on this page). Open, the header is the same bare row as every other
  card — caret + `SPEC` eyebrow + the header actions, no inline subtitle; the explanatory line
  lives only in the collapsed hint. Editable as markdown-ish text (`#`, `##`, `-`,
  plain ↔ h1/h2/li/p blocks); the view state renders through the shared §4.5 Markdown
  renderer. Both body states are height-stable: the rendered view and the in-place editor
  each size to their content and share the same max height (440 px) with inner scrolling.
  Scrollable card bodies use no edge-fade mask — content clips plainly at the padding edge;
  their scrollbars follow the §14 overlay scrollbar style (trackless thin thumb). The editor is
  an auto-growing textarea (ask-box pattern, no manual resize handle), so
  toggling Edit/Cancel/Save never jumps the card height. The card carries **no ask box** —
  agent-mediated edits happen through the chat pane: a §8 chat rewrite (the chosen drafting
  agent — the automation's agent, falling back to the default agent — receiving the
  in-editor draft and grants) replaces the spec and marks the workflow out of sync exactly
  like a manual spec edit (toast "Spec updated — the workflow is out of sync. Sync the steps
  before saving."), and the Build & test panel's "Sync now" rebuilds the steps later; while
  the chat job is in flight the Save hint reads "Rewriting the spec…", and cancelling it
  from the footer action block leaves the draft untouched (toast "Edit stopped — the
  spec is unchanged."). On failure the §8 error renders as a thread error entry; a `blocked`
  outcome renders a thread blockers entry (source: chat) — either way the draft is
  untouched. Manual spec/instruction edits are mutually exclusive (one edit at a time), and
  both are locked while a chat/sync job runs (inputs lock below).
- **Spec undo** — one-level snapshot. Applying a chat rewrite or an
  in-editor Save first stashes the previous spec blocks together with the dirty flags of that
  moment. While a snapshot exists, a ghost **Undo** button shows next to Edit in the spec-card
  header (hidden while the card is in an edit/busy/blocker/error state or a rewrite/sync job is
  in flight). Clicking it restores the snapshot's spec, clears the snapshot, and — only when the
  current out-of-sync cause is still the spec — restores the snapshot's dirty state too (so
  undoing the sole unsynced spec change unblocks Save; an intervening agent/secret change keeps
  its own out-of-sync state). Toast: "Last spec change undone." The snapshot is single-level —
  each new agent rewrite or in-editor Save replaces it — and it clears on a successful sync, on
  a repair-block spec amend, and on loading a version from the Version menu. It lives only in
  editor state: it is not part of the serialized draft and does not survive leaving the page.
- **BUILD INSTRUCTIONS** — collapsible card sitting second-last in the left column, directly
  above the Framework-instructions card (the two standing-rules documents close the column
  together); holds the §4.1 `instr` free text, with view/edit
  states; defaults collapsed in create and edit mode alike (standing rules are rarely touched);
  collapsed with content it shows the first-rule preview (status-aware rule above); empty, the
  explainer: "Standing rules your AI follows every time it writes or edits this automation."; the view state renders the text as markdown (same renderer as the Spec and
  Framework-instructions cards), first prefixing every bare line — one that starts no markdown
  block (heading, list item, table row, code fence) and sits outside any fence — with "- " so
  plain one-rule-per-line text still renders as a bullet list instead of collapsing into one
  paragraph; the edit state is an auto-growing textarea (ask-box pattern, no manual resize
  handle, comfortable ~3-line minimum) sized to its content like the rendered view, so
  toggling view/edit doesn't jump the card height; both states cap at the Spec card's 440 px
  max height and scroll internally (§14 overlay scrollbar) past it, so a long rule list never
  swallows the column; edit placeholder "Markdown — one rule per line: 'Prefer
  Python.' 'Never delete files — move them to the Trash.'", empty state "No instructions yet —
  press Edit to add standing rules." While editing, a ghost **Reset to default** button sits
  left of Cancel in the card header: it fills the editor with the app's current §8
  `default-build-instructions.md` text (from `GET /instructions`), and is disabled while the
  editor already holds that text (or the file hasn't loaded yet). It changes only the unsaved
  draft — Save applies it like any manual instruction edit (same dirty gating and toast),
  Cancel discards it. In
  create mode the card arrives pre-filled with the app's default best-practice rules (§8) —
  edit or delete them freely before saving.
- **NOTES** — collapsible card below the Spec card holding the §4.1 agent-owned notes
  document; bare header like the other cards; collapsed with content it shows the
  first-line preview (status-aware rule above). View state renders the markdown (shared §4.5 renderer, same
  max-height + inner scroll as the spec card); Edit is the same view/edit pattern as Build
  instructions (ask-box textarea, Cancel/Save) so the user can prune stale or wrong lines —
  but the document is normally agent-written: §8 chat and sync responses may carry a
  `notes.md` rewrite, which replaces the text and lands a quiet "Notes updated." system
  entry. A notes change (manual or agent) marks the draft touched but **never** marks the
  workflow out of sync and never gates Save (§4.1: notes are advisory input to the next
  sync). Defaults collapsed; collapsed-empty hint and in-card empty state: "No notes yet —
  your AI records what it learns (page quirks, dead ends, fixes) as you build and test." Notes
  version with the automation and ride drafts and §5.1 archives like spec and
  instructions.
- **Dirty gating** — any spec/instruction/chat-rewrite change marks the workflow out of sync and
  **blocks saving** until the Build & test panel's "Sync now" button makes one §8 `sync` call
  regenerating the steps ("Steps synced with the spec — review them, then save."). Grant
  toggles (agent enablement, secret allowance) never mark the workflow out of sync by
  themselves — grants are permissions (§5), not versioned content. Instead, grant sync state is
  **derived** from steps vs grants: the workflow is out of sync exactly while some step needs a
  grant it doesn't have — an agent step whose assigned agent (or, unassigned, any agent at all)
  isn't enabled, or step code referencing a Keychain secret that isn't allowed. Consequences:
  checking a grant no step uses, or unchecking an unused grant, leaves the workflow in sync and
  saves directly; check-then-uncheck is a no-op; unchecking a grant steps use locks saving, and
  either re-checking it (instant, no sync) or a sync (steps rewritten without it) unlocks.
  Checking an agent shows a passive hint toast ("`<agent>` is now available to steps — Sync
  with spec if the steps should be rewritten to use it."). One exception: a grant toggle while
  the steps are still generating cancels the in-flight steps call (see above) and therefore
  marks the workflow out of sync — the kept spec no longer has finished steps. While viewing an
  old version, grant gaps never lock Restore — permissions are not versioned (§5) and a vX step
  needing a now-revoked grant fails at execution time instead; the cards still warn. An old
  version is browsed read-only: the spec card's Edit and Undo buttons disable while viewing
  one (like the sync button) — editing there would mark the workflow dirty and lock Restore
  behind a sync button that is itself disabled, a dead end; Restore first, then edit. Sync
  state lives in the **Build & test panel** (its own section below) at the top of the right
  column, **above** the Steps card rather than inside it, because a sync rewrites the steps and
  the parameter definitions, not just the step list. Outside a sync the panel's sync button is disabled
  (never hidden) while any other §8 job is in flight, while drafting, while viewing an old
  version, while a draft test is executing (below), and while the steps list AND the spec
  are both empty — a spec-only draft (steps
  generation was cancelled by an edit, or a resumed spec-only pending draft) must always be
  able to rebuild its steps through this button; an empty-steps state must never dead-end. **Inputs lock while rewriting** — while a sync
  or a chat job is in flight, every input on the review screen is disabled:
  the spec Edit and Undo buttons, the chat input (its own busy hint above), the
  agent-enablement and secret-allowance checkbox rows (and the missing-secret add row and the
  Secrets card's New secret button), the
  build-instructions Edit button, the Build & test panel's test-values editors and its Test
  button, the version menu, the drafting-agent picker, and Discard draft / Start over. The only
  live control is the running job's Cancel button (the footer action block's). **Rewrites
  lock while a test
  executes** — while a draft test is executing, every affordance that would rewrite the
  workflow under the running test disables: the panel's sync button, the spec card's Edit
  and Undo, the chat input, and the build-instructions Edit.
  Grant toggles, test-parameter editors, and navigation stay live — the test's inputs were
  snapshotted at start (a grant change surfaces through the ordinary out-of-sync state,
  where the live test keeps its Cancel). Every disabled control shares one look:
  45 % opacity, default cursor, no hover response. The step list dims to the same 45 % opacity
  whenever it can't be trusted as-is: while the workflow is out of sync, while a sync is
  rewriting the steps, and while an agent spec rewrite is in flight. The Steps card header carries no in-sync badge (no "in sync with
  spec" check) — sync state lives only in the panel. The footer action block's ghost
  **Cancel** button cancels the in-flight sync (`DELETE /drafts/{jobId}`) no matter
  how it was started (the panel, a repair-block apply, "Rebuild the steps"): the steps and spec
  are left untouched, the workflow stays out of sync, and the panel returns to its out-of-sync
  state (toast "Sync
  stopped — the workflow is still out of sync."). A `blocked` sync renders a thread
  blockers entry (source: sync; Blockers above): its
  primary amends the in-editor spec (same `## Constraints & resolutions` rule) and
  repeats the sync; dismissing it leaves the workflow out of sync with
  the panel still showing it. Disabled Save shows an amber hint ("Sync and review the steps before saving." /
  "Finish editing the spec first…" / "Syncing steps…" / "Rewriting the spec…" /
  "Writing the spec…" / "Generating the steps…" / "Installing the packages…"); saving is also
  blocked while any §8 job is in flight, and the panel's sync button disables while one is.
  Disabling an enabled agent that steps still call locks saving
  through the derived grant gap above (toast "Steps X, Y are out of sync — `<agent>` is no
  longer available here. Re-enable it or sync the steps before saving."). The out-of-sync
  reason line names the cause: an agent gap ("steps call an agent that isn't enabled"), a
  secret gap ("steps use a secret that isn't allowed"), or a spec change ("these steps still
  match the old spec").
- **TRIGGERS** card — the editor's trigger list as §4.3 **long-label** chips, so the details are
  visible in the editor: cron/time show their schedule words; message triggers show their detail
  fields — "Discord · `<channel>`[ · “pattern”]", "iMessage · `<from>`[ · “pattern”]". A message
  trigger missing its detail field (no channel / no sender) renders the placeholder "missing" in
  its place — surfacing a broken trigger before a save can 422 on it. Chips keep the footer
  "Executes even when
  the app is closed. The schedule follows the spec — one-shots and on/off live on the
  automation page." Display-only: in create mode it shows call 2's drafted triggers (the ones
  v1 gets); in edit mode the saved triggers until a sync lands, then the §4.3 trigger-merge
  preview (drafted crons over the cron subset, drafted message/app-start entries added when
  new, stored non-cron triggers surviving — what saving will store). Empty: "No triggers —
  executes only via Execute now and the menu bar."
- **PARAMETERS · YOUR AI ASKED FOR THESE** card — display-only in **both** create and edit
  mode, with a "READ-ONLY HERE" tag whenever the draft has params: each row shows the draft
  parameter's name, description, and a read-only **value summary** (the §4.2 one-line summary,
  right-aligned, ellipsized) — never inline editors. The summary's source: in create mode the
  drafted definition's default (the initial values v1 seeds — e.g. a URL the AI captured from
  the prompt); in edit mode the automation's live value, matched by name and kind (§5), so a
  drafted param without a stored match falls back to its default. Footer: "Values
  aren't part of a version — set them on the automation page after saving; for a test, set
  test-only values in the Build & test panel." Value input lives on the §9.2 detail page
  (§4.2 edit behaviors) and, test-only, in the Build & test panel at the top of the column.
  Empty state:
  "No settings needed — your AI didn't ask for any."
- **Steps** — readable scripts with per-step read-only tags (same tag language as the §9.2
  detail page — never menus, every tag carries a plain-language `title` tooltip): an agent step
  shows one robot-icon tag per name in its `agents`
  list (tooltip "This step calls `<name>` · `<model>` mid-execution"; a tag turns red when its
  name matches no enabled agent — red tooltip "`<name>` isn't enabled for steps — this step
  would fail"; an empty list shows one tag
  naming the automation's first enabled agent, and reads "no agent" in red when none is
  enabled — red tooltip "No agent is enabled for steps — this step would fail"), a step shows
  one key-icon tag per secret it uses (its `secrets` list unioned with
  the `secrets.NAME` references in its code; same §9.2 secret tooltip), a step that imports a
  declared
  §6.2 package (its top-level `import` name appears in the step's code) shows one box-icon tag
  per package, labeled with the import name (tooltip "This step uses the `<name>` Python
  package, version `<x.y.z>` — installed automatically" with the installed version when the
  §6.2 install check has reported one, else without the version clause), and every step
  shows the §9.2 clock-icon time-limit tag (same labels and tooltips). Which agents a step calls is decided by
  the drafting agent per the §8 selection rule — changing it happens through the spec or
  build instructions plus sync (or the agent-enablement card), not per step. Step rows expand the same way as §9.2 — whole-row click, caret-only right-edge
  affordance with the "View script" / "Hide script" tooltip, no text label, and independent
  open state (opening a step never closes another) — except the caret direction: it points
  left when the step is collapsed and down when expanded. The step number
  prefixes the title ("1. Fetch page" — faint mono numeral, title styling unchanged) instead
  of occupying a left gutter column, keeping the row's left edge free on narrow windows. An expanded step renders its
  `code` with Python syntax highlighting — a self-contained tokenizer (`PyCode` in `ui.tsx`, no
  dependency) coloring keywords, constants, strings, numbers, comments, decorators, builtins,
  `def`/`class` names, and call names over the base mono `pre`. Language is always
  Python (§15); the same `PyCode` renders the detail page and the draft/create step editor. Agent steps without a named agent
  and no enabled agent show a red warning ("Step N needs an agent, but none is enabled — the
  execution would fail there. Enable one below."). A step naming an agent that exists but isn't
  enabled warns ("Step N calls <Agent>, but it isn't enabled here — the execution would fail
  there. Enable it below.") — a grant gap (Dirty gating above), locking Save until the agent is
  re-enabled or a sync rewrites the steps. A step naming an agent that no longer exists warns
  ("<Agent> isn't one of your agents — the execution would fail at step N."). Per-automation
  agent enablement list with "X of Y enabled"; agents called by steps — including
  named-but-disabled ones — show a "called by step N" note. Agents created anywhere else
  (Agents page) arrive unchecked in edit mode — stored grants never widen silently, same rule
  as secrets. The agents card is collapsible,
  defaults collapsed — the header's "X of Y enabled" count stays visible either way; the
  collapsed line lists the enabled agent names (explainer when none is enabled, status-aware
  rule above) — and is
  forced open while its warning shows (the same collapsed-when-healthy, forced-open-on-problem
  pattern as the Packages card).
- **Secrets** — card eyebrow "SECRETS · ALLOWED FOR STEPS". Step code is scanned for `secrets.NAME`; secrets in Keychain but not allowed, and
  secrets missing from Keychain, each produce warnings with fix affordances. A used-but-not-allowed
  secret is a grant gap (Dirty gating above): it locks saving until the secret is re-allowed or a
  sync rewrites the steps. A missing-from-Keychain secret only warns — adding the value through the
  fix row also allows it. "X of Y allowed". **Default state: on a new automation (create mode)
  every Keychain secret starts allowed** — the same all-on seed as agent enablement; the user
  unchecks what a workflow shouldn't reach. Edit mode restores the stored grants (and a resumed
  draft its own selections, §4.4). The expanded card closes with a quiet **New secret** button
  (`.ad-btn-accent-ghost.small`, the §9.2 trigger-editor size) on its own row above the footer
  note, opening the shared §4.8 secret add modal. **A secret saved from this button is
  auto-allowed** — appended to `allowedSecrets` (checked) the moment it saves — because adding
  it from this page is an explicit grant for this automation; in edit mode that marks the draft
  touched, same as toggling a checkbox. Secrets created anywhere else (Secrets page, another
  automation) arrive unchecked in edit mode — stored grants never widen silently. The empty
  state points at the button: "No secrets in your Keychain yet — press New secret."
  Collapsible card, defaults collapsed — the header's "X of Y allowed" count stays visible
  either way; the collapsed line lists the allowed secret names (explainer when none is
  allowed, status-aware rule above) — forced open while a warning shows (same pattern as the
  agents and Packages cards).
- **PACKAGES** card — in the **right column**, below the Parameters card: display-only like
  Triggers and Parameters — the drafting pipeline owns the list; the user's only write is the
  §6.2 package update below.
  One row per §6.2 declared package — the distribution name in mono, followed by the
  **installed version** (from the §19 check — the real version in the shared directory, never
  a manifest value) in faint mono, plus a status chip:
  **installed** (green check) · **installing** (static faint "installing…" text, no
  spinner) · **not installed** (amber — a
  saved automation whose packages went missing, found by the §19 check on page load) ·
  **failed** (red; the plain-word error beneath in mono, e.g. the §7 category wording with the
  pip stderr tail). Header counts "N of M installed" (no count when the list is empty). Amber
  and red rows share one **"Install" / "Retry"** button (the §19 install call; rows show
  the installing text while it runs). Collapsible: defaults collapsed when everything is installed,
  forced open while any row is installing, not installed, or failed; the collapsed line lists
  the package names (status-aware rule, §11 card template — the card only collapses when the
  list is non-empty). Footer: "Your AI picked
  these Python packages for the steps. They install automatically — nothing for you to run."
  Empty state (like the Parameters card's): "No extra packages — the steps use only the
  built-in libraries." While drafting, the card shows its static placeholder line like
  Triggers/Parameters (Drafting on Review above). In edit mode the page checks statuses once on load
  (§19 `POST /packages/check`); during a create/sync job the card fills from the job's draft
  payload statuses (§8). An install failure never blocks saving — executions self-heal (§7) —
  so the card carries the warning without gating Save.
  **Updates (§6.2 semantics):** on load the page also asks PyPI once per package list
  (§19 `POST /packages/outdated`, advisory — a failure leaves badges off; the comparison
  baseline is the installed version). An outdated row shows an accent-tinted "→ x.y.z" badge
  after the installed version and an **Update** button on the row; two or more
  outdated rows add an **Update all** row above the footer. The header appends "· K updates"
  while any row is outdated (count hidden at zero). Clicking updates via §19
  `POST /packages/update` — `pip install --upgrade` in the shared directory, no manifest
  writes; the affected rows show the installing text, then the fresh installed version and
  status. Since the directory is shared, the new version applies to every automation using
  the package. Updates never force the card open and never gate Save.
- **Framework instructions** — read-only card showing `framework-instructions.md` **rendered
  as markdown** (the shared §4.5 Markdown component — full GFM; the shared 440 px markdown
  body, §14 overlay scrollbar style). The file content itself is untouched —
  what is rendered is byte-for-byte what the agent receives. Content comes from §19
  `GET /instructions` (fetched once per app session and cached); the same response carries
  `default-build-instructions.md` as the fallback pre-fill for the Build instructions card.
  Collapsed hint and footer copy: built-in instructions the AI reads before writing anything,
  word for word — they update with the app, nothing for the user to maintain.
- **BUILD & TEST panel** — the top card of the right column, merging the workflow's sync
  state (Dirty gating above) and the draft test into one build→test surface: sync, then
  test, in one place. Same card background as the other cards (`--bg-card` /
  `--border-card`); the panel never disappears — only its content changes with state.
  **Posture: quiet when fine, loud only when blocking.** Chat is the primary way to build
  and test — a chat message can request the sync and the test through the §8 actions — so
  the panel stays a status surface with one-click escape hatches and shouts only when
  saving is genuinely blocked. Concretely: the panel has **no green state** — an in-sync
  workflow shows no indicator dot at all (the dot is amber while out of sync, faint while
  a job runs, absent otherwise — never a spinner, and never green: a status that asks
  nothing must not draw the eye), and at most one accent-primary button ever renders:
  **Sync now** while out of sync. Every other panel button is a compact borderless **text
  button** (the card-header treatment above — never a bordered or filled box): the state's
  main actions (the Test the draft setup toggle, the setup section's Run
  test, a live test's Cancel) muted, every other action (View run, Analyze the failure,
  Sync with spec) faint — the test controls included: a failed test never blocks saving,
  so testing never shouts. Action rows lay their buttons out horizontally and **wrap** when
  space runs out — a panel button is never clipped.
  **Layout.** The header row holds only the `BUILD & TEST` eyebrow, never a button. In
  states 1–3 (drafting, sync in flight, out of sync) a **build zone** renders below it:
  the indicator dot + status line, the explainer line beneath it indented to the status
  text's left edge, and the sync control right-aligned at the zone's top — accent-primary
  **Sync now** while out of sync, a faint disabled text button while drafting or syncing;
  disabled per Dirty gating (including while its own sync
  runs — cancelling lives in the footer action block), never hidden — with the **test
  zone** under a hairline. In the in-sync states (4–6) the build zone disappears and the
  panel is a **single test zone** under the header hairline; sync access stays as a faint
  **Sync with spec** text button riding the test zone's action row (the same §8 `sync`
  call on demand; disabled per Dirty gating — e.g. while a test executes — never hidden). The
  test zone owns every test control — the test button never sits in the header: the test
  button with its hint / outcome / progress and their action rows, laid out per state
  below. Both zones share the card's 20 px side padding. States, first match wins:
  1. **Drafting** (create job in flight) — the coarse §8 stage label as static text over
     a plain faint dot (no spinner). The live `detail` line lives in the footer action
     block (Drafting on Review above), and the other right-column cards show their static
     placeholders.
  2. **Sync in flight** — static line "`<agent>` is rewriting the steps from your spec…"
     over a faint dot; the live `detail` line and the ghost **Cancel** live in the footer
     action block (cancel semantics under Dirty gating above).
  3. **Out of sync** — build zone: amber dot, the reason line and saving-is-locked
     explainer (Dirty gating above), primary **Sync now**; the test zone shows the test
     button disabled beside the muted hint "Sync first — a test executes the steps as
     generated from the spec." — a test always runs steps that match the spec, never stale
     ones. Exception: while a test is still executing, its Cancel button renders in place
     of the disabled test button — a live test is never left uncancellable.
  4. **In sync, test executing** — the live status line, progress bar, and the action row
     Cancel + View run + the disabled faint **Sync with spec** (below); the test-setup
     section stays hidden while the test executes.
  5. **In sync, test settled** — the outcome line over the action row faint **Sync with
     spec** / **Test the draft** and, on failure, **Analyze the failure**, which sends
     the canned analyze chat message (below). Test the draft is the same setup toggle as
     state 6 — reopening shows the values the last test used — and **View run** lives
     only inside the setup section's run row, not on the action row.
  6. **In sync, never tested** — one action row: the faint **Sync with spec** directly
     beside the muted **Test the draft** setup toggle — always side by side, nothing
     between them — with the plain-words status-and-side-effects line — "In sync with
     the spec. A test executes the real steps on this Mac — emails send, files move;
     memory is a scratch copy." — wrapping below the buttons when space runs out.
  The test-setup section (below) renders only in the in-sync states (4–6) and never
  while a test is executing. **Run test** is additionally gated on steps existing and no
  §8 job being in flight (inputs-lock above); the setup toggle disables under the same
  inputs-lock.
  **Test** — executes the draft's **real steps** as a **test execution record** (§4.5:
  `test: true`, `ver: "Test"`, `trigger: "Test"`) through the exact engine path a real
  execution takes (there is no simulation mode): the record and its `steps/` (the sent
  draft's scripts), `workspace/`, `result/`, and per-step-attempt logs all live under
  `executions/<uuid>/`, progress streams over the ordinary `exec.*` WS events, and the
  result, failure diagnostics, and secret redaction work exactly as in §7. The panel's
  setup toggle always reads **"Test the draft"** — the label never changes once a test
  outcome exists (a live test shows Cancel in its place) — and the setup section's run
  button reads
  **"Run test"** — never "Execute", which is reserved for real
  executions (§4.4 "Execute draft", §7 "Execute again"). A test uses: in-editor param
  values and grants (never the stored automation's), and **scratch memory** — copied to a
  temp dir from the draft container's `memory/` when it exists (edit mode falls back to
  the automation's memory dir; create mode to empty) and discarded when the test ends, so
  a test can never poison the memory the deployed version reads (§4.1). What distinguishes
  a test record from a real execution: it never touches the automation's derived display
  state or the one-execution-at-a-time gate (§5), it is excluded from the Executions list,
  it cannot be retried or re-executed from its execution page,
  and its lifetime is the draft's — starting a new test deletes the previous test record
  (one per draft container, and one **live** test per container: §19 answers 409), and a
  settled draft (discard, save as vN+1, Create, Start over) deletes its test records.
  Deleting the automation deletes them too.
  **Test setup section (create and edit mode):** the test button (**Test the draft**)
  is a **disclosure toggle**, not the run trigger — it never starts a
  test. It carries a caret (pointing left collapsed, down expanded — the §9.2 step-row
  caret language) and expands the test-setup section **below** the action row, opened by
  a dim hairline (the zone's top hairline stays the only full divider). The section
  shows **every test option at once** — no nested toggles, nothing behind a second
  click:
  - When the draft has params: the `PARAMETER VALUES · THIS TEST ONLY` eyebrow, then one
    editor per param (§4.2 kinds), prefilled in edit mode with the automation's current
    values (draft default when a param is new) and in create mode with the draft
    defaults. The values ride the §19 `paramValues` body field and apply to this test
    only — nothing is stored, and the read-only Parameters card is untouched. Untouched
    prefills send the same values a closed section would use — the automation's stored
    values (edit) or the draft defaults (create), exactly like executing the draft.
  - When the editor's trigger list (the TRIGGERS card list) holds a message trigger
    (§4.3 discord/imessage, `off` state irrelevant): the `TRIGGER MESSAGE · THIS TEST
    ONLY` eyebrow, a trigger picker when the list holds several message triggers (the
    §4.3 long labels; single-trigger lists skip the picker), a **From** field (prefilled
    with the trigger's `from` for iMessage, "Test" for Discord; switching the picked
    trigger re-prefills it), and a **Message** text field (empty, placeholder-hinted).
    The mock rides the §19 `triggerMock` body field **only when the message text is
    nonempty** — left empty the test runs without a payload; nothing is ever stored, and
    the trigger list is untouched. The sub-section's footer says so and names the reply
    behavior plainly: applies to this test only; a step's `reply()` posts to the
    **real** Discord channel, and an iMessage reply can't send from a mocked message
    (§6.1). The built §4.5 payload is snapshotted on the test record like a real
    firing's, so the test's execution page shows the message and sender like any message
    execution's; the record's trigger label stays "Test".
  - The closing **run row**: the muted **Run test** button — the only control that
    starts a test — and, when a test record exists, the faint **View run** beside it
    (the settled states' only View-run home — the action rows never carry it),
    over the this-test-only note ("Values and the message apply to this test only —
    nothing is saved.").
  Clicking the toggle again collapses the section; starting a test collapses it too
  (its inputs were snapshotted), and it stays hidden while the test executes. The
  entered values survive a collapse — reopening shows them again; seeding happens only
  when the section opens without prior values. A change to the draft's param
  definitions or trigger list collapses the section and drops its values. A chat-armed
  test with values (§8 actions) pre-fills the param editors, so reopening the setup
  shows what ran. The resolved values are snapshotted on the test record, so its execution
  page shows them like any execution's. Side effects outside memory are real (emails
  send, files move, notifications post per settings) and the card says so plainly.
  **The panel stays compact — status + progress, no logs:** while the test executes it
  shows a status line ("Executing — step 2 of 5 · <step name>"), a progress bar (terminal
  steps over total), and a **"View run"** button opening the test's §7 execution page, where
  the live step timeline, streaming logs, and (when finished) the full result views are the
  ordinary execution-page surfaces — one run UI everywhere instead of a second, smaller one
  in the panel. When the test finishes the panel shows the outcome line ("Test succeeded —
  the memory copy was discarded." green / "Test failed." amber / "Test cancelled." faint);
  View run then lives only in the setup section's run row. Navigating
  away from the editor no longer cancels a live test — it is a real record, visible and
  cancellable from its execution page; re-entering the editor re-attaches the card to a
  still-executing test. **The outcome is never thrown away with the editing session:** a
  finished test writes the last-test summary `test.yaml` (§5 — status succeeded | failed,
  finished-at, and the test execution's id) into the draft container, wiped at the next test
  start and deleted with the draft. It rides the draft payload as `test` ({ status, when:
  §4.1 started-label, execId }) — on the automation's `draft` object and on `GET /draft` —
  and a resumed draft's panel renders it in place of the never-tested row: a status line
  ("Last test succeeded — <when>" green / "Last test failed — <when>" amber); the setup
  section's run row shows View run while the record still exists (retention may outlive
  it — the button hides when the record is gone). A live test always
  takes over the panel. **When a test settles the thread hears about it:** the editor
  appends a run-settled **system** entry — "Test succeeded." / "Test failed at step
  `<name>` — `<message>`." — so follow-up messages have an anchor and the agent's
  CONVERSATION context names the run. **On failure nothing analyzes by itself:** the panel
  shows the "Test failed" line plus an **"Analyze the failure"** button on the action row —
  it sends the **canned analyze chat message** "The test failed at step `<name>` — figure
  out why and change the automation so it won't happen again." as an ordinary §8 chat job
  (gated exactly like the chat input, so it disables while any §8 job is in flight): the
  §8 RECENT RUNS context carries the failing run's error and log tails, and the response —
  an explanation, a spec rewrite, actions that resync and retest — lands in the thread
  like any chat outcome. Build-time blockers and execution-time failures stay one
  convergent repair loop in one place, the chat thread. Advisory: a failed test never
  blocks saving.

**Fix-with-AI entry (§7/§9.2).** Opening the editor through a failed execution's **Fix with
AI** button behaves as: open edit mode on that automation (resuming a stored draft when one
exists, else seeding the editor from the current version as usual), append a **system**
thread entry naming the failure ("Execution failed at step `<name>` — `<message>`"), and
immediately send the canned analyze chat message "This execution failed — figure out why
and change the automation so it won't happen again." (the step is not repeated — the
system entry directly above already names it) as a §8 chat job
carrying the execution's id as the §19 `runId`, so the RECENT RUNS context includes that
run in full detail however old it is. The outcome lands like any chat outcome. While
another §8 job is already in flight the message is not sent — only the system entry is
appended, and the user asks when the job settles.

**Settled runs seed the thread.** Beyond the test entries above, entering the editor in
edit mode appends a run-settled system entry ("Draft execution failed at step `<name>` —
`<message>`." / "Draft execution succeeded.") when the automation's newest settled Draft
execution (§4.5 kind `draft`) finished after the thread's last entry — the user who
iterates via Execute draft picks the conversation up where the run left off. Duplicate
seeds are suppressed the same way (only runs newer than the last thread entry qualify).

Create (new) → version 1, `lastStatus: none`, navigate to detail, toast "Created — nothing has
executed yet. Press Execute now when you're ready." Save (edit) → §4.4.

