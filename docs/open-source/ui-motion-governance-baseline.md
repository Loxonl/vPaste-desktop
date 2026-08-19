# UI and Motion Governance Baseline

This document is the phase-one baseline for issue #133. It records the current architecture before component convergence or Motion integration. Phase one changes no production UI.

## Fixed Architecture

- React 18 + MUI 5 + Motion + CSS Modules; no Tailwind and no React/MUI major upgrade in this workstream.
- MUI owns standard control semantics and accessibility. CSS Modules own window layout and brand surfaces. Motion owns conditional presence and small state/layout continuity. Tauri owns native window motion.
- The Windows installer, release scripts, Tauri commands, configuration schema, database, and user workflow are outside this workstream.
- Motion is introduced only after the affected controls are structurally converged. Existing CSS and Web Animations API code remains frozen until its owning phase.

## Current Inventory

The machine-readable inventory is `scripts/ui-governance-baseline.json`. At baseline it contains:

- 17 TSX modules with native `button`, `input`, or `select` controls.
- 8 CSS files with hard-coded transition or animation declarations.
- 2 TypeScript modules with hard-coded scripted motion parameters.
- 1 Web Animations API owner: `src/clipboard/TutorialOverlay.tsx`.

The checker requires an exact match, so both new violations and silent removals fail. A migration pull request must reduce the baseline together with the code change.

## Production Bundle Baseline

Measured on 2026-08-19 with Windows, Node 24.11.1, npm 11.6.2, Vite 7.3.6, Playwright 1.62.0, Chromium 151.0.7922.34, and a clean production build:

| Metric | Baseline |
| --- | ---: |
| JavaScript chunks | 26 |
| Total JavaScript | 1,246,808 bytes |
| Total JavaScript gzip | 300,308 bytes |
| Largest shared chunk (`itemPresentation`) | 581,027 bytes / 86,302 bytes gzip |
| Application entry chunk | 242,962 bytes / 82,691 bytes gzip |
| Config chunk | 184,008 bytes / 53,607 bytes gzip |
| Clipboard chunk | 109,033 bytes / 33,688 bytes gzip |

Hashed filenames are intentionally omitted from comparisons. Re-run `npm run build` and compare byte counts after dependency or Motion changes.

## Local Interaction Benchmark

Run the non-gating benchmark with:

```powershell
npm run benchmark:ui
```

It measures 15 keyboard selection changes with 36 rendered clipboard cards and 10 first-response drags with 100 rendered Paste Queue rows. Results are local engineering evidence, not GitHub Actions checks. Compare the median and p95 on the same machine and browser. If Paste Queue interaction regresses by more than 10% in phase seven, remove Motion layout compensation and retain only opacity/translation feedback; do not replace the drag engine in this workstream.

Initial clean run on the environment above:

| Scenario | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| 36-card keyboard selection | 15 | 3.80 ms | 5.34 ms |
| 100-row Paste Queue drag response | 10 | 26.38 ms | 34.61 ms |

The raw sample list is printed by the command. Do not compare these numbers across different machines or browser versions.

## Windows Visual-Baseline Completion

The first Windows run on the unchanged production source exposed five Paste Queue cases that only had `chromium-darwin` snapshots and one settings screenshot that predated the current main-branch render. Phase one adds the missing `chromium-win32` Paste Queue snapshots and refreshes the settings shortcut snapshot after its geometric alignment assertion passes. These are baseline artifacts only; no production source or CSS changed. They require manual approval in the phase-one pull request before later visual comparisons use them.

## Phase-Two Settings Convergence

Settings section actions use MUI controls after phase two. Repeated link and history-transfer surfaces share `src/ui/ActionCard.tsx`; permission status and shortcut recording use MUI `ButtonBase`, and the privacy-app removal action uses MUI `Button`. The four native controls remaining in `src/config/Config.tsx` are platform window controls and stay in the temporary baseline as an explicit exception.

The migration preserves the existing settings screenshots and bridge callbacks. UI Lab adds horizontal, vertical, and disabled ActionCard samples; its five changed Windows snapshots require local manual approval. No GitHub Actions visual job is added.

## Phase-Three Main-Window Overlay Convergence

Main-window and Paste Queue overlays share four product components after phase three: `ConfirmDialog`, `InlineMenuSurface` / `InlineMenuItem`, `StatusToast`, and `ToolbarIconButton`. Destructive confirmation now uses the MUI Dialog focus trap, Escape handling, Portal, and focus return. Coordinate-sensitive menus remain in the current webview and keep their feature-owned click coordinates, widths, submenu direction, and Tauri dismissal events.

Across `Clipboard.tsx`, `ClipboardHeader.tsx`, `ClipboardOverlays.tsx`, and `PasteQueue.tsx`, the temporary inventory drops from 38 raw buttons to five. The remaining three Clipboard header buttons are draggable/custom tab surfaces; the remaining two Paste Queue buttons own pointer dragging and direct item activation. The native Clipboard search input also remains for its existing composition and shortcut behavior.

This phase adds no Motion dependency and does not replace the existing CSS entry animations. UI Lab displays the shared menu, Toast, toolbar action, and confirmation dialog. Local screenshots cover the tag-create menu plus Paste Queue menu and clear confirmation; hosted visual checks remain disabled.

## Phase Gates

1. Governance baseline and inventory: no production visual changes.
2. Settings controls: behavior and rollback remain identical.
3. Main-window overlays: converge structure before adding motion.
4. Tags and auxiliary windows: preserve coordinates, transparency, shadow, and platform behavior.
5. Motion foundation and menu/Toast pilot: normal and reduced-motion behavior verified directly.
6. High-value state transitions: no whole-window Motion transform.
7. Cards and Paste Queue: 36/100-item local benchmark and 10% rollback rule.
8. Tutorial and cleanup: only replace Web Animations API after behavior coverage exists.

Each phase is a separate pull request and stops for manual screenshot review. This workstream does not add GitHub Actions jobs; the pull request checklist prompts the maintainer to run architecture, build, unit, visual, and benchmark checks locally as applicable.
