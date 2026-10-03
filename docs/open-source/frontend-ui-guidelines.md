# Frontend UI Guidelines

vPaste uses React 18 and MUI 5 as its component system. Tailwind is intentionally not part of the stack. The desktop windows share one compact cross-platform visual language; platform differences are limited to behavior that must follow the operating system, such as title-bar controls.

## Where Styles Belong

- Put semantic color, spacing, radius, shadow, control-height, and focus tokens in `src/ui/tokens.css`.
- Put MUI component defaults and state styling in `src/ui/appTheme.ts`.
- Put reusable React UI in `src/ui/`.
- Put window or feature layout in a colocated `*.module.css` file.
- Keep `src/theme.css` limited to token loading, root behavior, theme synchronization support, focus visibility, and reduced-motion protection.
- Do not target `.Mui...` from page styles. If a MUI control needs a shared visual change, update the theme.
- When DOM code looks up a CSS Module class with `closest`, `querySelector`, or a direct `className` assignment, use the imported module value rather than the unscoped source class name.
- Files listed in `tokenizedCss` inside `scripts/ui-governance-baseline.json` have completed visual-token migration. They must not reintroduce literal colors, pixel radii, or component-local shadows; add a file to that list when its migration is complete.

Use `sx` only for a one-off layout relationship such as flex sizing, alignment, or a calculated width. Do not put colors, font sizes, radii, shadows, or control heights in `sx`.
`npm run check:styles` enforces this split for object-form `sx`; move visual values to `appTheme.ts` or the feature's CSS Module instead of weakening the check.

## Choosing Components

- Use MUI for interactive controls such as buttons, selects, text fields, switches, tabs, menus, dialogs, and progress indicators.
- Use the shared settings primitives for conventional label/description/control rows.
- Give each `SettingsRow` a stable `labelId` (and `descriptionId` when present), then connect its MUI control with `aria-labelledby` and `aria-describedby`. Visible proximity alone is not an accessible label.
- Use `ActionCard` for repeated product actions that need an icon, title, and description. Choose its fixed horizontal or vertical layout instead of recreating card markup in a feature module.
- Use `ConfirmDialog` for confirmation so focus lock, Escape handling, Portal rendering, and focus return stay consistent. It is destructive by default; pass `destructive={false}` only for a non-destructive choice such as opening an external download page.
- Use `InlineMenuSurface` with `InlineMenuItem` for coordinate-sensitive Tauri menus; the feature supplies only placement and width.
- Use `StatusToast` for transient status with an optional action, `OperationStatus` for persistent working/success/error feedback, and `ToolbarIconButton` for named icon-only toolbar actions.
- Auxiliary webviews use MUI controls inside their existing CSS Module window shells. Keep `--ui-radius-window`, `--ui-window-shadow`, transparent gutters, and Tauri-owned placement intact instead of replacing the whole shell with a portal or generic page card.
- Use native buttons only for custom surfaces such as clipboard cards; they still need a visible focus state, a minimum 24×24 px target, disabled styling, and an accessible name.
- Use semantic status components or text as well as color for success, warning, and error states.

Use this decision table before adding a control:

| Need | Preferred implementation | Exception |
| --- | --- | --- |
| Standard action or icon action | MUI `Button`, `IconButton`, or `ButtonBase` | Native window controls and product-specific interactive surfaces may remain semantic native elements |
| Repeated descriptive action card | Shared `ActionCard`, built on MUI `ButtonBase` | Use a normal MUI button when title and description are not both needed |
| Text, selection, toggle | MUI `TextField`, `Select`, `Switch`, `Tabs` | None without a documented platform constraint |
| Modal confirmation | Shared `ConfirmDialog`, built on MUI `Dialog` | None; keep focus lock, Escape, Portal, and focus return |
| Coordinate-sensitive desktop menu | Shared `InlineMenuSurface` and `InlineMenuItem` with feature-owned coordinates | Full MUI `Menu` only when its Portal cannot change Tauri coordinates |
| Transient status with one optional action | Shared `StatusToast` | Persistent form errors stay next to the affected control |
| Persistent operation progress or result | Shared `OperationStatus` | Use `compact` inline feedback or `block` feedback with optional MUI progress |
| Icon-only toolbar action | Shared `ToolbarIconButton` with its required `label` | Product-specific drag handles may stay native |
| Auxiliary-window fields and actions | MUI `TextField`, `Select`, `Button`, `ButtonBase`, and `MenuItem` | Keep the feature CSS Module only for layout, transparent-window geometry, and branded surfaces |
| Repeated product pattern | A semantic shared component in `src/ui/` after the second consumer exists | Do not create wrappers for one use |

