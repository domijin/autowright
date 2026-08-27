# Project: autowright

## Rules

- For any feature change, capture it in the spec. The spec is the source of truth and must hold enough detail to
  rebuild the entire app from scratch. It is split across `SPEC.md` (the index: section map, §1 product, §2
  architecture, §17 repository) and `spec/*.md` (all other sections, grouped by domain; § numbers are global).
  Read `SPEC.md` first and open only the spec files the task touches. Update the spec **before** starting the code
  change; amending it again after the code change starts is fine. When adding or moving sections, keep the
  `SPEC.md` section map current.
- On-disk data written by released versions (v0.6.0+) must keep loading. Changing a stored
  shape requires a migrate-on-load migration, an old-shape fixture test, and a §21 decision-log
  entry (`spec/compatibility.md`).
- Developer mode and production mode must behave the same: no mocked data in developer mode, and no separate
  dev-only code paths. Both modes execute the same real code.
- The `scripts/`, `windows-scripts/`, and `linux-scripts/` directories are developer-only — never
  run anything under them (enforced by a PreToolUse hook). To verify changes, use the `verify`
  skill's direct launches instead.
- Never create commits (or push) on your own. Leave finished work
  uncommitted in the working tree, and only commit/push when he explicitly asks in that
  conversation.

## Model delegation

The main session runs on the top-tier model; delegate execution-heavy work to the Opus 5
subagents defined in `.claude/agents/` and keep judgment in the main loop.

- Delegate to Opus 5:
  - `scout` for codebase/spec exploration and multi-file reads; keep only the conclusion in
    the main context.
  - `mechanic` for mechanical edits once the approach is fully decided: renames, repetitive
    multi-file changes, fixture updates, tests written to an already-settled design.
  - `runner` to execute pytest/vitest/e2e suites and summarize failures.
  - `verifier` for the whole verify drive loop (build, launch, drive, screenshot, launchd
    cleanup). It returns a report plus screenshot paths.
- Keep in the main session (never delegate): spec authoring and design decisions,
  architecture, non-obvious debugging, compatibility migrations (§21), final review of every
  subagent result, and the visual sign-off on UI changes: after `verifier` returns, the main
  session reads the key screenshots itself before reporting.
- The pattern: the main session decides and judges, Opus executes and reports. If a subagent
  reports a mismatch or ambiguity, resolve it in the main session; don't have the subagent
  improvise.