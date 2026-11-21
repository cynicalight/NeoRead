# PP-DocLayoutV3 FP16 ONNX weights

NeoRead distributes the unmodified `PP-DocLayoutV3-fp16.onnx` weights under
Apache-2.0. The license text is included in `LICENSE` beside this notice.

- Upstream weights: https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_safetensors
- FP16 ONNX export: https://huggingface.co/stefanj0/PP-DocLayoutV3-FP16-ONNX
  at revision `ca5155572513b7832d297255a1f5cab0ff4b0202`.
- Unmodified mirror: https://huggingface.co/bu44er/PP-DocLayoutV3-FP16-ONNX
  at revision `58dfa00ba1135e027817cbd5802f1f0df62aa5c0`.
- File size: 67,372,587 bytes.
- SHA256: `8bb693ed3b5dcc1cf926b15d89dfe6abf62bc11cdd0afd33c8ffe039db6f8209`.

The export uses FP16 for the backbone, encoder and decoder, retains FP32 box
decoding and reading-order postprocessing, and omits the mask/polygon head.
NeoRead does not modify the exported weights and is not affiliated with or
endorsed by PaddlePaddle.

## Optional PP-OCRv5 ONNX models

On request, NeoRead downloads the following unmodified Apache-2.0 artifacts
published by PaddlePaddle. They are not included in the application installer.
`LICENSE` applies to these artifacts as well.

- `det.onnx`: [PP-OCRv5 mobile detection weights](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/blob/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx).
- `rec.onnx`: [PP-OCRv5 server recognition weights](https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/blob/b70df217f4fd99d14f970bad092cebe7d74cc4d1/inference.onnx).
- `rec.yml`: [matching recognition configuration and character dictionary](https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/blob/b70df217f4fd99d14f970bad092cebe7d74cc4d1/inference.yml).
