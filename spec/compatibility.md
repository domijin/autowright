# Compatibility

## 21. Backward compatibility

Adopted 2026-08-23, with v0.6.0 as the current shipped release. This reverses the earlier
no-backward-compat rule: from v0.6.0 on, an upgrade must never strand user data. This section
is the single home for the promise (§21.1), the strategy (§21.2), what is deliberately out of
scope (§21.3), and the decision log (§21.4). Every change to a stored shape lands an entry in
the log, so the history of compatibility decisions can be revisited in one place.

### 21.1 The promise

On-disk user data written by any released version >= v0.6.0 loads and works in every newer
version. Covered: everything the app persists under the §5 roots that the user would lose by
deletion - automations (manifest, spec, instructions, notes, versions, step scripts),
triggers, executions, agents, secrets metadata (their Keychain entries included), and
settings. Derived stores are exempt where the spec already defines a rebuild: `executions.db`
keeps its `SCHEMA_VERSION` drop-and-rebuild (§17), and caches, markers, and step
environments (§6.2 self-heal) may be regenerated.

The promise covers released shapes only: what a tagged release actually wrote. Hand-edited
files, corrupt data, and shapes no release ever shipped stay under the §5 lenient-load
backstop (skip with a warning, never fatal, never healed), not under this promise.

### 21.2 Strategy: migrate on load

When a stored shape changes, the reader keeps accepting the old shape and upgrades it to the
current in-memory model at load; the next save writes only the current shape. Rules:

- One migration per shape change, written together with the change, spec-first like
  everything else: the shape change and its migration are specified here before code starts.
- Migrations live at the read seam - the loader for that file kind - never scattered through
  call sites. The rest of the code sees only the current shape.
- No permanent field aliases and no dual-write: writers emit exactly the current shape.
- No stored schema-version machinery for the YAML stores. An old shape is recognized
  structurally (absent field, old field name, old value form). If a change ever cannot be
  recognized structurally, that change introduces whatever marker it needs and records the
  reasoning in the §21.4 log.
- Every migration ships a fixture of the real old on-disk shape plus a test proving the
  fixture loads and re-saves as the current shape.
- Migrations are kept until the log retires them; a retirement (for example "shapes older
  than two years dropped") is itself a §21.4 entry.

Interaction with existing rules:

- §5 lenient load stays the backstop beneath this policy: data no released version wrote
  still skips with a warning, never crashes, never heals. Migrate-on-load takes precedence
  for shapes a released version >= v0.6.0 actually wrote - those must load, not skip.
- The §2 naming policy still forbids aliases on served surfaces (API fields, routes, CLI
  flags change both ends in one commit). What changes: a rename or reshape of a *stored*
  field now requires a load migration here, instead of relying on lenient load to drop the
  old field.

### 21.3 Out of scope (recorded so they can be revisited)

- **Transfer archives (§5.1):** no promise yet that an export written by an older version
  imports into a newer app.
- **API/CLI version skew:** no promise for an older CLI or app shell against a newer
  backend. §3 packaging ships shell and backend at one locked version, and the CLI command
  surface keeps its no-alias rule (§20).
- **Forward compatibility:** data written by a newer version opened in an older app stays
  under §5 lenient load only.

### 21.4 Decision log

Newest first. One entry per compatibility decision: what changed, the migration, the first
version that writes the new shape, and the oldest shape still read.

- **2026-08-23 - policy adopted.** Baseline v0.6.0; scope on-disk user data (§21.1);
  strategy migrate-on-load (§21.2); transfer archives, API/CLI skew, and forward
  compatibility out of scope (§21.3). No migrations exist yet - the formats v0.6.0 writes
  are the baseline.
- **(pre-policy, stands) 0.3.4/0.3.5 materialized `cliEnabled: false`** for users who never
  touched the toggle: accepted with no migration when the default flipped to true (§4.9).
  Revisit only if support burden appears.
