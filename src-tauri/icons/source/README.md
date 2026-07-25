# vPaste icon sources

| Source | Intended fill and background | Use |
| --- | --- | --- |
| `vpaste-app-icon-1024.png` | Blue background with a white mark | Primary application icon and branded surfaces that need the complete app icon |
| `../../../src/assets/vpaste-logo-master.svg` | Blue gradient mark on a transparent background | Brand marks displayed without an icon background |
| `vpaste-tray.svg` | Monochrome `currentColor` mark on a transparent background | Tray and status icons that need light/dark color variants |

Generated runtime assets keep these roles separate:

- `icon.*`, the favicon, and the frontend app-icon PNG use the primary application-icon style.
- On macOS, `tray-icon-light.png` is installed as a native template image, so macOS automatically renders it black or white for the current menu bar appearance.
- On Linux, `tray-icon-light.png` and `tray-icon-dark.png` provide explicit black and white theme variants.
- `tray-icon.png` preserves the existing Windows tray artwork and behavior.
