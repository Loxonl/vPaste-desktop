# Repository change guardrails

## Before editing

- Write concrete acceptance criteria and map every planned behavior change to one.
- Do not remove, weaken, or replace existing user-visible behavior unless the request requires it. If it becomes necessary, explain the impact before editing.
- Performance work requires evidence from profiling, logs, or a reproducible benchmark. Keep unrelated optimization in a separate change.
- When replacing an existing mechanism, add regression coverage for preserved behavior and record actual-runtime verification to complete during PR review.

## Before committing

- Review every changed line and deletion; each must trace to the request or its required verification.
- For bug fixes, add regression coverage for the reported behavior when feasible. Local test execution is not required before opening a PR; PR CI can verify the test.
- List user-visible behavior changes and removed mechanisms explicitly in the pull request description.
- Do not mix unrelated cleanup, refactoring, or formatting into the same pull request.

## Before opening a pull request

- Run the relevant compile/build check: `npm run build` for frontend changes and `cargo check --locked --all-targets --manifest-path src-tauri\Cargo.toml` for Rust/Tauri changes. Documentation-only changes need no build.
- Once compilation succeeds, create the PR. Local unit, visual, style, formatting, and manual tests are not creation gates. Record completed and pending checks in the PR; required CI checks must pass before merge.

## UI Governance (React/MUI/Motion)

These rules apply to every React UI change, including auxiliary Tauri windows. The detailed reference is [docs/open-source/frontend-ui-guidelines.md](docs/open-source/frontend-ui-guidelines.md).

- Keep the UI stack as React 18 + MUI 5 + Motion + CSS Modules. Do not add Tailwind or a second component/animation system.
- Use MUI for standard buttons, icon buttons, text fields, selects, switches, tabs, menus, dialogs, and progress controls. Reuse shared primitives from `src/ui/` before creating a new product pattern.
- Put shared MUI appearance in `src/ui/appTheme.ts`, design tokens in `src/ui/tokens.css`, and feature/window layout in colocated `*.module.css` files. Do not target `.Mui...` from page CSS or put visual tokens in `sx`.
- Import Motion only from `src/ui/motion`; use its named presets and tokens. Do not import `motion/*` or `framer-motion` directly, invent animation timings, or let CSS, Motion, manual dragging, and Tauri animate the same transform.
- Do not add raw `button`, `input`, or `select` elements unless the element is a documented special surface. If a special exception is necessary, reduce or update `scripts/ui-governance-baseline.json` in the same change and explain why.
- Preserve Tauri window geometry, transparent gutters, native window motion, commands, configuration formats, database behavior, and installer/release files unless the task explicitly requires otherwise.
- Before opening a UI PR, a successful `npm run build` is sufficient. `npm run check:styles` and `npm run check:ui` are optional local checks, not PR creation gates. Visual tests remain local-only for this workstream because GitHub Actions quota is limited.
- For UI changes, record user-visible behavior changes, removed mechanisms, platforms checked, and checks actually run in the PR. Check normal and reduced-motion behavior during review when Motion is involved, and mark it pending in the PR until checked.
