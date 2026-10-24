# CSL files

Styles (`*.csl`) come from the [CSL style repository](https://github.com/citation-style-language/styles), except `gb-t-7714-*-bilingual.csl` from [zotero-chinese/styles](https://github.com/zotero-chinese/styles), and locales (`locales-*.xml`) from the [CSL locales repository](https://github.com/citation-style-language/locales). Both are licensed under CC BY-SA 3.0 and are unmodified; each file keeps its own authors and license in its header.

- Citation export uses `china-national-standard-gb-t-7714-2015-numeric.csl` and `locales-zh-CN.xml` through `@citation-js/plugin-csl`.
- The bilingual GB/T 7714 styles use CSL-M layouts (`<layout locale="en">`), which only citeproc-js supports; an entry picks its layout from the item's `language`.
- The Word/WPS citation plugin loads every style and locale here through `src/cite/styles.ts`. A new file needs an entry in `bundledStyles` to appear in the preferences dialog.

Update the files together with `citeproc` and `@citation-js/plugin-csl` after checking the formatting tests.