The temporary raw-control inventory is stored in `scripts/ui-governance-baseline.json`. New raw `button`, `input`, or `select` elements fail `npm run check:styles`. When a module migrates to MUI, reduce its baseline entry in the same pull request; never increase the baseline to make a new control pass.

The remaining native controls are deliberate special surfaces: `Config.tsx` owns the platform-shaped title-bar buttons, while `PasteQueue.tsx` owns its drag handle and full-row paste target. They keep native button semantics because MUI wrappers would add no accessibility benefit and could interfere with native window or pointer-drag behavior. Everything else, including development-only tools, uses MUI controls.

## Motion Ownership

Motion is added deliberately after component structure is stable. Use one animation owner per element:

| Change | Owner |
| --- | --- |
| Color, background, border, focus, MUI Switch internals | MUI theme or CSS Modules |
| Conditional mount/unmount, small state transitions, layout continuity | Shared exports from `src/ui/motion/` |
| Native window position, size, show, and hide | Tauri/Rust |
| Active pointer drag transform | Existing drag implementation until a separately benchmarked migration |

Business modules must not import `motion`, `motion/react`, `motion/react-m`, or `framer-motion` directly. They use the shared `src/ui/motion` entry and its named presets. `framer-motion` must never be a direct dependency. Every `AnimatePresence` declares its `mode`, and business components do not invent duration, easing, spring, or distance values.

The approved timing scale is 120 / 180 / 240 / 320 ms, with 6 / 10 / 16 px distances. Only `transform` and `opacity` should normally animate. Keep the existing Tauri main-window slide as the sole owner of whole-window movement. In reduced-motion mode, remove translation, scale, and springs; retain only a short fade when it conveys state.

The root uses strict asynchronous `LazyMotion` with `domMax` and `MotionConfig reducedMotion="user"`. Render animated DOM through the shared `m` export and choose only the named presets in `src/ui/motion/presets.ts`: the base `fade`, `popover`, `toast`, `panel`, `listItem`, `stateIndicator`, `preview`, and `selectionIndicator` presets plus the bounded `panelForward`, `panelBackward`, `gridItem`, `shortcutHint`, `submenuLeft`, and `submenuRight` spatial variants. Positioning wrappers keep fixed/absolute coordinates in CSS while an inner Motion element owns animated transforms. MUI Dialog and Switch keep their mature MUI transitions, with duration values synchronized from the shared Motion tokens.

Clipboard search and tab filtering use one deterministic result-batch motion instead of old-position FLIP. The accepted search/tab request keys the complete result surface, and its outer `AnimatePresence mode="wait"` finishes the old surface fade before mounting the new results; old and new cards must never overlap. Each new result card then runs scoped `useAnimate` on its dedicated filter wrapper after that wrapper mounts, moving from the 16px emphasis distance back to rest with the shared tight stagger and gentle spring. This per-card lifecycle is required because older matches can be fetched and mounted only after filtering, while recent matches may already have been present in the prior surface. The stagger repeats in groups of 12 so all loaded results participate without making later cards wait through an increasingly long sequence. Separate wrappers own ordinary grid entry/exit and filter motion, while the inner card keeps hover and native file-drag behavior; the result container never receives Motion transforms. Search expansion remains a short CSS width transition. Search keeps stale results visually masked, pointer-blocked, and hidden from accessibility APIs until the accepted backend response arrives. Re-run the 36-card benchmark after changing this path and remove the batch motion if median or p95 interaction time regresses by more than 10% on the same machine.

