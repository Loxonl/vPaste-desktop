# vPaste history archive converter

This is a temporary, standalone migration tool. It does not modify the v2 archive.

On Windows, drag the exported v2 `.vphistory` file onto
`vpaste-history-converter.exe`. You can also run it from a terminal:

```sh
vpaste-history-converter vpaste-history.vphistory
```

The converter writes `vpaste-history.v3.vphistory` beside the input. It never
overwrites the input or an existing output. The v3 archive is plaintext; store
it securely, then import it manually from vPaste's data settings.
