# vPaste icon sources

| Source | Intended fill and background | Use |
| --- | --- | --- |
| `vpaste-app-icon-1024.png` | Blue background with a white mark; exactly `1024×1024` | Primary application icon and branded surfaces that need the complete app icon |
| `../../../src/assets/vpaste-logo-master.svg` | Blue gradient mark on a transparent background | Brand marks displayed without an icon background |
| `vpaste-tray.svg` | Monochrome `currentColor` mark on a transparent background | Tray and status icons that need light/dark color variants |

Approved source fingerprints:

- `vpaste-app-icon-1024.png`: `9a1ab9280e1d45032b20257b11dcc41e6e300c54982445cec80c0888fb00b9d8`
- `vpaste-logo-master.svg`: `21c01d4a93ee88837d0d5c43735ec1e294cac887b40bbdb62bd3dd801236fb48`
- `vpaste-tray.svg`: `363ec8c8c48609879d2fd35d1c15285896c9177146fe5239c73a17a3e800040e`

Generated bundle assets keep these roles separate:

- `icon.*` bundle files are generated from `vpaste-app-icon-1024.png`; frontend branded surfaces and the favicon import the same source directly.
- The build script rasterizes `vpaste-tray.svg` as a centered `1.1×` alpha mask. Windows and Linux color that mask with the vPaste accent.
- On macOS, the same mask is installed as a native template image, so macOS automatically renders it black or white for the current menu bar appearance.
- Do not add separate tray PNG sources or duplicate frontend app-icon PNGs.
