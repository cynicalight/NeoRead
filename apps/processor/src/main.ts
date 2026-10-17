import { stage, failure } from "./diagnostics";

// Load native modules inside the catch boundary: static imports can fail before
// any application code runs, especially when Windows runtime DLLs are missing.
try {
  stage("canvas_load");
  const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  stage("onnx_load");
  await import("onnxruntime-node");
  stage("worker_load");
  await import("./layout-worker");
  stage("complete");
} catch (error) {
  failure(error);
  process.exitCode = 1;
}
