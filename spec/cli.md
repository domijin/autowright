# Autowright SPEC — CLI

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 20. CLI (decided)

> **Status: enabled.** The full surface is registered (`cli.CLI_ENABLED = True`). The condition
> for enabling was settling the grant model, and it is settled — see **Grant model** below: no
> all-on secret seed on `create`, no silent grant widening on `push`; every grant is an explicit
> repeatable flag on the command line. This is the enforcement the disabled era lacked: an agent
> driving the CLI cannot acquire a secret without the grant being visible in the very command it
> runs, and the §17 skill requires showing that command — grant flags included — in the pre-save
> summary. Headless mode (§3) un-parks with it.

`autowright` (`backend/autowright/cli.py`) is the second client of the §19 API — full UI parity
for headless and agent-driven use. It ships only inside the app bundle (§3 CLI-on-PATH shim;
never pip). Design goals: every UI operation reachable, output parseable by an AI agent, and
automation authoring done through **real files on disk** so an agent edits spec/steps the same
way it edits any code. The §17 `skills/autowright/` agent skill is the primary consumer.

**Command structure** — noun-verb groups (full words per the §2 naming rule):

```
autowright status                       backend health, version, entity counts
autowright instructions                 §8 framework + build instruction files, verbatim
autowright automation <verb> …          list · show · pull · push · create · delete · restore ·
                                        execute · export · import ·
                                        param list|set · trigger list|add|on|off|remove ·
                                        memory clear · snapshot list|create|restore|delete
autowright execution <verb> …           list · show · tail · cancel · retry · skip · result
autowright secret list|set|delete
autowright agent list|check
autowright settings show|set
autowright service install|uninstall|status|restart   (§3 — the only group that needs no backend)
```

- **References:** automations resolve by id, exact name (case-insensitive), or unique name
  substring; executions and snapshots by id prefix. Ambiguity or no match exits with the
  candidate list.
- **`--json`** on every read verb (`status`, `instructions`, `automation list|show`,
  `param list`, `trigger list`, `snapshot list`, `execution list|show`, `secret list`,
  `agent list`, `settings show`) prints the raw API JSON instead of the human columns —
  the machine mode agents parse.
- **Trigger message parity (§7):** `execution show`'s human output prints a
  `trigger message:` line when the record carries the §4.5 `triggerPayload` — the same input
  the UI's TRIGGER MESSAGE block shows. Kind-aware, like the UI: Discord prints
  sender · `#channelName · guildName` (raw channel id when the names are null, guild part
  omitted when null) · time; iMessage prints sender · time (an iMessage payload has no
  channel — it must not KeyError on one). Then the text, indented. The `secret` is never
  printed. `--json` carries the raw payload (and list rows the §4.5 `triggerSender`) as always.
- **Exit codes:** 0 success · 1 any error (connection, HTTP, validation, bad reference —
  message on stderr, §3 guidance style, never a traceback) · 2 from `automation execute -f`
  and `execution tail` when the followed execution ends in any terminal status other than
  `succeeded` — so a harness can branch on the exit code without parsing prose.

**Workdir (the authoring format).** `automation pull <ref> [dir]` materializes an automation
into a directory; `automation push <ref> [dir] [--note] [--grant-agent NAME]…
[--grant-secret NAME]…` validates it and saves vN+1; `automation create [dir] [--name]
[--agent] [--grant-agent NAME]… [--grant-secret NAME]…` validates and creates v1. Files:

- `spec.md` — the spec as markdown (§4.1 blocks ↔ markdown via `specmd`).
- `manifest.yaml` — the §8 call-2 manifest shape verbatim: `name`, `desc`, `note`, `triggers`
  (the §8 rule-9 dialect — cron / imessage / discord / app_start entries; `pull` writes the
  stored crons only), `params` (full §4.2 definitions with
  defaults, **value fields stripped** — values are user-owned operational state, set via
  `param set`, never round-tripped through versions), `packages`, `steps` (file, name, desc,
  `agent`/`why`/`agents`, `secrets`, `timeout`/`no_timeout`).
- `NN-name.py` — one file per step, matching `steps[].file`.
- `instructions.md` — the version's build instructions (`instr`), when present.
- `notes.md` — the version's §4.1 notes document, when nonempty; push saves it verbatim.

Push/create run the **same §8 validators the drafting pipeline uses**
(`drafting.validate_spec` + `validate_steps` — schema, param kinds/defaults, step-file 1:1 and
ordering, `ast.parse`, the §6.2 import allowlist, timeout rules, trigger dialect). Validation
errors print one per line and exit 1 with nothing written — agents iterate on the files until
clean. Existence context for the validators is all configured agents plus all stored secrets,
so a manifest naming an unknown agent/secret fails with the §8 message; which of the *known*
names the automation may actually use is the grant model's job, below.

**Declared packages install at save.** After a successful `create`, `push`, or `import`, the
CLI runs the §6.2 ensure (`POST /packages/install`) for the saved version's declared packages
and prints one line per package — `package <pip> <version> installed`, or a
`warning: package <pip> failed to install — <error>` line on failure. A failure warns and
exits 0: the save already landed, and the §8 rule applies — an install failure never fails a
build; the engine's pre-execution ensure (§7) retries it before anything runs. No declared
packages → nothing printed. This mirrors the §8 drafting pipeline's install stage: the user
learns about an install failure at build time, not when a trigger fires.