During onboarding, ordinary focus loss and navigation continue to block main-window hiding. Only the final shortcut step may temporarily enable the Rust-owned global-shortcut demo so the configured main shortcut can hide and show the real clipboard window; leaving that step or completing onboarding disables the exception.

Small binary state feedback—favorite markers, queue-selection markers and counts, and permission-result labels—uses `stateIndicator`. Preview content uses `preview` with the locally requested keyboard navigation direction and `AnimatePresence mode="wait"`; it never changes the preview window geometry. Both presets reduce to opacity-only transitions when reduced motion is active. A tightly scoped icon/text status replacement may use `mode="sync"` when both layers stay inside the same fixed-size status container and cannot affect surrounding layout.

External clipboard-card drag is platform-aware. Text, links, colors, and other non-file values use the browser/webview drag channel with `effectAllowed="copy"` and standard `text/plain`, `text/html`, `text/uri-list`, and internal metadata. File- and image-backed cards use the Tauri `native_drag_file` command on Windows and macOS. Windows binds every canonical local path into one Shell item array and lets `SHDoDragDrop` provide the native OLE cursor and target negotiation. macOS passes the complete path list to one AppKit `NSDraggingSession` through the target-specific `drag` dependency and schedules session creation on the application main thread. All its native drag cursors, including images, regular files, folders, and multi-file cards, snapshot the same 132×138 miniature clipboard card used by browser drags, preserving the header, timestamp, app icon, image content, and active theme. The rendered copy is captured through WKWebView on the AppKit main thread with Retina logical dimensions preserved, then removed before the native session starts. Native PNG export clips to the miniature's actual CSS corner radius on a transparent bitmap so the snapshot backdrop cannot turn its corners square; the browser miniature uses the source card's scaled surface radius. Releasing the mouse anywhere, losing focus, starting another gesture, or unmounting during capture cancels the pending preview and prevents a late native session. Snapshot failure retains the source-thumbnail fallback, bounded to 128 logical pixels with aspect ratio and transparency preserved; GIFs use a static cursor preview while the dropped file remains a GIF. Single image files use the same card path and fallback, including SVG rasterization with bounded linked and embedded image resources. After a snapshot failure, the existing app icon remains the fallback for ordinary files, multiple files, or images outside the automatic preview budget. Image history is materialized as a real PNG or GIF in the existing bounded image cache before either native drag begins; file history keeps the original validated local paths. Other platforms retain the browser path. No implementation installs a global mouse hook or mutates clipboard history, configuration, or database state. Multi-select mode disables external drag, interactive descendants cancel drag initiation, and the source card remains in the grid with reduced opacity while the native or browser drag is active. Browser `dragend` and the native result both show the success marker only for an accepted drop; canceled or rejected drags simply restore the source card. Browser and macOS native drag previews share `createClipboardDragPreview` for every item type; item types determine transferred data and the card's existing content presentation, without separate drag-preview renderers. Long-text browser drags retain prepared full text for the current mouse gesture even if the pointer leaves the card before `dragstart`; release, focus loss, and unmount discard that gesture data, and unavailable full text still blocks dragging a truncated preview. Browser drag previews reuse a scaled copy of the rendered clipboard card, including its content and loaded images, instead of a generic type/Dragging badge. The temporary copy is inert, hidden from accessibility APIs, excludes selection and shortcut feedback, and is removed after the browser captures it.

The legacy CSS and Web Animations API declarations are frozen in `scripts/ui-governance-baseline.json`. Token-based declarations are not baseline exceptions. Each migration must reduce the baseline, and the tutorial remains the final Web Animations API migration.

## Interaction State Contract

Every shared control must define and test the states that are relevant to it. A default-state screenshot alone is not sufficient.

