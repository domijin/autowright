# Project: autowright

## Rules

- For any feature change, capture it in the spec. The spec is the source of truth and must hold enough detail to
  rebuild the entire app from scratch. It is split across `SPEC.md` (the index: section map, §1 product, §2
  architecture, §17 repository) and `spec/*.md` (all other sections, grouped by domain; § numbers are global).
  Read `SPEC.md` first and open only the spec files the task touches. Update the spec **before** starting the code
  change; amending it again after the code change starts is fine. When adding or moving sections, keep the
  `SPEC.md` section map current.
- Developer mode and production mode must behave the same: no mocked data in developer mode, and no separate
  dev-only code paths. Both modes execute the same real code.
- The `scripts/` directory is developer-only — never run anything under it (enforced by a PreToolUse
  hook). To verify changes, use the `verify` skill's direct launches instead.