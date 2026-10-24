# Citation plugins

Word and WPS clients for the Reader citation plugin. They only execute the
document operations Reader sends; formatting, dialogs and the library stay in
Reader. Design and protocol: `docs/research/word-plugin.md`.

- `wps/` — WPS 文字 JS add-in. Reader serves it from
  `http://127.0.0.1:17841/wps/<installation-key>/`, authenticated with a
  random key stored in the current user's configuration. The page exchanges
  that key at `/v1/cite/bootstrap` for a rotating runtime credential; HTML
  never embeds credentials. Existing installations need reinstalling once. `js/word-document.js` implements the operations on the Word
  object model and is tested against a fake model in `js/wps-client.test.mjs`.
- `word/` — Word template for Windows and macOS.
  - `ReaderCite.bas`: the VBA module. Keep it ASCII; write Chinese messages as
    `T("\u....")` escapes, because Word reads modules in the system code page.
  - `customUI14.xml`: the ribbon.
  - `ReaderCite.applescript`: the macOS transport (Word's VBA is sandboxed),
    installed as `~/Library/Application Scripts/com.microsoft.Word/ReaderCite.scpt`.
  - `Reader.dotm`: the built template that Reader installs. It is a binary
    built with Word, not in CI.

## Building Reader.dotm

VBA must be compiled by Word, so the template is built on a computer with Word
after every change to `ReaderCite.bas` or `customUI14.xml`, then committed.

- **Windows**: allow "Trust access to the VBA project object model" in Word's
  Trust Center, then run `powershell -File apps/cite-plugins/word/build-template.ps1`.
- **macOS**: in Word, open a blank document, Tools > Macro > Visual Basic
  Editor, File > Import File… `ReaderCite.bas`, then save the document as a
  Word Macro-Enabled Template (`.dotm`). Run
  `node apps/cite-plugins/word/add-ribbon.mjs <saved.dotm>` to add the ribbon
  and write `apps/cite-plugins/word/Reader.dotm`.

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
