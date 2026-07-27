# Frontend UI Guidelines

vPaste uses React 18 and MUI 5 as its component system. Tailwind is intentionally not part of the stack. The desktop windows share one compact cross-platform visual language; platform differences are limited to behavior that must follow the operating system, such as title-bar controls.

## Where Styles Belong

- Put semantic color, spacing, radius, shadow, control-height, and focus tokens in `src/ui/tokens.css`.
- Put MUI component defaults and state styling in `src/ui/appTheme.ts`.
- Put reusable React UI in `src/ui/`.
- Put window or feature layout in a colocated `*.module.css` file.
- Keep `src/theme.css` limited to token loading, root behavior, theme synchronization support, focus visibility, and reduced-motion protection.
- Do not target `.Mui...` from page styles. If a MUI control needs a shared visual change, update the theme.

Use `sx` only for a one-off layout relationship such as flex sizing, alignment, or a calculated width. Do not put colors, font sizes, radii, shadows, or control heights in `sx`.

## Choosing Components

- Use MUI for interactive controls such as buttons, selects, text fields, switches, tabs, menus, dialogs, and progress indicators.
- Use the shared settings primitives for conventional label/description/control rows.
- Use native buttons only for custom surfaces such as clipboard cards; they still need a visible focus state, a minimum 24×24 px target, disabled styling, and an accessible name.
- Use semantic status components or text as well as color for success, warning, and error states.

## Themes and Density

The supported modes are `system`, `light`, and `dark`. Existing `data-theme` behavior must remain compatible. The default density is compact without becoming difficult to click:

- regular controls: 32 px
- compact controls: 28 px
- settings rows: at least 52 px
- control radius: 8 px
- surface radius: 14 px
- spacing scale: 4 / 8 / 12 / 16 / 24 px

All motion must respect `prefers-reduced-motion`. Icon-only buttons require an `aria-label`. Keyboard focus must remain visible.

## Development and Review

Run the component inventory in development at `/__ui-lab`. The route does not exist in production builds. The settings-only preview at `/__settings-preview` uses an in-memory bridge so screenshots do not require Tauri.

Before opening a UI pull request:

```powershell
npm run check:ui
```

Screenshot changes are review artifacts, not automatic updates. Regenerate them with `npm run test:visual:update`, inspect every changed image, and commit only intentional changes.

Do not combine a React or MUI major-version upgrade with visual migration work. Do not edit Windows installer files as part of frontend UI work.
