# Autowright SPEC — Data model

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 4. Data model

**Identity rule: every entity id (automation, execution, agent — any `id` field anywhere) is a
UUID (v4, lowercase hyphenated string). No sequential or slug-derived ids.** Version numbers
(`v1`, `v2`…) are labels, not ids, and stay integers.

Single central model drives everything. Top-level:

```
surface: onboard | app | create | menubar
page: automations | automation | executions | execution | agents | agentNew | secrets | settings | about
automationId, executionId: current selections
automations[], executions[], agents[], secrets[], settings, onboarding state, create state, transient UI state
```

The on-disk representation of these entities is §5.

### 4.1 Automation

```
id: uuid
name, description: strings — both are user-owned identity (§5: top-level automation.yaml, never
  versioned): the §8 create manifest seeds them, and after create they change only through
  the user — name via click-to-edit on the §11 Review title, description via click-to-edit on the
  §11 Review lede line; both also via §19 PATCH. Sync ignores the
  manifest's name and description. Edits never mark the workflow out of sync. A blank name is
  ignored (never cleared); a blank description clears it (description is optional).
version: int (current)
triggers: ordered trigger list (§4.3) — user-owned, never versioned; the draft's spec-derived
  triggers are merged in when an edit is saved (§4.3 trigger merge)
triggerChip: derived chip string (§4.3): one trigger → its short label, several → "N triggers",
  empty → "No triggers"
triggersOff: bool — derived: the list is nonempty and every trigger is off (drives the OFF tag)
nextAt: epoch ms of the next enabled occurrence across all triggers (§4.3) | null
instructions: optional multiline free-text user instructions to the agent
notes: agent-owned working-knowledge document (markdown string, may be empty) — selectors and
  short HTML excerpts, API endpoints and quirks, approaches that failed and why, environment
  facts the drafting agent discovered while building and testing. Written only by §8 agent
  responses (a chat or call-2 `notes.md` block — the agent keeps it a terse cheat sheet);
  user-readable and prunable in the §11 NOTES card. Versioned like spec/instructions, and sent back
  to the agent on every §8 chat and steps call so later syncs don't retry dead ends. A notes
  change never marks the workflow out of sync (§11): notes are advisory input to the next
  sync, not a contract the steps must match
lastStatus: succeeded | executing | failed | cancelled | interrupted | none — derived from the
  latest execution that actually ran; `skipped` and `queued` records never count (§6)
live: execution ids currently in progress, newest last — empty when idle. A list, not a single
  id: `maxParallel` may allow several at once.
maxParallel: int ≥ 1 (default 1) — how many executions of this automation may run at once
  (§6). User-owned and never versioned (§5 top-level `automation.yaml`), like `triggers`.
  Raising it above 1 is opt-in per automation because `memory/` is shared across concurrent
  executions (§6) — the §9.2 card cautions when the automation's steps actually touch memory.
maxQueued: int ≥ 0 (default 10) — how many message firings may wait when every slot is taken
  (§6 firing queue). 0 restores skip-on-busy.
resultChip: short summary chip ("2 new chapters") | null — the chip is optional: null when the
  last successful execution never called result.chip(); failed automations synthesize "Needs attention"
resultStatus: changes | ok | attention | null — tints resultChip with the §7 chip colors
  everywhere it appears (list rows included); null whenever resultChip is null; "attention" for
  failed automations
lastExecutionLabel: shared time label (below) | "executing…"
  Every relative time label in the app uses one shared scheme: "Today" | "Yesterday" | full
  weekday name ("Thursday", 2–6 days back) | the date in the user's locale format (year,
  month, day — e.g. "7/18/2026"). Labels that carry a clock time append it: "Today, 8:00 AM".
latest: last execution's result object + when-label + executionId (links the detail page's
  result card to the execution page), for the detail page
params: parameter list (§4.2)
memory: { size, updated, path } — per-automation memory directory between executions (any
  files/formats): size a humanized byte label ("empty" when nothing is stored), updated the
  shared time label ("never written" before the first write), path the directory's absolute
  path — backs the memory card's Show in Finder (§4.9 Show-in-Finder rule)
snapshots: [{ id, name, reason, when, version, size, files }] — the §6.3 memory snapshots,
  newest-first; name = user label | null, reason ∈ manual | pre-clear | pre-version |
  pre-restore, when = humanized time label, version = "vN" current at capture (pre-version:
  the version about to execute), size = humanized byte label, files = file count
snapshotSettings: { preVersion, preClear, preRestore } — booleans, the §6.3 automatic-snapshot
  toggles (all default true)
steps: [{ name, file, description, code, agent?, why?, agents?, secrets?, packages?, timeout?,
  noTimeout?, retries?, infiniteRetries? }] — file is the version-folder script filename (§5 NN-name.py);
  code is
  human-readable script; agent
  marks a step that makes query-only runtime model calls (§6) — the script itself still does any
  changes. agents (agent steps only): ordered list of §8 grants the step may call, as
  { name, why? } entries — the first is agent.ask's default, the others are addressable per
  call by name; empty/absent falls back to the automation's first enabled agent. An entry's
  why is that agent's role note (its §9.2 tag tooltip); §8 validation requires one on every
  entry when the step lists two or more agents. secrets: §8 grants the step uses, as
  { name, why } entries — why is the per-use note (§8 rule 6, required on every declared
  entry) shown as the key tag's tooltip (§9.2). A step's effective secrets are these names
  unioned with the secrets.NAME references in its code; a code-referenced name with no
  declared entry carries no why and keeps the generic tooltip. packages: §6.2 declared
  packages the step uses, as { import, why } entries — import names a declared package's
  module (§8 validation rejects an import the version's packages list doesn't declare) and
  why is the per-step note (§8 rule 5, required on every declared entry: what THIS step uses
  the package for — the same package can serve different jobs in different steps), shown in
  the box tag's tooltip (§11). A step's effective packages are these entries unioned with the
  declared imports appearing in its code; a code-matched import with no declared entry falls
  back to the package declaration's why, then to the generic tooltip. All three lists are chosen
  by the drafting agent per the §8 selection rule (the SPEC and build instructions win when they
  name a choice; the drafting agent's own judgment otherwise). timeout: optional per-step time
  limit in seconds (positive int) enforced by the §6 watchdog; noTimeout: true removes the limit
  entirely (never combined with timeout — §8 validation); absent → the 900 s engine default (§6).
  Both are written by the drafting agent per the §8 timeout rule (short by default; long or
  unlimited only when the user asked). retries: optional per-step automatic retry budget
  (positive int ≤ 10): a failed attempt of the step is re-executed immediately, up to that
  many extra attempts per execution pass, before the step (and execution) fails (§7 step
  retry). infiniteRetries: true removes the budget — the step retries until it succeeds or
  the user cancels/skips (never combined with retries — §8 validation; the persistent-
  automation shape, usually together with noTimeout). Both absent → 0: first failed attempt
  fails the step, and there is no automatic execution-level retry (§6). Like the timeout
  pair, both are written by the drafting agent per the §8 retry rule. On disk and in the §8
  manifest the keys are spelled `no_timeout`, `infinite_retries` (§5 yaml is snake_case); the
  API serialization is `noTimeout`, `infiniteRetries`
spec: block list [{ kind: h1|h2|p|li, text }] — the human-readable spec
specMeta: "v3 · updated Yesterday" (shared time label)
packages: [{ pip, import, why }] — the current version's §6.2 declared packages ([] when
  none); why is the drafting agent's one-line GENERAL purpose (§8 rule 5 — required), shown
  under the package's row on the §11 Packages card (per-step purposes live on the steps'
  own packages entries, above); versioned like spec/steps — each version
  entry below carries its own list
versions: [{ version, when, note, spec, steps, instructions, notes, params, packages }] — prior-version
  history, newest-first (the current version is not repeated in this list)
draft: unsaved edit snapshot (create-flow shape) | null
agentId: agent that writes/edits this automation
stepAgents, allowedSecrets: string[] — per-automation enablement (set on save)
```

