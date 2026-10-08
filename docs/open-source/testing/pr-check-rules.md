# Pull Request Check Rules

Use this checklist before requesting review.

## Required For Every PR

- Use a focused branch such as `feature/...`, `fix/...`, `docs/...`, or `release/...`.
- Do not merge directly from local work into `main`; open a GitHub PR.
- Use the PR title format `vPaste-#<issue-number>: <english summary>`. For PRs without a related issue, use `MINOR: <english summary>`.
- Request maintainer review.
- Wait for GitHub Actions before merging. Require the `PR checks passed` check from the `PR checks` workflow. Code changes run frontend checks and Rust checks on Windows and macOS; documentation-only changes skip build/test jobs but still report the final check. Review CodeQL results as well.
- Keep the change focused.
- Fill in `.github/pull_request_template.md`.
- Explain user-facing behavior.
- List commands run.
- List manual tests run.
- State known limitations or follow-up work.
- Confirm no secrets, logs, databases, local history, build outputs, installers, or machine-specific notes are committed.
- Prefer Squash merge for normal feature, bug fix, and documentation PRs. Release PRs may use a merge commit when useful.

## Review Inbox Handling

Before continuing work on an existing PR branch, before pushing more commits, and before merging:

1. Check the PR review decision, unresolved review threads, issue comments, inline comments, and CI status.
2. Turn unresolved or actionable feedback into a concrete task list.
3. Resolve blocking reviewer feedback before adding unrelated functionality to the same branch, unless the project owner explicitly defers it.
4. Update code, docs, tests, platform notes, and the PR description together when the feedback affects them.
5. Rerun the relevant validation commands.
6. Reply to each reviewer thread with the resolution, verification, or deferral reason.

Suggested first-pass command:

```powershell
gh pr view --json number,title,state,reviewDecision,reviews,comments,statusCheckRollup
```

Use GitHub GraphQL for unresolved review thread details when `gh pr view` is not enough. If unrelated work needs to start while a PR still has active feedback, create a new branch from updated `main`.

## Required Commands By Change Type

The ordinary PR workflow uses `pull_request` with a read-only token, checks the PR merge commit, and does not use release environments or signing secrets. It runs frontend style checks, build/types, the full unit suite, release-version consistency, and license inventory on Ubuntu. Windows and macOS jobs check Rust formatting, compilation, and tests, including the updater-manifest verifier. A failed, cancelled, or unexpectedly skipped build/test job prevents the final check from passing.

Only changes confined to Markdown, `docs/`, `LICENSE`, issue forms, and `CODEOWNERS` skip build/test jobs. Workflow, source, configuration, script, and lockfile changes run the checks. Visual tests and native clipboard smoke tests remain local; the hosted checks do not launch the desktop UI, build installers, or publish a release.

| Change Type | Required Check |
|---|---|
| Frontend TypeScript/CSS/UI | `npm run check:ui` |
| Rust backend/Tauri commands | `cargo check --locked --all-targets --manifest-path src-tauri\Cargo.toml` and `cargo test --locked --all-targets --manifest-path src-tauri\Cargo.toml` |
| Rust formatting-sensitive changes | `cargo fmt --all --check --manifest-path src-tauri\Cargo.toml` |
| Clipboard behavior | Relevant cases from `docs/open-source/testing/clipboard-cases.md` |
| Release scripts/config | `npm run check:release`, `npm run check:licenses`, workflow lint, and the relevant release flow document |
| Language text | Verify both `src/lang/locales/en-US.ts` and `src/lang/locales/zh-CN.ts` when applicable |

## Platform Expectations

### Windows PRs

- Validate on Windows 11 when possible.
- For clipboard changes, test at least one real external app.
- For installer/update changes, verify generated artifacts and release notes.

### macOS PRs

- Clearly mark whether the PR is a compile-only step, local dev build step, or user-facing behavior step.
- Prefer small PRs that isolate one platform area: clipboard listener, restore, source app, menu bar, shortcut, packaging, or updater.
- Update `docs/open-source/platform/macos.md` when behavior or scope changes.

## Review Blocking Issues

- Secret or private key committed.
- Local user path committed.
- Generated binary or installer committed unintentionally.
- Main panel or search introduces visible input/scroll lag.
- Clipboard change loses text, image, file, or rich fallback data for a supported scenario.
- Platform-specific code leaks assumptions into shared code without documentation.
