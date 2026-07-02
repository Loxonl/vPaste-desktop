# Language Packs

vPaste has built-in `Chinese` and `English` language packs. Runtime language packs can be added without code changes by placing JSON files in the app runtime language directory:

```text
<app-runtime-dir>/lang/*.json
```

The app scans this folder when a window loads. Invalid JSON files are skipped and logged, so one bad language file will not block the built-in languages. Older installs may have had `lang` under the history directory; the app migrates runtime language files out of history storage.

## JSON Format

```json
{
  "code": "ja-JP",
  "name": "Japanese",
  "nativeName": "日本語",
  "translations": {
    "common.search": "検索",
    "settings.tabs.general": "一般"
  }
}
```

`code` is stored in config and must stay stable. `nativeName` is shown in Settings. Missing translation keys fall back to the built-in Chinese pack.

## Built-In Files

Built-in packs live in:

```text
src/lang/locales/
```

Shared typing and loading logic live in:

```text
src/lang/
```
