# Citation plugins

Word and WPS clients for the NeoRead citation plugin. They only execute the
document operations NeoRead sends; formatting, dialogs and the library stay in
NeoRead. Design and protocol: `docs/research/word-plugin.md`.

- `wps/` — WPS 文字 JS add-in. NeoRead serves it from
  `http://127.0.0.1:17841/wps/<installation-key>/`, authenticated with a
  random key stored in the current user's configuration. The page exchanges
  that key at `/v1/cite/bootstrap` for a rotating runtime credential; HTML
  never embeds credentials. Existing installations need reinstalling once. `js/word-document.js` implements the operations on the Word
  object model and is tested against a fake model in `js/wps-client.test.mjs`.
  Online registration uses `jspluginonline` in WPS's `publish.xml`; restart WPS
  after replacing this registration. WPS can also load Word's startup template,
  so inspect `/wps/` resource requests and `/v1/cite/` command requests when
  diagnosing the JavaScript add-in.
- `word/` — Word template for Windows and macOS.
  - `NeoReadCite.bas`: the VBA module. Keep it ASCII; write Chinese messages as
    `T("\u....")` escapes, because Word reads modules in the system code page.
  - `customUI14.xml`: the ribbon.
  - `NeoReadCite.applescript`: the macOS transport (Word's VBA is sandboxed),
    installed as `~/Library/Application Scripts/com.microsoft.Word/NeoReadCite.scpt`.
  - `NeoRead.dotm`: the built template that NeoRead installs. It is a binary
    built with Word, not in CI.

## Building NeoRead.dotm

VBA must be compiled by Word, so the template is built on a computer with Word
after every change to `NeoReadCite.bas` or `customUI14.xml`, then committed.

- **Windows**: allow "Trust access to the VBA project object model" in Word's
  Trust Center, then run `powershell -File apps/cite-plugins/word/build-template.ps1`.
- **macOS**: in Word, open a blank document, Tools > Macro > Visual Basic
  Editor, File > Import File… `NeoReadCite.bas`, then save the document as a
  Word Macro-Enabled Template (`.dotm`). Run
  `node apps/cite-plugins/word/add-ribbon.mjs <saved.dotm>` to add the ribbon
  and write `apps/cite-plugins/word/NeoRead.dotm`.

The ribbon icons in `wps/images` are from Lucide (ISC license).

## Word document-isolation regression

On Windows with Word and VBA project access enabled, run
`powershell -File apps/cite-plugins/word/test-template.ps1`.
The script imports the real module into a separate, unsaved Word project and
adds test-only wrappers around its private operations. It creates disposable
documents to verify that switching documents/cursors cannot redirect updates,
preferences, insertion or removal, and that closing the original document
rejects subsequent writes. It closes only its own Word instance. The test
module and wrappers are not included in the shipped template.

On macOS, run `osascript apps/cite-plugins/word/test-field-result.applescript`
with Word installed. This creates and closes only its own unsaved document to
check the print-date-to-ADDIN field creation workaround, result replacement,
hidden field codes, and absence of leaked placeholder text. It exercises the
Word object model; use the rebuilt template for end-to-end VBA acceptance.

## NeoRead migration

New fields use `NEOREAD_CITATION`, `NEOREAD_BIBLIOGRAPHY` and `NEOREAD_TEMP`;
preferences use `NEOREAD_PREF_n`, and paper URIs use `neoread://paper/…`.
Both Word and WPS still read legacy `READER_` fields and `READER_PREF_n`
properties. New preference chunks take precedence; saving removes legacy
chunks. Field snapshots retain the original code for conflict detection;
refresh writes the new format.

The tracked `word/Reader.dotm` is an unchanged legacy binary. Before shipping,
manually import `NeoReadCite.bas` into Word (remove the old `ReaderCite` module),
rebuild as `NeoRead.dotm`, and apply `customUI14.xml`. This source migration does
not rebuild or rename that binary. Run the Word regression and manual acceptance
checks against the rebuilt template.
