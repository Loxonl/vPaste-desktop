# Office regression profiles

The single scenario catalog is [catalog.json](../../../tests/fixtures/office/catalog.json).
It supplies Test Room case IDs, synthetic payloads, expected image counts, manual
steps, and the names of maintained regressions. Windows native replay and Debug
history preparation use the same images and HTML as the browser checks. The
catalog's `automatedTests` references are checked by the ordinary unit suite.

## Choose the relevant checks

| Work | Verification |
| --- | --- |
| Unrelated change | Existing repository checks; no additional Office profile |
| Capture, format, deduplication, restore, or queue change | `npm run test:office` on the affected platform; the existing PR workflow also runs Rust on Windows and macOS |
| Clipboard card or rich preview change | `npm run test:office:ui` for focused development; existing full UI checks before a UI PR |
| Package build | The Windows, macOS DMG, and Mac App Store entry points automatically check that Office fixtures are absent from the built frontend and native executable |
| Release candidate | Relevant automated evidence for the reviewed source, then the real-Office smoke test below against the final installed package |

`test:office` runs existing clipboard and queue suites, the shared catalog/history
round trip, document privacy checks, and relevant frontend unit tests. Its UI
counterpart verifies real PNG decoding, source identity, picture/icon dimensions,
light/dark cards, and Test Room result states. Both commands write complete logs
and a compact `result.json` under the system temporary directory. Results include
the source commit, dirty flag, catalog hash, platform, commands, exit codes and
elapsed time. A dirty flag requires checking the actual source contents before
reusing evidence; a matching commit alone does not identify uncommitted edits.
Only failure excerpts are printed. Do not attach private machine logs to a PR.

These profiles do not launch Microsoft Office. Native Windows replay uses an
isolated child-process window station, not the user's clipboard. macOS runs shared
and platform policy tests; actual Office pasteboard capture still needs a local
manual check. A successful browser test does not establish native capture or
external paste success. Normal Cargo tests also omit `#[ignore]` interactive tests.

## Scenarios

| Case | Main risk / expected observation |
| --- | --- |
| TC-WORD-01 | Bold, source color and highlight survive capture, display and restore |
| TC-WORD-02 | Image-only margin-selected rows remain visible and pasteable |
| TC-WORD-03 | Two pictures retain order/size without VML duplication; small icons stay small |
| TC-WORD-04 | A valid image larger than 256 KiB remains decodable within existing image limits |
| TC-WORD-05 | Consecutive different pictures remain distinct after closing the source and reopening/restarting vPaste |
| TC-EXCEL-01 | Table, actual Excel chart object, and embedded picture capture/preview/restore |
| TC-EXCEL-02 | Values, colors, borders and merged title within supported HTML/RTF behavior |
| TC-EXCEL-03 | Blank selection does not create an erroneous bitmap; the next valid copy works |
| TC-EXCEL-04 | Delayed rendering, sequence drift and missing notification recover without a second copy |
| TC-EXCEL-05 | Table/image captures agree between history and queue; paste consumes once and undo works |

Test Room preparation writes inspectable history for seven scenarios. The three
native/manual scenarios only show their instructions. All Office scenarios and
external drag/target checks start as **prepared / awaiting manual confirmation**;
they never become automatic passes merely because preparation succeeded. A tester
may mark a manual pass/failure; rerunning clears that verdict. Existing generated
history remains under the global Test Room cleanup contract. No screenshot-only
or database-only check can confirm a real Office operation.

## Synthetic documents and privacy

[vPaste-Office.docx](../../../tests/fixtures/office/vPaste-Office.docx) contains
labelled Word sections; [vPaste-Office.xlsx](../../../tests/fixtures/office/vPaste-Office.xlsx)
contains a formatted table (`Samples!A1:C4`), a merged title (`A6:C6`), an actual
chart (`E5`), a picture (`A8`), an unformatted blank area (`F1:H3`), and a Guide sheet.
The Debug Test Room **Office 测试素材** button copies these documents into its
own App Data fixture folder and opens that folder using the existing platform
handler. It does not read clipboard history or launch Office automatically.
Actual manual copies replace the current system clipboard; use only these sample
documents and close personal documents before taking screenshots.

Everything was generated from fictional product labels, numbers, and colored or
seeded-noise images. Documents have fixed synthetic author metadata and no macros,
comments, tracked changes, custom XML, hidden sheets, external relationships or
machine-local paths. Tests inspect the OOXML ZIPs and decode every PNG. No private
clipboard snapshots, databases, or diagnostic payloads are fixtures.

To regenerate, use Python with `python-docx`, `openpyxl` and `Pillow` available:

```sh
python scripts/generate-office-fixtures.py
```

These are authoring tools only; the application and ordinary tests require no new
Python packages. Generated ZIP timestamps and metadata are normalized. Review
regenerated documents and rerun `npm run test:office` after changing them.

Office assets are compiled into Rust only under `cfg(test)` or `debug_assertions`,
and their frontend consumer is behind the existing development-only route. They
are not Tauri bundle resources. For an explicit local artifact check, build first:

```sh
npm run check:office:release -- --binary <path-to-built-release-executable>
```

## Final-package smoke test

Install the candidate package, then run TC-WORD-02/03/05 and TC-EXCEL-01/04/05 on
Windows and macOS with real Office. Follow the catalog steps and paste into the
real target application. Check image identity/count, formatted content, one-copy
capture, queue order/consumption, and cold reopen. Test Room is Debug-only, so use
the same repository documents and this checklist for Release. Unavailable Office
or a platform not tested must be recorded as **not run**, not passed.

Retain a local record with: package version and SHA-256, source commit, OS and
Office versions, case IDs, automatic/manual outcome, duration and any failure.
Only safe sample screenshots and concise results belong in public PR/release
notes. Reuse valid source-level evidence where inputs are unchanged; the actual
installed package smoke test still belongs to the candidate being promoted.

## Initial local verification (Windows, 2026-10-23)

- Office logic and all three focused browser tests passed. The final native
  suite passed 316 tests with one existing interactive test ignored; frontend
  units passed 495 tests.
- Initial browser verification found two stale Settings expectations: the old
  About screenshot and seven shortcut rows instead of eight after F2 was added.
  The About baseline was reviewed and updated; explicit checks now cover F2,
  the Star prompt, and all three resource links. No alignment checks or pixel
  tolerances were weakened. Final `npm run check:ui` passed all 495 unit tests and
  155 browser tests. The maintainer also confirmed the updated Windows Debug
  Test Room behaves as intended after rebuilding and restarting its native host.
- The catalog and generated assets total 644,911 bytes in the repository.
  Release isolation passed for the built frontend and Windows executable.
  The same-command Release EXE comparison was 25,820,672 bytes before versus
  25,816,064 after; this is not an installer-size measurement.
- Native test execution was 25.12 seconds before versus 28.66 after in single
  local observations. The focused browser profile took 18.27 seconds. These are
  not stable performance estimates; no AI-token percentage was measured.
- macOS native execution and real Word/Excel smoke tests were not run on this
  Windows host. No hosted Actions were dispatched.
