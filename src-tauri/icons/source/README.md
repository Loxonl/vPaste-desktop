# vPaste icon sources

| Source | Intended fill and background | Use |
| --- | --- | --- |
| `vpaste-app-icon-1024.png` | Blue background with a white mark | Primary application icon and branded surfaces that need the complete app icon |
| `../../../src/assets/vpaste-logo-master.svg` | Blue gradient mark on a transparent background | Brand marks displayed without an icon background |
| `vpaste-tray.svg` | Monochrome `currentColor` mark on a transparent background | Tray and status icons that need light/dark color variants |

Generated bundle assets keep these roles separate:

- `icon.*` bundle files are generated from `vpaste-app-icon-1024.png`; frontend branded surfaces and the favicon import the same source directly.
- The build script rasterizes `vpaste-tray.svg` as an alpha mask. Windows and Linux color that mask with the vPaste accent.
- On macOS, the same mask is installed as a native template image, so macOS automatically renders it black or white for the current menu bar appearance.
- Do not add separate tray PNG sources or duplicate frontend app-icon PNGs.
