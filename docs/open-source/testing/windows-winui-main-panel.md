# Windows WinUI 3 main-panel MVP

The Windows-only Debug experiment builds a WinUI 3 XAML Island window while
keeping clipboard capture, history storage, the tray icon, hotkey handling, and
clipboard actions in the existing Rust/Tauri process. It is the first real-data
vertical slice of the future Windows main panel, not a feature-complete
replacement yet.

## Requirements and launch

- Windows x64.
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload,
  MSVC v143, Windows 10 SDK 10.0.22000 or newer, and MSBuild available to
  `vswhere.exe`.
- The Windows App SDK runtime compatible with the pinned WinUI package.
- Node 24, npm 11, and Rust toolchain required by the regular Debug build.

Close any running vPaste instance first. The standard single-instance behavior
is unchanged, so a second launch may otherwise be forwarded to the already-open
application instead of starting the selected experiment.

From the repository root, run:

```powershell
npm run dev:debug -- --main-ui=winui
```

This builds `vPaste.exe` with the `winui-debug` feature and launches it with
`--dev-mode --main-ui=winui`. The launcher skips Vite entirely for this mode.
The ordinary Windows DEV path remains:

```powershell
npm run dev:debug -- --main-ui=webview
```

If `--main-ui` is omitted, the existing WebView mode remains the default.

## Expected behavior

- The WinUI experiment window appears at startup.
- The main list reads actual records from the existing Rust clipboard-history
  query and shows up to 36 entries at a time as horizontally scrolling cards
  with type-colored headers, a content area, source, and favorite marker. Card
  details load on demand as cards enter the virtualized list: text/file/link
  details, tags, image thumbnails, and image dimensions come from existing Rust
  history and media-preview logic.
- Searching filters the Rust query; **All, Favorites, Text, Image, Link, Color,
  and File** switch between the existing history filters; the tag picker can be
  combined with search and content filters; **Load more / 加载更多** reads the
  next bounded page. Text includes text-file records, matching the existing
  main-panel filter behavior.
- Select an entry and choose **Copy / 复制** to write that saved item back to the
  system clipboard. **Paste / 粘贴** uses the existing Rust clipboard-copy,
  foreground restoration, permission check, and paste path. Enter pastes the
  selected item; Ctrl+C copies it. Include file and image entries in manual tests.
- Select an entry and choose **Add favorite / Remove favorite** (or the Chinese
  equivalent) to update its existing favorite state. The history list refreshes
  from Rust after the action.
- Right-click a card for **Copy / Paste / Favorite** actions. Clicking a card
  pastes according to the configured single-click or double-click paste mode;
  Enter and Ctrl+C continue to paste or copy the selected card.
- The card context menu also contains a **Tags** submenu. It offers each
  existing tag as an add/remove action for that item. **Manage tags / 管理标签**
  opens a native view where tag definitions can be created, renamed, and deleted.
- **Select for queue / 选择加入队列** enables multi-selection; add the selected
  items to the native paste queue. The queue supports paste, remove, move up/down,
  reverse, undo, and clear with confirmation. The queue shares the native panel
  and does not create the Tauri Paste Queue WebView.
- The panel follows the configured `system/light/dark` theme and English/Chinese
  language for the controls in this slice. Changing either preference while the
  panel is open should update it without restarting the app. Cards use explicit
  readable foreground/surface colors for both light and dark themes, including
  when the OS theme changes in `system` mode.
- Closing its title bar hides it; `Alt+V` and the tray show/toggle entry point
  can bring it back. They also restore the panel if it was minimized.
- The Rust clipboard listener and tray remain active.
- The WinUI mode does not create the main Tauri clipboard WebView or onboarding
  window, and does not start a Vite server.
- The native panel does not create a WebView2 control or the Tauri clipboard
  WebView. The C++/WinRT project still restores WebView2 metadata at build time
  because the Windows App SDK XAML metadata references that type; this does not
  start a WebView2 process at runtime.

To confirm WebView2 is absent, inspect the process tree rooted at this
experiment's `vPaste.exe`; unrelated WebView2 processes from Windows or other
applications are not evidence that vPaste created one.

The local-only native regression test initializes the actual Windows App SDK
and DLL bridge, shows the native shell, and exercises history refresh, single/
multi-selection transitions, non-empty queue updates, nullable undo state,
language/theme/error redraws, repeated view switching, and shutdown using
synthetic records. It does not query user history. Run it from
`src-tauri` on an interactive Windows desktop with the runtime installed:

```powershell
cargo test --bin vPaste --features winui-debug winui_panel::tests -- --include-ignored --test-threads=1
```

This does not start the clipboard service or a WebView. The test is ignored by
ordinary unit runs and is not added to GitHub Actions. Verify rendering and
history behavior manually as described above.

### Native control invariants

- Refreshing history uses `Items().Clear()`, which also resets selection. Do not
  additionally mutate `SelectedItems` in `Single` mode: WinUI rejects that with
  `0x8000FFFF`, leaving an empty list or terminating an uncaught event handler.
- When changing selection mode, clear selection using the **old actual mode**
  (`SelectedIndex(-1)` for single, `SelectedItems().Clear()` for multiple), then
  update the logical selection flag and `SelectionMode`. `SelectionChanged`
  runs synchronously, so the logical and control modes must stay consistent.
- Rust `Option` fields are JSON `null` when absent. `GetNamedString`'s default
  covers a missing key, not a present null; check the value type before reading
  `undoHash`. Keep the existing Rust state format unchanged.
- Release all XAML owners, including the queue and tag views, on their owning
  STA before closing the XAML manager and COM apartment.

After native changes, manually verify these real-app paths in addition to the
synthetic test: copy text in another app and see it appear in history; select
existing records and add them to the queue; copy again while the queue is active
and see its count increase. The queue remains temporary: closing it clears it,
and opening it does not import all history automatically.

## Interpreting memory readings

Compare the same metric after the same idle time on the same machine, and measure
the full `vPaste.exe` process tree. Exclude the Vite/Node process from the
WebView development run. This slice includes the primary native history list,
tag management, and a basic native Paste Queue, but does not yet represent
feature parity for rich-media interactions, drag-and-drop, settings, or all
auxiliary windows. The result is still not an apples-to-apples memory comparison
of equivalent UI functionality and is not a production memory claim.

Do not run the WebView and WinUI variants simultaneously: they would both
capture the system clipboard and distort memory readings. The normal data
directory behavior is unchanged in this MVP, so use an isolated Windows account
or a disposable checkout/profile if testing with user data is a concern.
