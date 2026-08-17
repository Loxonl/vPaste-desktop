# vPaste history archive converter

Close vPaste, export a `.vphistory` archive with the old encrypted release, then run:

```sh
vpaste-history-converter vpaste-history.vphistory
```

The converter writes `vpaste-history.v3.vphistory` beside the input. It never overwrites the input or an existing output. The v3 archive is plaintext; store it securely and import it with the new vPaste release.
