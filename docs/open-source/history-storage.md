# History storage compatibility

The supported baseline is the plaintext history layout shipped in v1.6.0.
The database remains `vpaste.db`; history archives remain plaintext v3
`.vphistory` files. Existing supported history does not need to be exported,
reset, or moved.

SQLite `user_version=1` marks this supported layout. Existing unmarked
databases are checked against the current tables, indexes, and plaintext
payloads before being marked. This is format validation, not payload conversion;
it never recursively scans attachments or repairs old data. Marked databases
do not scan history payloads at startup. Newer unknown markers are rejected.

## Acceptance criteria

- A new installation creates the current tables and unique hash index.
- Reopening a supported database preserves history, favorites, tags, queue
  payloads, attachments, and its schema without rebuilding indexes.
- Unsupported databases are rejected without repairing, deleting, or
  overwriting their records. Existing supported databases without a format
  marker are recognized before the current marker is recorded.
- Unsupported archive versions and database layouts are rejected before
  copying attachments or changing the destination history.
- Settings retain storage selection, cleanup, import/export, and shortcut
  conflict feedback, without legacy migration or destructive reset controls.
- Historical converters and old-layout migration steps are not maintained
  or built for new releases. Existing Git history and release assets are
  unaffected.

Normal history transfers still merge records and tags, preserve external file
paths, and relocate managed attachments. This compatibility cutoff does not
disable previously installed app versions or remove future schema upgrades
from the supported baseline.
