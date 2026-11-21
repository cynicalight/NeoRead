import CoreGraphics
import Darwin
import Dispatch
import Foundation
import Vision

private struct Bounds: Encodable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

private struct TextSpan: Encodable {
    let text: String
    let bounds: Bounds
}

private struct Reply: Encodable {
    var ready: Bool? = nil
    var spans: [TextSpan]? = nil
    var error: String? = nil
}

private let output = FileHandle.standardOutput
private let encoder = JSONEncoder()

private func reply(_ message: Reply) {
    do {
        try output.write(contentsOf: encoder.encode(message))
        try output.write(contentsOf: Data([0x0a]))
    } catch {
        _exit(EXIT_FAILURE)
    }
}

private func watchParent(_ parent: pid_t) -> Bool {
    // Go may cancel the Node worker with SIGKILL even during a blocking Vision
    // call. Register for its exit before accepting pixels; stdin EOF alone
    // cannot interrupt Vision, and the explicit PID also covers startup races.
    guard parent > 1, getppid() == parent else { return false }
    let queue = kqueue()
    guard queue >= 0 else { return false }
    var change = kevent(
        ident: UInt(parent), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ENABLE),
        fflags: UInt32(NOTE_EXIT), data: 0, udata: nil
    )
    guard kevent(queue, &change, 1, nil, 0, nil) == 0, getppid() == parent else {
        close(queue)
        return false
    }
    DispatchQueue.global().async {
        var event = kevent()
        while kevent(queue, nil, 0, &event, 1, nil) < 0 && errno == EINTR {}
        _exit(EXIT_SUCCESS)
    }
    return true
}

private func readExactly(_ buffer: UnsafeMutableRawBufferPointer) -> Bool {
    guard let base = buffer.baseAddress else { return false }
    var offset = 0
    while offset < buffer.count {
        let count = read(STDIN_FILENO, base.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { return false }
        offset += count
    }
    return true
}

private func readFrame(width: Int, height: Int) -> CGImage? {
    let count = width * height * 4
    guard let bytes = malloc(count) else { return nil }
    guard readExactly(UnsafeMutableRawBufferPointer(start: bytes, count: count)),
          let provider = CGDataProvider(dataInfo: nil, data: bytes, size: count, releaseData: { _, data, _ in
              free(UnsafeMutableRawPointer(mutating: data))
          }) else {
        free(bytes)
        return nil
    }
    return CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
    )
}

private func recognize(_ image: CGImage, request: VNRecognizeTextRequest) {
    do {
        try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
        let page = CGRect(x: 0, y: 0, width: 1, height: 1)
        let spans = (request.results ?? []).compactMap { observation -> TextSpan? in
            guard let text = observation.topCandidates(1).first?.string, !text.isEmpty else { return nil }
            let box = observation.boundingBox.intersection(page)
            guard !box.isEmpty else { return nil }
            return TextSpan(text: text, bounds: Bounds(
                x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height
            ))
        }
        reply(Reply(spans: spans))
    } catch {
        reply(Reply(error: "APPLE_OCR_RECOGNITION"))
    }
}

private func run() -> Int32 {
    guard CommandLine.arguments.count == 2, let parent = pid_t(CommandLine.arguments[1]),
          watchParent(parent) else { return EXIT_FAILURE }

    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequest.currentRevision
    request.recognitionLevel = .accurate
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    let languages = ["en-US", "zh-Hans", "zh-Hant"]
    guard let supported = try? request.supportedRecognitionLanguages(),
          languages.allSatisfy(supported.contains) else {
        reply(Reply(error: "APPLE_OCR_LANGUAGES"))
        return EXIT_FAILURE
    }
    request.recognitionLanguages = languages
    reply(Reply(ready: true))

    // Two little-endian u32 dimensions followed by tightly packed RGBA8
    // pixels. Only the current page is in flight; no temporary files needed.
    var dimensions: (UInt32, UInt32) = (0, 0)
    while withUnsafeMutableBytes(of: &dimensions, readExactly) {
        let width = Int(UInt32(littleEndian: dimensions.0))
        let height = Int(UInt32(littleEndian: dimensions.1))
        guard width > 0, height > 0, width <= 16_384, height <= 16_384, width * height <= 4_250_000 else {
            reply(Reply(error: "APPLE_OCR_FRAME"))
            return EXIT_FAILURE
        }
        let valid = autoreleasepool {
            guard let image = readFrame(width: width, height: height) else { return false }
            recognize(image, request: request)
            return true
        }
        if !valid {
            reply(Reply(error: "APPLE_OCR_FRAME"))
            return EXIT_FAILURE
        }
    }
    return EXIT_SUCCESS
}

exit(run())
