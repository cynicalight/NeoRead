# Local PDF layout and Codex validation

> This document records validation before the Pi migration. See the [current Pi runtime](agent-streaming-contract.md#内置-pi-与模型连接).

The processor is now connected to the desktop two-stage import UI, with separate progress bars and detected-region hover. Full-document retrieval and image-click conversations remain separate work. The agreed workflow is in [reading-workflow.md](reading-workflow.md).

## Distribution decision

The default installer includes PDF.js, the native Canvas runtime, ONNX Runtime, the processor code and the pinned PP-DocLayoutV3 FP16 weights. The processor build downloads and verifies the weights once into an ignored build cache, then copies the current model into application resources alongside its Apache-2.0 license and provenance notice. Runtime inference verifies and reads that bundled copy, including on first use without network access or a library model cache. Users do not install Python or PaddlePaddle. See [releasing.md](releasing.md) for build caching and offline build inputs.

The desktop import flow now starts the worker automatically for PDFs. The UI exposes per-page learning progress, translation progress, connection waits and retries; model downloads occur only during builds. Per-asset image consolidation has since been removed; the consolidation results below are a historical record. Desktop installers are built with electron-builder.

Weights: `bu44er/PP-DocLayoutV3-FP16-ONNX`, revision `58dfa00ba1135e027817cbd5802f1f0df62aa5c0`, file `PP-DocLayoutV3-fp16.onnx`, 67,372,587 bytes (about 67 MB / 64.3 MiB). SHA256: `8bb693ed3b5dcc1cf926b15d89dfe6abf62bc11cdd0afd33c8ffe039db6f8209`. It is a byte-identical mirror of [`stefanj0/PP-DocLayoutV3-FP16-ONNX`](https://huggingface.co/stefanj0/PP-DocLayoutV3-FP16-ONNX) at `ca5155572513b7832d297255a1f5cab0ff4b0202`, an FP16 export of [`PaddlePaddle/PP-DocLayoutV3_safetensors`](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_safetensors) without the mask head; box decoding and reading-order postprocessing stay in FP32. The mirror keeps the file available if the source repository disappears. Weights and generated user documents are not committed. Build downloads are checked before publication; partial downloads never become usable models. Runtime verifies the bundled file and fails locally if it is missing or corrupt, without downloading a replacement. Old per-library caches are left untouched.

I/O differs from the official paddle2onnx export: the output is `det` (`[300,7]`), boxes are in the 800×800 input space, and `scale_factor` is passed as `[1,1]`. `detectRegions` owns this contract. Set `NEOREAD_TEST_LAYOUT_MODEL` to a downloaded copy to run the real-model coordinate test.

The FP16 model replaced the official FP32 [`PaddlePaddle/PP-DocLayoutV3_onnx`](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_onnx) (revision `46bbdf1`, 130,502,049 bytes) on 2026-10-08. On 72 pages from four English papers with ONNX Runtime CPU: 1434 regions from each model, 1431 matched at IoU ≥ 0.5 with mean IoU 0.991, no label changes, 99.7% pairwise reading-order agreement, unchanged per-page latency (about 1.1 s), and peak inference RSS of 0.77 GB instead of 1.24 GB. The remaining differences were regions at the 0.5 confidence threshold. On the Oze paper the full worker produced the same 17 image blocks on the same pages and the same block count as the FP32 run. Scanned, CJK and vertical-text documents were not compared.

Sources: [mirror model card](https://huggingface.co/bu44er/PP-DocLayoutV3-FP16-ONNX), [official FP32 configuration](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_onnx/blob/46bbdf188bb0a772c08aed74882ce7e51a8f1ea6/inference.yml), [PaddleX postprocessing](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/object_detection/processors.py). Model license: Apache-2.0; the mirror carries the license text and upstream attribution.

## Reproduce

```sh
pnpm --filter @neoread/processor build
node apps/processor/dist/main.mjs \
  --input 'docs/66_VLDB25- Oze_ Decentralized Graph-based Concurrency Control for Long-running Update Transactions.pdf' \
  --output .neoread/layout-check/oze \
  --debug
```

Use a fresh output directory for each run. `--model FILE` accepts an already-downloaded copy, still checked against the pinned hash. Without `--debug`, full-page and diagnostic images are not saved. `manifest.json` is written last and records source hash, page count, normalized coordinates, model revision, timing and warnings. `paper.md` references crops in `assets/`. The sample PDF is supplied locally by the user and is not distributed in this repository.

Opt-in real Codex test (uses the existing CLI login and subscription):

```sh
cd apps/server
NEOREAD_TEST_CODEX=1 go test ./internal/neoread -run '^TestLiveCodex$' -v -count=1
```

The default automated test suite skips this call. To additionally test a paper image, set `NEOREAD_TEST_IMAGE` to its absolute PNG path and optionally `NEOREAD_TEST_OUTPUT` to a Markdown destination. The test runs in a fresh temporary working directory, disables shell tools and avoids user/project instruction configuration. It uses the CLI's authentication; NeoRead does not inspect credentials.

## Bundled-model validation on 2026-10-12

On the development Apple Silicon Mac, `pnpm build` fetched the pinned weights into a fresh build cache and verified their exact size and SHA256. `pnpm package` reused that cache, produced the macOS ARM64 DMG and update ZIP, and passed the packaged-runtime checks after relocating the whole application outside the checkout.

The packaged worker processed the two-page original `reading-notes.pdf` sample in a fresh temporary directory, with Node `fetch` and TCP connections disabled and without a model-path override or a library model cache. It produced 18 layout blocks, per-page detections, extracted text, `paper.md` and a completed `manifest.json`. The check also verified the bundled license/provenance files, application signature, Go sidecar, SQLite initialization, loopback binding, API authentication and web resources. This establishes offline first use for the tested sample and macOS runtime, not general document accuracy or installed GUI behavior.

Type checking and the full build passed. The initial parallel test run had four failures in existing timing-sensitive tests (three test timeouts and one asynchronous rendering wait); the complete serial rerun with `pnpm test --maxWorkers=1` passed Go tests and 566 Vitest tests, with three skips. `NEOREAD_TEST_LAYOUT_MODEL` pointed at the newly bundled model, so the real-model coordinate test ran in both full-suite runs. Test timeouts and application behavior outside model distribution were not changed.

The local v0.5.1 validation artifacts measured 203,893,014 bytes (194.45 MiB) for the DMG and 248,945,874 bytes (237.41 MiB) for the update ZIP. These are total artifact sizes, not a measured increase over an equivalent unbundled build. Windows packaging and installation/GUI acceptance remain unverified for this change; the shared packaging smoke will run on the Windows release runner.

## Observations on 2026-10-04

The supplied Oze paper has 13 pages. All pages rendered and underwent local CPU inference in approximately 17 seconds on the development Mac (including diagnostic PNG output, excluding model download/startup and AI calls). Observed process peak RSS was about 1.3 GB; this is a prototype measurement, not a system requirement or a guarantee for other hardware.

The first rendering attempt crashed because PDF.js and the processor loaded different native Canvas versions. Using the same `@napi-rs/canvas` version as PDF.js fixed the crash on this fixture. Keep those native object implementations aligned when updating dependencies.

The raw detector returned 85 inline formula regions. Those remain in paragraph text instead of creating dozens of tiny images. Separate figures with one numbered caption are grouped into a whole block, including captions and subfigure labels. Independent neighboring figures must not merge. Regression tests cover these boundaries, invalid coordinates, duplicate detections and retained unmatched text.

Codex passed an actual text invocation and an eight-tile randomized visual challenge. An automatically cropped Figure 2 also produced a Chinese Markdown transcript. This verifies the image transport and a real paper-image response; it does not validate every relation or figure in the paper.

## Desktop processing integration check

The Oze fixture completed the real import → learning → waiting for configuration → consolidation → ready sequence in an isolated library. The worker ran through the Electron executable with `ELECTRON_RUN_AS_NODE=1`. All 13 pages were processed, 17 image blocks were available before vision finished, and all 17 nonempty Markdown transcripts were saved using the locally authenticated Codex CLI.

After the first transcript was saved, the Go service was stopped and restarted. Processing resumed, and hashes confirmed that previously completed transcripts were unchanged. This checks transport, persistence and lifecycle behavior; transcript factual accuracy has not been reviewed exhaustively.

Validation passed: `pnpm typecheck`, `pnpm test` (Go suite and 23 Vitest tests), `pnpm build`, plus targeted Go race tests for queue recovery, capability wake-up, transcript preservation and the library lock. Native Electron inspection observed separate progress bars during learning and Figure 1 region hover. The final rebuild was launched successfully; a subsequent screenshot attempt was blocked by a macOS capture error.

## Remaining limits

- One paper is not enough to establish layout accuracy; this fixture does not establish table detection quality.
- Some captions and standalone formula boundaries are incomplete. Caption grouping is heuristic and needs a wider fixture set. Do not present model confidence as measured accuracy.
- Extracted formula text is not reliable mathematical transcription. Use the original image and vision transcript; retain source coordinates.
- Reading order follows detector output. Heading levels are provisional; paragraphs crossing pages and nested subsections are not fully reconstructed.
- The worker does not perform OCR. Pages without extractable text are explicitly marked incomplete.
- Resume, per-asset vision jobs, atomic transcript publication, two-stage UI, hover and desktop worker lifecycle are integrated. Whole-document retrieval, citation navigation and conversation-driven revisions remain work under the wider plan.
- Native Electron inspection confirmed separate progress bars and Figure 1 hover alignment on the supplied paper. No browser automation was used. This is a scoped check, not cross-platform or comprehensive visual acceptance.

## Library presentation update

The library now truncates long titles inside a shrinkable grid cell, removes decorative branding/copy, and uses a subtly raised main surface. Light/dark/system appearance is persisted with reading preferences and synchronized to Electron native chrome; live system changes are covered by a renderer hook test. PDF processing appears on covers one stage at a time, with a completion transition and no persistent reading-toolbar progress strip. Waiting/retry actions remain accessible on the cover.

`pnpm typecheck`, `pnpm test` (27 Vitest tests plus Go), and `pnpm build` passed for this update. Native screenshot capture returned a macOS ScreenCaptureKit error, so the updated appearance and title layout require manual visual verification in the relaunched Electron app. Check the long Oze title, all three appearance choices, and cover-stage transitions during an import.