**Grant model (settled).** Grants are explicit on the CLI — no all-on seed, no silent widening:

- `automation create` saves `stepAgents`/`allowedSecrets` as exactly the grants passed via the
  repeatable `--grant-agent NAME` / `--grant-secret NAME` flags. Each flag must name a
  configured agent / stored secret; an unknown name exits 1 with the candidate list.
  `--grant-agent` takes the agent's §8 grant name (case-insensitive), but `stepAgents` stores
  agent **ids** (§4.1 — the enablement list the engine and UI resolve by id); the CLI maps the
  matched name to its id on save. `allowedSecrets` stores secret names as given.
- `automation push` saves the automation's stored lists plus any `--grant-agent`/
  `--grant-secret` flags. Stored grants never shrink on push (they are user-owned state, like
  param values); the UI edit page remains the place to revoke.
- After validation, the CLI computes the names the workdir actually needs — per-step `agents`,
  per-step `secrets`, plus the code-referenced `secretRefs` — and any needed name outside the
  saved grants exits 1 listing the exact flags to add, nothing written. Agent comparison
  happens at grant-name level: stored `stepAgents` ids map back to their §8 grant names before
  the needed-vs-granted check. An `agent: true` step with no `agents:` list runs on the first
  enabled agent (§6), so it needs at least one granted agent: when none is granted, the save
  exits 1 asking for a `--grant-agent` flag with the configured-agent candidates. A
  granted-but-unused name is fine (a deliberate pre-grant).
- Why this shape: the grant for a secret must appear in the command line the user (or the
  agent the user is watching) runs — never implied by the workdir's content alone, which an
  agent authors. The §17 skill's pre-save summary must show the full command including grant
  flags. `execute` is unchanged — it runs the stored version under the stored grants.

**Trigger semantics on push** — the §4.3 trigger merge, performed client-side exactly
like the editor: the manifest's cron entries are matched against the stored list on
(`expr`, `tz`) — matches keep their `id` and `off` state, new entries arrive enabled, stored
crons the manifest no longer lists are dropped; the manifest's `discord`/`imessage`/
`app_start` entries add only when no stored trigger matches their §4.3 identity fields; and
stored non-cron triggers always survive untouched. `pull` writes the stored crons into the
manifest, so an untouched manifest round-trips the schedule unchanged. Between pushes, `trigger add` (cron by default,
`--at` for a §4.3 one-shot, `--app-start`, `--discord <channel> --secret <name>
[--pattern <text>] [--mention] [--author <user-id>[,<user-id>…]]…` for a §4.3 discord
trigger (`--author` repeats and each value may be comma-separated — all ids collect into
the trigger's one `author` list), or `--imessage <from>
[--pattern <text>]` for a §4.3 imessage trigger), `trigger on|off <n>`, and
`trigger remove <n>`
edit the stored list directly (1-based indexes as printed by `trigger list`) via the §19 PATCH.

**Param values** — `param set <ref> NAME=VALUE …` PATCHes `paramValues`, parsed by the
definition's kind: toggle `on|off|true|false` → bool · number → int · text → string · list →
JSON array or comma-separated · kv → JSON object or `k=v,k=v`. An unknown name or unparseable
value exits 1 naming the expected form.

**Secret values never ride argv** — `secret set NAME` takes no value argument: it prompts
(`getpass`, no echo), or reads the value from stdin with `--stdin` for scripted use. A value
passed as an argument would land in shell history and in every local process's view of the
process list, which is exactly what "passwords never leave your Keychain" (§1) rules out.

**Destructive guard** — `automation delete` requires `--yes` (it removes every version and its
history); everything else is either reversible (versions, snapshots) or already the §19
single-call semantics the UI uses.

**Review semantics in CLI terms:** a CLI save or
execute is user-reviewed by definition — the user (or the agent the user is driving) authored
the exact files being saved; there is no unreviewed AI output between the workdir and the
version. The §17 skill's instructions still require presenting a summary before
`create`/`push` + `execute` — including the full command with its `--grant-*` flags, per the
grant model above.

**`instructions`** prints the §8 `framework-instructions.md` (and `--json` both files) so an
agent authoring step code reads the engine contract — the step SDK, curated imports, policy
sections — from the same canonical file the drafting pipeline sends to harness agents.

Old flat commands (`autowright list`, `execute`, `executions`, `tail`, `secrets`, `agents`,
`export`, `import`) are replaced by the groups above — no aliases, no back-compat (§ rules).
`service` keeps its §3 verbs unchanged.

**Deferred (not yet in the CLI):** agent add/edit/delete/install/login (interactive TUI flows,
§19), Ollama management, settings `dataPath` picker parity beyond `settings set dataPath=`,
the §8 drafting jobs (`POST /drafts` — the skill's agent drafts directly instead), and §11
test executions (`POST /tests`).
