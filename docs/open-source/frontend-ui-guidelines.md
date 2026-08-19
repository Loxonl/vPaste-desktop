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

Use `sx` only for a one-off layout relationship such as flex sizing, alignment, or a calculated width. Do not put colors, font sizes, radii, shadows, or control heights in `sx`.

## Choosing Components

- Use MUI for interactive controls such as buttons, selects, text fields, switches, tabs, menus, dialogs, and progress indicators.
- Use the shared settings primitives for conventional label/description/control rows.
- Use `ActionCard` for repeated product actions that need an icon, title, and description. Choose its fixed horizontal or vertical layout instead of recreating card markup in a feature module.
- Use `ConfirmDialog` for destructive confirmation so focus lock, Escape handling, Portal rendering, and focus return stay consistent.
- Use `InlineMenuSurface` with `InlineMenuItem` for coordinate-sensitive Tauri menus; the feature supplies only placement and width.
- Use `StatusToast` for transient status with an optional action, and `ToolbarIconButton` for named icon-only toolbar actions.
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
| Icon-only toolbar action | Shared `ToolbarIconButton` with its required `label` | Product-specific drag handles may stay native |
| Auxiliary-window fields and actions | MUI `TextField`, `Select`, `Button`, `ButtonBase`, and `MenuItem` | Keep the feature CSS Module only for layout, transparent-window geometry, and branded surfaces |
| Repeated product pattern | A semantic shared component in `src/ui/` after the second consumer exists | Do not create wrappers for one use |

The temporary raw-control inventory is stored in `scripts/ui-governance-baseline.json`. New raw `button`, `input`, or `select` elements fail `npm run check:styles`. When a module migrates to MUI, reduce its baseline entry in the same pull request; never increase the baseline to make a new control pass.

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
