# Windows native preview follow-up

## Acceptance criteria

- In the opt-in Windows WinUI mode, plain text, bounded text-file content, images,
  colors and ordinary file information use a native XAML reader. Reuse the Rust
  history/media/text budgets and source-monitor geometry. No main or preview
  WebView may be created for these native routes.
- Keep the existing renderer for rich HTML, live webpages, PDF and OCR reading
  until their complete behavior is migrated. Choosing a native route must not
  silently discard rich formatting, live webpage navigation or PDF/OCR features.
- Reuse one native HWND and XAML island across selections. Commit images only
  after loading or a visible error. New requests/close/hide must invalidate old
  work. Clear decoded media on real closure. Retarget size/position from the
  current rectangle, using the shared motion parameters; honor Windows reduced
  motion. Do not animate the main dock or change its layout.
- Preserve manual versus hover focus, Space-repeat suppression, Escape, arrows,
  Tab and Ctrl+Tab navigation, text selection/copy, pinning and focus return.
  Moving into/out of a hover reader must use the existing hover controller.
- Keep settings on demand, the validated queue/drag/tag behavior, macOS UI,
  storage/commands, installers and hosted workflows unchanged. Verify native
  controls and stale/error paths locally; consolidate physical checks at the end.

## Implemented slice

| Content | Renderer |
| --- | --- |
| Plain text and stored long text | Native selectable text using the existing 256 KiB preview budget and truncation notice |
| Images | Native image control using approved local media assets, bounded decode size and readiness/error callbacks |
| Colors | Native color surface using the existing Rust color parser |
| Text/image files and ordinary file lists | Native bounded text, image/caption/path or file information |
| Rich HTML, live links, PDF and OCR | Existing on-demand auxiliary renderer, with its formatting and reading behavior retained |

The native routes lazily create one HWND/XAML island on the existing WinUI STA.
Navigation reuses it, retains the displayed content until its replacement is
ready, and retargets geometry from the actual current rectangle. A new request
stops the previous movement. Real closure stops timers and drops the displayed
and pending controls/media. Stale loads, closed generations and delayed failures
cannot replace the current content or reopen the reader.

The unchanged motion values now live in `src/ui/motion/tokens.json`, consumed by
both React and the native reader. Windows' animation preference controls native
geometry movement. React still uses its existing presets and reduced-motion
policy; no native library or second animation package was added to React.

Native activation, blur, cursor containment, pinning and keyboard requests use
the existing Rust preview policies. A hover result is checked again after
preparation and before native commit. Renderer handoffs transfer focus when the
outgoing reader held it; retiring an old reader does not cancel a newer request.
Native callbacks queue Tauri UI work instead of waiting for its event loop.

The shared renderer remains loaded on demand for unsupported/rich routes. Once
that renderer has been used, its existing retained-window lifetime remains in
effect. This is a migration of common preview content, not a claim that all
auxiliary WebViews have been removed. Settings remains React/MUI and is still
destroyed on close. The main dock, queue and tag changes approved in stages 1–3
remain in the worktree.

## Local verification — 2026-11-13

- Style architecture, TypeScript/Vite production build and production asset
  isolation passed. Production output used an ignored separate directory so
  the native Debug assets were not replaced.
- All 80 selected frontend unit cases passed, including Motion/reduced-motion,
  preview continuity, deferred files, hover behavior and the WinUI build contract.
- All 58 selected Rust/WinUI cases passed. The real XAML regression reached
  stage 125. It exercises selectable native text, HWND reuse, keyboard/repeat/IME
  routing, pin/close automation, live theme resources, missing and successful
  images (including Unicode and URI-sensitive filenames), stale generations,
  media-control release, interrupted geometry, disabled animations, hidden-owner
  hover rejection and native blur notification. The real-history payload test
  uses an isolated temporary database and checks long-text budgets, file images,
  multiple paths, PDF/link fallback and missing records. A close-order regression
  first failed against the old adapter, then passed with the shared close path:
  the real reader's `WM_CLOSE` cancels hover before reserving the explicit close,
  so the hover dismissal cannot supersede keyboard focus return to the dock.
- All 92 selected shared Rust preview cases passed; one pre-existing isolated
  memory probe remained ignored. These overlap with some WinUI cases and are
  not an additional count of unique tests.
- All 24 local browser cases passed for mouse/hover preview and the resident
  reader, including normal/reduced-motion behavior. Platform mocks do not prove
  native macOS behavior. No hosted Actions were added or dispatched.
- The default Windows build check without `winui-debug` passed. Rebuilt the
  native Debug frontend and executable with asset-isolation checks, then restarted
  using `--dev-mode --main-ui=winui`. Verified a responding executable from this
  worktree, the matching loaded WinUI DLL and no child processes with auxiliary
  windows closed. This idle check is not acceptance of every window lifecycle.
- Inspected native Chinese/light and English/dark reader captures. The initial
  native-route test failed before implementation. Evidence and synthetic PNGs
  are in the ignored `src-tauri/tmp/winui-native-reader-20261113/` directory.

Windows denied foreground activation to the synthetic test host. Posted Space
and foreground-dependent queue assertions explicitly skipped. XAML captures
exclude DWM and native backdrop composition. Physical focus transfer, real
keyboard/IME behavior, Windows 10, 100/150/200% scaling, mixed-monitor movement
and native macOS execution remain manual. These focused checks do not resolve
the previously documented isolated-clipboard desktop environment limitation.

## Consolidated manual review

1. Press Space on text, long text, images, colors and files. Navigate rapidly
   with arrows/Tab and Ctrl+Tab, including between differently sized images.
   The common reader should remain open and move/resize continuously. Holding
   Space must not repeatedly toggle it. Select/copy some text, close with
   Escape/the close button, and check that the main panel can receive input.
2. Enable hover preview, cross between a card and its reader, then leave both.
   Change selections while content loads, dismiss it and activate another app.
   No stale reader may reopen. Pin/unpin the reader and hide/show the main dock;
   a pinned reader should keep the established behavior.
3. Mix native items with rich HTML, links, PDF and OCR. Check both renderer
   handoff directions and the existing reading/editing/copy behavior. Check
   English/Chinese, light/dark, Windows reduced motion and the physical display
   scales in use. The settings lifecycle and native main-window layout should
   remain unchanged.