| Component | Required visual states | Required behavior |
| --- | --- | --- |
| Button | default, hover, keyboard focus, disabled, destructive, loading | Enter/Space activation; loading and disabled controls cannot trigger duplicate actions |
| ActionCard | horizontal, vertical, hover, keyboard focus, disabled, light/dark | Entire surface has one button role; Enter/Space activates it; disabled cards do not invoke actions |
| TextField | default, keyboard focus, error with text guidance, read-only, disabled | visible label; errors use `aria-invalid` and associated helper text |
| Select/Menu | default, open, selected, hover, keyboard focus, disabled, long value, long list | Arrow-key selection; Escape closes; focus returns to the trigger; long menus scroll to their final item |
| Switch/Checkbox | on/off or checked/unchecked, keyboard focus, disabled | associated label; Space toggles; the interactive target is at least 24×24 px |
| Tabs | selected, hover, keyboard focus, disabled | arrow keys move between enabled tabs and update the selected panel |
| Dialog | open and action states | focus is contained while open; Escape closes; focus returns to the trigger |
| Tooltip | pointer hover and keyboard focus | supplemental text only; essential information must remain available without the tooltip |
| Progress | determinate and indeterminate | an accessible name describes the operation; status is not communicated by animation alone |

Use a single focus indicator per component. MUI controls use the shared theme focus ring; native controls use the global `:focus-visible` outline. Menu items use a clearly differentiated focus background because an outer ring is clipped by the menu surface.

## Themes and Density

The supported modes are `system`, `light`, and `dark`. Existing `data-theme` behavior must remain compatible. The default density is compact without becoming difficult to click:

- regular controls: 32 px
- compact controls: 28 px
- settings rows: at least 52 px
- control radius: 8 px
- popover/menu radius: 10 px
- surface radius: 14 px
- spacing scale: 4 / 8 / 12 / 16 / 24 px

All motion must respect `prefers-reduced-motion`. Icon-only buttons require an `aria-label`. Keyboard focus must remain visible.

Transparent auxiliary Tauri windows must keep `html`, `body`, and `#root` transparent. Disable the native window shadow when the window surface draws its own rounded border or shadow; otherwise Windows can add a rectangular non-client border around the CSS surface. Settings, tray, emoji, tag-editor, and notice surfaces use an 8px transparent gutter around one CSS-owned 12px radius, one-pixel edge, and narrow window shadow. Keep platform tray roles separate: Windows colors the approved tray SVG mask with the logo gradient's `#0B86FF` middle stop, Linux uses the shared UI accent, and macOS installs the same mask as a monochrome template image. The runtime mask centers the approved tray SVG at `1.1×` scale without modifying the source file.

## Development and Review

Run `npm run dev:debug`, then use the component-lab button beside Settings to open the inventory in the system browser. The direct development URL remains `/__ui-lab`. It is the reference for component dimensions and interaction states in Chinese and English, light and dark themes. The route does not exist in production builds. The settings-only preview at `/__settings-preview` uses an in-memory bridge so screenshots do not require Tauri.

Before opening a UI pull request:

```powershell
npm run check:ui
```

The full command includes Playwright visual tests and is intended for local review. Hosted GitHub Actions quota is not used for this UI workstream. Run the checks locally, inspect the screenshots manually, and record the results in the pull request for the maintainer to verify.

Screenshot changes are review artifacts, not automatic updates. Regenerate them with `npm run test:visual:update`, inspect every changed image, and commit only intentional changes.

For Motion-related changes, also verify normal and reduced-motion behavior directly. Wait for exit animations before taking screenshots; screenshots do not replace behavior tests for callbacks, focus return, or reduced-motion selection. Performance comparisons for 36 clipboard cards and 100 Paste Queue rows are local-only evidence and are never a hosted CI gate.

Do not combine a React or MUI major-version upgrade with visual migration work. Do not edit Windows installer files as part of frontend UI work.
