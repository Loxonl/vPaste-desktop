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
- Use native buttons only for custom surfaces such as clipboard cards; they still need a visible focus state, a minimum 24×24 px target, disabled styling, and an accessible name.
- Use semantic status components or text as well as color for success, warning, and error states.

## Interaction State Contract

Every shared control must define and test the states that are relevant to it. A default-state screenshot alone is not sufficient.

| Component | Required visual states | Required behavior |
| --- | --- | --- |
| Button | default, hover, keyboard focus, disabled, destructive, loading | Enter/Space activation; loading and disabled controls cannot trigger duplicate actions |
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

Screenshot changes are review artifacts, not automatic updates. Regenerate them with `npm run test:visual:update`, inspect every changed image, and commit only intentional changes.

Do not combine a React or MUI major-version upgrade with visual migration work. Do not edit Windows installer files as part of frontend UI work.