### 4.2 Parameter kinds

| kind | fields | one-line summary | edit behavior |
|---|---|---|---|
| `toggle` | label, help, on | "On"/"Off" | switch |
| `list` | label, help, validate, lines[] | validate → "N links" (valid-URL count), else "N entries" | one input per line, add/remove; per-line URL validation (red border plus a red "NOT A VALID LINK" tag on an invalid non-empty line when validate — detail page and editor alike); info line "N lines · G valid links[ · B needs attention]" |
| `kv` | label, help, rows[{key,value}] | "N entries" | key/value pairs, add/remove |
| `number` | label, help, value, min | value | digits-only; empty/below-min clamps to min |
| `text` | label, help, value, placeholder? | value or "Not set" | plain input |

Every edit saves automatically — there is no save or done action. Typing commits on a short
debounce (and on blur); toggle flips, row/line removals, and additions commit immediately. On
the automation detail page the `list`/`kv` editors are always fully shown — no
collapse/expand toggle (the one-line summary column still serves the execution page's
values-as-used block).

URL validity: `/^https?:\/\/\S+\.\S+/`.

Every definition carries a default: `toggle` → off, `number` → its `min`, `text`/`list`/`kv` →
empty. Definitions are versioned with the automation; values live in the top-level
`automation.yaml` and are matched by name and kind at execution/restore time (§5). The
value-merged serialization (the automation JSON's `params`, execution records) is the full
definition — `default` included — plus the resolved value field, so definitions survive a
round-trip through the editor (edit mode seeds the draft's params from the automation JSON;
a stripped default would make a §11 test resolve an unset param to empty instead of its
default).

### 4.3 Triggers

An automation carries an ordered list of **triggers** — independent conditions that each start
an execution. Triggers are user-owned operational state (§5): editing them on the detail page
never mints a version and never involves the AI. The list additionally follows the spec via
the **§4.3 trigger merge** — saving an edit (§4.4) merges the draft's spec-derived triggers
(§8 rule 9) into the stored list:

- **Crons replace the cron subset**: a drafted cron matching a stored one on (`expression`, `timezone`)
  keeps that trigger's `id` and `enabled` state; other drafted crons arrive enabled with fresh
  ids; stored crons the draft no longer derives are dropped.
- **Message and app-start entries are additive**: a drafted `discord`/`imessage`/`app_start`
  entry matching a stored trigger of the same kind on its identity fields (discord:
  `channel`, `secret`, `pattern`, `mention`, `author`; imessage: `from`, `pattern`; app_start: the kind
  alone) leaves the stored trigger as is; an unmatched one is appended enabled with a fresh
  id. Stored message/app-start triggers the draft doesn't mention always survive — a sync
  never drops one.
- `time` one-shots are never drafted (§8) and always survive a save untouched.

Manual starts (Execute now, the menu bar, CLI) are
not triggers in this list — they always work, whatever the list holds.

Trigger shape: `{ id: uuid, kind, enabled: bool, …kind fields }` plus the backend-derived display
strings `label` and `short`. The backend assigns `id` to entries that arrive without one. Kinds:

| kind | fields | fires | label / short |
|---|---|---|---|
| `cron` | `expression`: 5-field cron expression · optional `timezone` | at every match | humanized when simple (below), else the raw expression in mono |
| `time` | `at`: wall-clock ISO timestamp ("2026-07-20T15:00"), seconds allowed ("2026-07-20T15:00:15") · optional `timezone` | once, then the trigger is consumed | "Once at Jul 20, 3:00 PM" / "Once Jul 20 15:00"; non-zero seconds append to the time in both strings: "Once at Jul 20, 3:00:15 PM" / "Once Jul 20 15:00:15" |
| `app_start` | — | at every desktop-app launch (§6 firing path) | "On app start" / "App start" |
| `discord` | `channel`: Discord channel id (ASCII digits) · `secret`: name of the §4.8 secret holding the bot token · optional `pattern`: text filter · optional `mention`: bool · optional `author`: sender filter, a list of Discord user ids (ASCII digits) | at every matching Discord message (rules below) | "Discord · `<channel>`" (+ " · “`<pattern>`”" when set) / "Discord" |
| `imessage` | `from`: sender handle (E.164 phone or email) · optional `pattern`: text filter | at every matching iMessage on this Mac (rules below) | "iMessage · `<from>`" (+ " · “`<pattern>`”" when set) / "iMessage" |
| `pubsub` | — | future message trigger | — |

**Timezone (`timezone`)** — optional IANA zone name (e.g. `Asia/Tokyo`) on `cron` and `time`
triggers. Absent → the machine's local time (labels unchanged). Present → `expression` matches and
`at` reads as wall clock **in that zone** (DST rules below apply in that zone); occurrences
convert to local time for `nextAt`, countdowns, and the scheduler. An unknown zone name is
rejected at the API (422), never stored. When `timezone` is set, both display strings append the
zone's city — the last `/` segment of the IANA name, `_` → space — in parentheses:
"Daily at 8:00 (Tokyo)" / "Daily 8:00 (Tokyo)"; the raw-expression fallback and one-shot
labels get the same suffix.

`pubsub` is a reserved kind only: the API rejects writing it with 422; the UI does not
surface it. Nothing else about it is specified yet.

**Discord triggers** — the user supplies their own Discord bot: an application created in the
Discord developer portal with the **Message Content intent** enabled, invited to the server
whose channel the trigger watches. The bot token is stored as an ordinary §4.8 secret and
referenced by name via the trigger's `secret` field — the token lives in the Keychain, never
in the trigger. Firing rules, applied by the §6 listener manager to every gateway
`MESSAGE_CREATE` in the trigger's `channel`:

- messages authored by **any bot** (including the listening bot itself) never fire — a
  `reply()` (§6.1) can never trigger the automation it came from;
- `mention: true` → only messages that @-mention the bot fire. Both mention forms count: the
  bot **user** (`mentions` carrying the bot's user id) and the bot's **managed role**
  (`mention_roles` carrying a role whose `tags.bot_id` is the bot) — typing `@BotName` in a
  server often inserts the role mention Discord created for the bot, not the user mention.
  `@everyone`/`@here` do not count;
- `author` → only messages whose author's user id is in the list fire — the authorization
  filter for shared channels: without it, any channel member who passes the other
  filters can start the automation;
- `pattern` → only messages containing the pattern fire (case-insensitive substring).

All present filters must pass (AND).

A firing starts an execution with trigger label "Discord" and the §4.5 `triggerPayload`; the
§6 one-execution-at-a-time skip applies like any trigger. Like
`app_start`, a discord trigger has no computable next occurrence — `nextAt` ignores it, and a
list whose only enabled triggers are message triggers shows the listening status line below.
Validation (§19, 422 otherwise): `channel` a nonempty ASCII-digit string, `secret` a valid
§4.8 secret name (the Secrets-API rule, `[A-Z][A-Z0-9_]*`; it need not exist yet — a
missing/valueless secret surfaces as a `connection` error, not a 422), `pattern` when present a
nonempty string, `mention` a bool, `author` when present a nonempty list of nonempty
ASCII-digit strings (Discord user ids, like `channel`); its entries are trimmed, deduped,
and sorted at save, so element order never distinguishes two triggers — the trigger-merge
identity compares the normalized list. The serialized trigger of
kind `discord` additionally carries **`connection`** — derived, never stored: the listener
manager's connection state for the trigger's token,
`{ state: connected | connecting | error, error? }` (`error` is the plain-word failure, e.g.
"secret DISCORD_BOT_TOKEN has no value yet" or Discord's close reason).

**iMessage triggers** — the Mac's own Messages account is the identity: no bot, no secret.
The §6 listener manager watches the Messages database (`chat.db`) while at least one enabled
`imessage` trigger exists. The watcher reads **only** rows the enabled triggers could fire
on — filtered in the query itself to the configured senders, incoming, plain messages (§6
data minimization); conversations no trigger watches are never read or decoded. The firing
rules, applied to every row the watcher reads:

- messages sent **by this Mac's account** (`is_from_me`) never fire — the loop-safety analog
  of Discord's bot rule: a §6.1 `reply()` (or the §6 busy notice) can never trigger an
  automation. Consequence, stated wherever the trigger is explained (§9 setup guide): texting
  *yourself* from another device on the same Apple ID cannot trigger — the sender must be a
  different handle (another person, or a dedicated Apple ID signed into Messages on this Mac);
- the sender's handle must equal the trigger's `from` (case-insensitive exact match — phones
  are matched in the E.164 form Messages stores, e.g. `+15551234567`);
- messages in **group chats** never fire — direct (1:1) conversations only; group triggers
  are future work;
- `pattern` → only messages containing the pattern fire (case-insensitive substring, same as
  Discord);
- tapbacks/reactions, edits of earlier messages, and messages with no decodable text never
  fire.

A firing starts an execution with trigger label "iMessage" and the §4.5 `triggerPayload`;
queueing, skip, and the busy notice behave exactly as for Discord (§6). Like every message
trigger it has no computable next occurrence — `nextAt` ignores it. Validation (§19, 422
otherwise): `from` is either an **email** (contains `@`, no whitespace) or an **E.164
phone** — `+` then 3–15 digits, matching the form Messages stores; obvious phone formatting
(spaces, dashes, dots, parentheses) is stripped at save, so `+1 (555) 123-4567` stores as
`+15551234567`, but a number without the leading `+`/country code is rejected — it could
never match a stored handle, and a trigger that silently never fires is the worst failure
mode. `pattern` when present a nonempty string. Serialized `imessage` triggers carry the same derived **`connection`** field as Discord —
all of them share the one §6 watcher, so they all report its state; the plain-word errors
name permissions where relevant (e.g. "needs Full Disk Access — grant it in System Settings →
Privacy & Security → Full Disk Access").

**Cron dialect** (implemented in `triggers.py` — the one trigger-math implementation, no new
dependency; the renderer has none and previews via §19 `POST /triggers/preview`): five
whitespace-separated
fields — minute, hour, day-of-month, month, day-of-week (0–6, Sun = 0) — each `*` or a comma
list of numbers, ranges (`a-b`), and steps (`*/n`, `a-b/n`). Numbers only: no month/day names,
no `@daily` macros, no seconds field. Standard Vixie rule: when day-of-month and day-of-week are
both restricted, a date matching either one fires. Times are wall clock in the trigger's zone
(`timezone`, default local); an occurrence erased by DST (spring forward) still fires, shifted
forward by the gap width (a "2:30" on the day the clock jumps 2:00→3:00 fires at 3:30 — the
erased wall time read with the pre-transition offset), and one repeated by
fall-back fires once. Invalid expressions are rejected at the API (422), never stored.
(A system-timezone change that rewinds the wall clock is indistinguishable from fall-back
and is handled the same conservative way — occurrences in the rewound span do not re-fire;
a rewind larger than any DST shift logs a scheduler warning so a reported miss is
diagnosable.)

**Humanized cron labels** — exactly two shapes get words; everything else displays the raw
expression:
- `M H * * *` → "Daily at 8:00" / short "Daily 8:00"
- `M H * * D` (single day) → "Mondays at 9:00" / short "Mon 9:00"

The day field only humanizes as a single digit `0`–`6` — anything else (`7`, `07`, `12`) falls
back to the raw expression. The fallback shows the expression trimmed of surrounding
whitespace. One implementation: the backend (`triggers.cron_display`) — serialized triggers
carry the derived `label`/`short`, and the editors label unsaved entries through §19
`POST /triggers/preview`, so no second implementation exists to drift.

**One-shot semantics** (`time`): `at` must be strictly in the future when saved (422 otherwise;
the check reads `at` in the trigger's `timezone`).
The trigger is consumed — removed from the list — when it fires, and equally when its moment is
skipped (backend down when it passed, or superseded mid-execution, §6). It never lingers spent.

**App-start semantics** (`app_start`): fires when the desktop app launches — the Electron
process starting (§6 firing path), not a window reopening from the tray. No fields, no `timezone`.
An automation holds at most one: a list carrying a second `app_start` answers 422 and nothing
is stored. It has no computable next occurrence — it never contributes to `nextAt` — and it
survives an edit save (the §4.3 trigger merge never drops it — a drafted `app_start` merely
matches the stored one).

**Next occurrence:** each enabled (`enabled: true`) trigger computes its own next time — cron: the
next expression match strictly after now; time: `at`. The automation's `nextAt` is the minimum
across them, null when no enabled trigger has one. The countdown renders "next in Xd Xh" /
"Xh Xm" and refreshes every 30 s.

**Derived display:** `triggerChip` — one trigger in the list → its short label; several →
"N triggers"; empty list → "No triggers". `triggersOff` — nonempty list, every entry off; list
rows add an OFF tag to the chip (§9.1).

Detail-page trigger status line (under the §9.2 TRIGGERS rows):
- executing → "Executing now… the triggers are unchanged." (spinner icon); the chip reads
  "`<triggerChip>` · executing now"
- no triggers → "No triggers set — executes only when you press Execute now or use the menu
  bar." (pause icon)
- all off → "All triggers are off — won't execute on its own. Execute now and the menu bar
  still work." (pause icon); the chip reads "`<triggerChip>` · triggers off"
- `nextAt` null but an enabled message trigger (`discord`/`imessage`) exists → "Listening for
  `<what>` — executes when a matching message arrives. Execute now and the menu bar still
  work." (clock icon), `<what>` being "Discord messages", "iMessages", or "messages" when both
  kinds are enabled; the chip shows just `triggerChip`
- `nextAt` null but an enabled `app_start` exists → "Executes when this app next starts —
  Execute now and the menu bar still work." (clock icon); the detail-page trigger chip reads
  "`<triggerChip>` · on app start"
- `nextAt` null otherwise (e.g. an elapsed enabled one-shot not yet consumed) → "No upcoming
  occurrence — Execute now and the menu bar still work."; the chip shows just `triggerChip`,
  never a dangling countdown
- else → "Next execution in `<countdown>` (`<short label of the next trigger>`) · executes even
  when the app is closed." (clock icon); the chip reads "`<triggerChip>` · next in
  `<countdown>`"

### 4.4 Versions and drafts

- Saving an edit creates version N+1 (on disk: a fresh `versions/vN+1/` folder, then the
  `current_version` pointer flip, per §5), applies spec/steps/instructions/stepAgents/allowedSecrets/
  agentId, merges the draft's trigger list into the automation's (§4.3 trigger merge —
  triggers themselves stay unversioned), sets `specMeta` to "vN · updated Today".
  Prior versions are untouched.
- Leaving the editor with unsaved touched changes snapshots a **draft** onto the automation
  (toast: "Draft kept — resume it from this automation anytime."). Every exit path
  persists it — the header back button, system back/forward navigation, anything that closes
  the editor — never just the header button. Discard draft and Save as vN+1 settle the draft:
  leaving after either writes nothing (a discarded or saved draft is never resurrected).
  Touched edits count regardless of which editable view they were made in: the Draft view or
  the current version's view (§11: only *old* versions are read-only) — edits made while
  viewing "vN · current" persist as the draft on every draft-keep path (leaving the editor,
  switching views in the Version menu), never silently discarded. Browsing the current
  version untouched writes nothing (it must not clobber an existing draft with the version's
  own content).
- The draft snapshot carries the **full working state**: spec, steps, instructions, notes
  (§4.1), params,
  packages, the editor's trigger list (stored as a draft-only `triggers` key — the §4.3
  merged preview, so a resumed draft keeps a synced schedule change), the editor's
  step-agents + allowed-secrets grant selections (stored as
  draft-only `step_agents` / `allowed_secrets` keys in `draft/automation/automation.yaml`, §5),
  the §11 out-of-sync state (`outOfSync` on the payload → draft-only `out_of_sync` key —
  a kept draft whose steps lag its spec must resume with saving still locked, §11 dirty
  gating), and the §11 chat thread (`chat` on the payload → the container's `chat.jsonl`, §5).
  Persisted thread entries: `{ id: uuid, kind: user | answer | activity | rewrite |
  blockers | system
  | error, text?, title?, outcome?, blockers?, source?, diagnosed?, dismissed?, resolved?, at }` —
  `user` a
  message, `answer` the agent's markdown reply, `activity` a settled §8 job's record
  (`title` = its final stage label, text = one event per line, `outcome` = the job's
  settled status — done | blocked | failed — driving the §11 outcome glyph; an entry
  persisted before the field existed has none and renders as done; §11),
  `rewrite` a spec-updated event (text = one-line summary), `blockers` a §8 blocker list —
  each blocker `{ reason, fix, details?, kind? }`, `kind` only ever the literal
  `user-action` (§8 blocker response) —
  (`source`: chat | spec | steps | sync — which call produced it; `spec` is the create-flow
  spec call, §11 — `error` entries from that call carry the same `source`), `system` a
  quiet status chip, `error` a red failure entry (a failed §8 job's message, §11) — persisted
  so a later chat's CONVERSATION context still names the failure. The §11 thread progress
  entry (live job progress) is editor state only, never persisted.
  Resuming restores the grant checkboxes from the draft; the automation's live
  stepAgents/allowedSecrets stay untouched until the draft is saved as vN+1. A Draft
  execution honors the draft's grants when present, not the live ones.
- Draft persistence is **continuous, not exit-only**: once a draft holds anything worth
  keeping (touched edit-mode changes; a landed create-mode spec or steps), the editor
  writes it with a debounced PUT (~1 s after the last change) as the state evolves, and the
  exit paths write one final time. A quit, force-quit, or crash therefore loses at most the
  debounce window — never the draft (unmount cleanup alone doesn't run when the app
  quits). Settling (discard, save, Create, Start over) stops the debounced writer before
  deleting, so a trailing write can't resurrect a settled draft.
- **Create-mode drafts persist too**, in the single pending slot `<root>/draft/` (§5).
  Opening the create flow creates the slot's container first — `draft/` with an empty
  `memory/` (`POST /draft/pending/open`, §19) — before any drafting; §11 create-mode tests execute
  as test execution records in the executions tree, not inside the slot. Leaving the create
  flow after a draft has landed (spec or steps present) keeps the full
  working state there — the same serialization as an edit-mode draft (the agent and secret
  grant selections ride the same draft-only `step_agents` / `allowed_secrets` keys), plus
  the identity fields no automation record exists to hold yet (name, description, chosen agent,
  triggers). Opening the create flow while the slot exists resumes it straight on the
  Review page (toast: "Resumed your unsaved draft — Start over discards it."); the §9.1
  list header surfaces the slot as a Resume draft button, and its New automation button
  confirms then deletes the slot to start fresh. Start over
  (and Back to Ask) deletes the slot. Create consumes it: `versions/v1` is written from
  the sent draft and `<root>/draft/` is deleted — a settled draft is never resurrected.
  One pending draft at a time: every keep overwrites the slot. Leaving with nothing
  landed just leaves the empty container behind; the next open reuses it.
- In edit mode the review footer shows a **Keep draft** bordered button placed directly to
  the left of the Save as vN+1 button (only while there is something to keep: touched
  changes or a stored draft). It leaves the editor through the same keep path as the header
  back button — so keeping the draft is a visible choice, not an accident of which button
  you noticed.
- Editor version menu lists: Draft ("your working copy — unsaved"), current vN ("current · …"),
  each older vN (date, always with the year · note). Loading an old version shows a banner: "Loaded vX from history.
  Saving restores it as vN+1 — your draft stays in the Version menu." with a bordered
  **Back to draft** button; Save label becomes "Restore vX as vN+1".
- Detail page: old versions can **Execute once** without touching the triggers (toast: "Executing vX
  once — triggers and Execute now stay on vN."). The detail-page version menu carries a footer
  explainer: "Executing an older version once doesn't change anything — triggers and Execute now
  always use the current version. To make an older version current, open Edit and restore it from
  the Version menu." Draft banner offers Resume editing / Discard — the UI has no
  Execute-draft action; draft iteration happens through the editor's §11 Test.
- **A Draft execution executes on the draft's own memory** (`draft/memory/`, §5). Draft
  executions start only from the §19 execute API (`version: "draft"`) — no UI surface offers
  one. The memory is seeded as a copy
  of the automation's live memory the first time the draft executes, then reused by every later
  Draft execution — so a draft iterates on one stable memory — and kept across draft re-saves
  from the editor. It is deleted with the draft (discard, or save as vN+1: the new version
  continues from the live memory, which no Draft execution ever wrote).

### 4.5 Execution (the stored record of one occurrence of an automation)

```
id: uuid, automationId: uuid | null (null on a create-mode test — no automation record exists yet),
automationName: automation name — serialized live from the automation while it exists, else the §5
  execution-time snapshot (a deleted automation's executions keep rendering their historical
  name),
automationDeleted: bool — derived: automationId names an automation that no longer exists (false when
  automationId is null — a create-mode test never had one to lose),
kind: version | draft | test — what was executed (§11 test executions are kind `test`), status,
version: int | null — the executed version number; null unless kind is `version`. The API
  serialization derives the display pair from these two: `ver` ("v3", "Draft", "Test") and
  `test` (kind == test) — neither is stored. Test executions appear in the Executions list
  (§7) but are excluded from the detail page's RECENT EXECUTIONS and an automation's
  execution-derived display state (lastStatus / latest result / live); deleted when the
  draft settles and by starting the next test — the list row disappears with the record
trigger: manual | menubar | cron | time | app_start | discord | imessage | test (future:
  pubsub) — the machine kind of what started the execution; stored as data, never the UI
  copy. The serialized `trigger` is the derived display label (manual → "Manual",
  menubar → "Menu bar", cron → "Cron", time → "Once", app_start → "App start",
  discord → "Discord", imessage → "iMessage", test → "Test", and the reserved
  pubsub → "Pub/Sub" — present in the backend label map for §4.3's reserved kind only; the
  API refuses to store pubsub triggers, so no record ever carries it and the renderer's
  trigger-label union omits it), and §19 execute requests
  send the kind
queuedAt: ISO timestamp | null — set when a §6 firing-queue entry is admitted, kept after
  promotion so the record shows how long it waited; null on every execution that started
  immediately. `startedAt` is (re)stamped when the record actually begins executing, so a
  promoted entry's duration measures execution, not waiting.
triggerPayload: message-trigger context | null (every non-message execution) — for Discord:
  { kind: "discord", text, sender (the author's display name), channel, channelName | null,
  guildName | null (both resolved best-effort from the §6 gateway guild cache at firing
  time — null for DMs or a cache miss; displays fall back to the raw channel id), messageId,
  guildId | null (null for DMs), secret (the trigger's token-secret name — reply routing,
  §6.1; never displayed by any surface), at (message ISO timestamp) }; for iMessage: { kind: "imessage", text, sender (the
  sender's handle — E.164 phone or email; no Contacts lookup), chat (the Messages chat guid —
  reply routing, §6.1), messageId (the message guid), at (message ISO
  timestamp) }. Persisted on the record, snapshotted at start —
  reply() keeps working on an in-place §7 retry even if the trigger was edited since.
  Exposed to steps via §6.1 (`execution.trigger_payload`, `AUTOWRIGHT_TRIGGER_PAYLOAD`).
  A §4.5 `test` execution also carries a payload when the test request mocked one (§19
  `triggerMock`, §11 test trigger message): same shapes, with the fields the backend can't
  truthfully supply null — discord `channelName`/`guildName`/`guildId`/`messageId`,
  iMessage `chat`/`messageId` — and `at` set to the test start; the trigger kind stays
  `test`
triggerSender: string | null — the payload's `sender`, lifted onto every execution row
  (list JSON carries no payload; the full payload is full-record-only). Lets the §7 and
  §9.2 trigger columns read "Discord · Dave · v3" without fetching the full record;
  null on non-message executions. Persisted in the §5 header index so it survives restart
duration, started ("Today, 8:00 AM"), startedMs, endedMs (0 while live and on rows whose
  `finished_at` was never set, e.g. §3 interrupted) — duration accumulates across in-place retry
  passes (§7); started never changes on retry
queuedMs: epoch ms of `queuedAt`, 0 on every execution that never waited — what the §7
  executions list ticks its WAITING FOR column from
steps: [{ name, file, status, duration, attempts: [{ number, status, duration, startedMs }] }] — file is the
  version-folder script filename (keys the per-attempt log files, §5). `file` is
  record-only: the API's full-record serialization emits only name/status/duration/attempts, and
  the §19 log endpoint addresses attempt files by step index, which is how the renderer keys
  them. A step's status equals
  its latest attempt's status, or queued when it has no attempts yet; attempt statuses use the
  step vocabulary (§4.6); duration is the latest attempt's duration. `number` is monotonic per step,
  never re-derived from list length: only the latest 20 attempts are retained — appending an
  attempt past that prunes the oldest entry and its log file (§5) — so an `infiniteRetries`
  step (§4.1) can't grow the record without bound; the true attempt count is the latest
  attempt's `number`, which is what the §7 ×N chip and attempt control read. On disk each step also stores
  `agent` (bool — the §4.1 agent-step flag, snapshotted at execution start) and
  `sha`, a short hash of the script as executed — the §7 Draft-retry drift check compares it,
  since a re-saved draft can change a step's code without changing its name or file
result: result object | null
workspace: string — full-record-only: absolute path of the execution's `workspace/` dir (§5),
  backing the §7 workspace link ("Show workspace in Finder", §4.9 Show-in-Finder rule)
redactedSecrets: secret names redacted in logs (a list) | null when none — display surfaces join it
params: the execution's snapshot of the automation's param definitions + resolved values — the
  §4.2 value-merged serialization, taken at execution start; stored in execution.yaml (§5),
  full-record-only in the API
note: optional note ("previous execution still in progress", "the queue was full (N waiting)",
  "Mac went to sleep") | null
error: { step | null, message, reason | null } | null — failed executions only: the failing
  step's name — null when the execution failed before any step ran (the pre-step secret
  checks, a package-install failure; the §7/§9.2 failure headline then reads "Execution
  failed") — its error message (redacted), and a plain-word possible reason when the engine
  can classify the failure (§7 failure diagnostics). The same error is also stored on the failing
  attempt ({ message, reason }); the execution-level field mirrors the latest failing attempt
  and is cleared by a retry pass that succeeds (attempt history keeps the old error)
pgid: int | null — on-disk only (never in list/full JSON): the process-group id of the live
  step's executor subprocess (each step runs in its own session, §7), stamped when the step
  spawns and cleared when the execution finishes. §3 startup recovery uses it to SIGKILL a
  step group orphaned by a backend crash — after checking the group still contains an
  `autowright.executor` process (pid-reuse guard) — before marking the record interrupted, so
  an orphan can't keep writing `memory/` while the next execution starts. Backend shutdown
  hard-kills every live step group the same way (an interrupted record must not leave its
  processes running)
```

Logs are not part of the record payload: they live as per-step-attempt NDJSON files in the
execution directory (§5) and are fetched lazily per selected step/attempt (§19).

Result object:
```
{ chip?, chipStatus?: changes|ok|attention — both only when the execution set a chip,
  files: [{ name, size }] — every file in the result dir, plus the dir
        path for the "Show in Finder" button }
```

The chip is optional — an automation may choose not to use one. It is stored on the execution
record itself (`chip` + `chip_status` columns in `executions.db`, §5): the engine copies
`result.chip(...)`'s text and the execution's `result.status(...)` (default `ok`) onto the record at
execution end, with no synthesized fallback text — an execution that never calls `result.chip()` shows no
chip anywhere.

On disk the rest of the result is a directory: the execution writes its output files
directly into `result/` (result.md, result.html, images, CSVs, …). There is no manifest — the
file list is the directory listing. Renderable files get their own result views (§7): `.md`
rendered as GitHub-flavored markdown — one shared Markdown component (react-markdown +
remark-gfm, app-styled; output is React elements, never injected HTML, so no sanitizer is
needed) used everywhere the app renders markdown, with one standard styling for every
surface: result views, the Build-instructions and Framework-instructions cards, and the
Spec cards (create flow and automation page — no spec-specific look; markdown renders the
same there as anywhere else) — `.html` in a sandboxed iframe (no
scripts, no remote loads — preserves the §6 no-exfiltration guarantee) with the app's base
result stylesheet injected, so plain semantic HTML renders in app typography and colors (a
page's own inline CSS overrides it), images inline; every other format appears only in the
file list. Tables are markdown tables inside result.md — there is no bespoke table renderer.
Files are part of the execution record — deleted with it by retention, never required for
list rendering (loaded only when the execution is opened).

### 4.6 Statuses (single badge vocabulary, executions and steps)

queued (gray) · executing (cyan) · succeeded (green) · failed (red) · cancelled (gray) ·
skipped (gray) · interrupted (magenta) · none → "Not executed yet" (gray).

The same vocabulary applies to executions, steps, and step attempts. `skipped` on an
execution means the whole occurrence was skipped by the scheduler (§6); on a step it means
the user skipped that step mid-execution (§7). `queued` on an execution means a §6 firing-queue
entry waiting for a slot; on a step it means the step hasn't started yet. **An execution that
never reached `executing` never counts as the automation's latest** (§4.1 `lastStatus`,
`resultChip`) — `skipped` and `queued` both mean exactly that. A §6 queue entry that is
cancelled before its turn therefore finishes **`skipped`**, not `cancelled`, with the note
saying it was cancelled: it never ran, and a status is the only thing an index header row
carries to decide this by.

### 4.7 Agent

```
{ id: uuid, name, description, harness: Claude Code | Gemini CLI | Codex | OpenCode,
  mode: default | ollama | custom, model }
```
`description` is an optional free-text description ("What this agent is for — shown on the Agents
page and given to the drafting agent"), rendered as the detail line on the agent card and
carried into the §8 grants yaml so the drafting agent knows what each enabled agent is for.
`model` is null when `mode` is `default` and required otherwise. Mode `custom` is valid with
every harness: the user types the model as a free-text string and the app passes it verbatim
to the harness CLI as `--model <model>` (§6, §19); the string is never validated by the app —
a wrong name surfaces as a harness error at invoke time. Mode `ollama`: `model` names the
local Ollama model. Mode `ollama` is valid with **Claude Code, Codex, and OpenCode** — Ollama
is not a harness of its own; it is the single local-model runtime every local-model agent
drives, and each harness connects to it through that harness's own supported mechanism
(§6 invocation, §19 readiness): Claude Code through its custom-endpoint env vars against
Ollama's Anthropic-compatible API, Codex through its official `--oss --local-provider ollama`
flags, OpenCode through its provider config (`opencode run --model ollama/<model>`). Mode
`ollama` is **not** valid with Gemini CLI — the stock CLI speaks only the Gemini wire format
and has no local or OpenAI-compatible endpoint support (documented limitation; the backend
rejects it with 422 and the UI shows the option disabled with the reason). A null model means the app never picks or passes a model — the harness uses whatever
model it is already configured with. Display shows "Default model" when the model is null. One agent is
the app default: a single `default_agent` id pointer in `agents.yaml` (§5) — never a
per-record flag, so "exactly one default" holds structurally; the API serializes each
agent's derived `default` bool and its derived `usedBy` — the names of automations that use
the agent, as their drafting agent or via a current-version step's `agents:` grant list
(§4.1). Deleting the default agent repoints the pointer and warns
which automations use it.
All four harnesses are selectable. The app can install any of them (plus Ollama, for the
local-model mode) and help the user sign in when the harness needs an account (§10 step 2,
§19 install/login endpoints).

### 4.8 Secret

`{ name, description, set, usedBy }` — the value itself is never part of the entity (Keychain-only,
below). `usedBy` is the list of automation names whose current
version uses the secret (the UI joins it; empty list renders "Not used yet"). Names uppercase, `[A-Z][A-Z0-9_]*` — sanitization (uppercase,
invalid chars → `_`) is UI input behavior; the backend validates strictly and rejects nonconforming
names with HTTP 422. `description` is an optional free-text description ("What this secret is for — shown
on the Secrets page and given to the drafting agent"), stored next to the name in `secrets.yaml`
(never in the Keychain) and carried into the §8 grants yaml so the drafting agent knows which
secret to use. Values are arbitrary strings and may be multi-line (e.g. a PEM key). Values stored
in macOS Keychain, masked at rest; the API never returns secret values — show/hide applies to the
value being typed in the add/edit modal, not to stored values. `set` is a backend-maintained
boolean in `secrets.yaml`: saving a **new** name with a blank value creates a **placeholder**
(`set: false`) — the name and description exist, no Keychain entry does; the Secrets page and
grant surfaces show an amber "Not set" tag until a value is saved. Writing any nonblank value
stores it in the Keychain and flips `set` to true; saving an existing secret with a blank value
keeps the stored state (a set secret keeps its value, an unset one stays unset) and updates only
the description. An execution needing an unset secret fails before any step with "secret `NAME`
has no value yet — add it on the Secrets page" (same pre-step gate as a missing Keychain entry,
§7). Import (§5.1) creates placeholders for referenced secrets that don't exist locally.
Step scripts reference them by name
(`secrets.NAME`); values are injected at runtime and redacted from logs. Because log lines are
redacted one at a time, each non-blank line of a multi-line value is redacted individually as well,
and the §6 agent-prompt scan likewise checks every non-blank line of a multi-line value, not just
the whole string. Deleting a secret in use warns: the automation "uses it by name and will stop
working."

### 4.9 Settings

```
login: bool        — "Launch at login" ("Autowright starts quietly in the menu bar.")
menuBarIcon: bool       — "Show in the menu bar" ("The quickest way to execute an automation.")
  Both are OS-side effects owned by the Electron shell, reconciled from these stored values —
  at startup and on the shell's periodic backend poll (so a tray-only app follows §20 CLI
  changes), plus a renderer push on every settings change: `login` registers/unregisters the
  macOS login item (the default true registers on first launch), `menuBarIcon` creates or
  destroys the tray icon live (no restart; hiding it also hides an open §13 panel).
keepAwake: bool (default true) — "Keep this Mac awake" ("Prevents this Mac from sleeping so
  schedules and message triggers keep firing. The display can still sleep.") — while on, the
  backend holds a permanent idle-sleep power assertion (§3 sleep bullet); applied live on
  settings change, no restart. Row sits in the GENERAL card below "Show in the menu bar".
automaticUpdateCheck: bool (default true) — "Check for updates automatically" ("Once a day,
  ask autowright.ai whether a newer version exists. Downloads still start only when you ask.")
  — on by default (PRIVACY.md names the daily check and its off switch; existing installs
  gain the key as true through the defaults merge). Turning it off restores strict
  manual-only checking. Stored here for §20 CLI parity; consumed by the Electron shell's §3
  automatic-check machinery through the same reconcile path as `login`/`menuBarIcon`. Its
  toggle row lives on the About page's UPDATES card (§9.4), not Settings.
notifications: attention | all — "Only when something needs attention" / "After every execution"
days: int ≥ 1 (default 90) — history retention; keepForever: bool disables cleanup
developerMode: bool (default false) — "Developer mode" ("Logs every backend request and every AI
  request — including the full prompt — to the backend log. Press `` ` `` to show the logs
  panel.") — gates request logging, the per-request log files under `<logs>/requests/` (§5),
  the §5 build-failure records under `<logs>/build-failures/`, and the `` ` ``-key log
  overlay (§9.3)
dataPath (default ~/Library/Application Support/Autowright/executions), dataSize
appPath — derived, serialization-only: the fixed automations-and-settings root
  (~/Library/Application Support/Autowright) — backs the ON THIS MAC card's
  "Automations & settings" Show in Finder button (below)
```
Show in Finder (everywhere it appears) opens the target directory itself in Finder when the
path is an existing directory (e.g. Execution data opens the executions dir, not its parent), and
falls back to selecting the item in its parent folder otherwise.
Execution-data section: Change then Show in Finder; Change opens the native macOS folder picker and the chosen
directory simply becomes the execution-data location — no move/cancel UI and no data migration: all
execution state lives inside the executions dir, so changing the path just points Autowright at
the new location (the old dir stays where it was).
The "Keep executions for" days row is hidden (not just disabled) while "Keep execution history forever" is
on. One **ON THIS MAC** card holds two rows: **"Automations & settings"** (the fixed path
`~/Library/Application Support/Autowright` with its own Show in Finder button — this location
is not changeable) above the **Execution data** row. A **DEVELOPER** card sits last on the page with
the single **Developer mode** toggle row (developerMode above). Version, updates,
GitHub links, licenses, and the disclaimer live on the About page (§9.4), not here.

