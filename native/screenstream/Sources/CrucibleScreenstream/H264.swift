// H264 — real-time VideoToolbox encoder producing AVCC output.
//
// Follows baguette's H264Encoder.swift recipe (Apache-2.0, attributed):
// per-frame timestamp from a frame counter, low-latency session spec at
// CREATE time (rate control is not a settable property), async output on
// VT's queue, avcC description extracted once and re-emitted after any
// session rebuild (dimension change).
import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox

final class H264: @unchecked Sendable {
    struct Encoded {
        enum Kind { case keyframe, delta }
        let kind: Kind
        let avcc: Data               // length-prefixed AVCC NALs
        let description: Data?       // avcC blob, non-nil once per session
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var frameCount: Int64 = 0
    private let lock = NSLock()

    var onEncoded: (@Sendable (Encoded) -> Void)?

    private let tuning: Tuning
    private var fps: Int
    private var bitrate: Int

    init(fps: Int, bitrate: Int, tuning: Tuning = .lowLatency) {
        self.fps = max(1, fps)
        self.bitrate = bitrate
        self.tuning = tuning
    }

    func setFps(_ newFps: Int) { lock.lock(); defer { lock.unlock() }; fps = max(1, newFps) }
    func setBitrate(_ bps: Int) {
        lock.lock(); defer { lock.unlock() }
        guard let session else { return }
        bitrate = bps
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bps))
    }

    func encode(_ pixelBuffer: CVPixelBuffer, forceKeyframe: Bool = false) {
        let w = Int32(CVPixelBufferGetWidth(pixelBuffer))
        let h = Int32(CVPixelBufferGetHeight(pixelBuffer))
        lock.lock()
        if session == nil || w != width || h != height {
            width = w; height = h
            rebuildSessionLocked()
        }
        guard let session else { lock.unlock(); return }
        frameCount += 1
        let pts = CMTime(value: frameCount, timescale: CMTimeScale(fps))
        let props: NSDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil
        // Per-frame output handler (baguette's exact overload): VT calls it
        // on its own queue with the CMSampleBuffer. Held-lock hazard: drop
        // the lock before returning so handleOutput never contends.
        let sess = session
        let cb: @Sendable (OSStatus, VTEncodeInfoFlags, CMSampleBuffer?) -> Void
            = { [weak self] status, _, sample in
                guard status == noErr, let sample else { return }
                self?.handleOutput(sample)
            }
        lock.unlock()
        VTCompressionSessionEncodeFrame(
            sess,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: props,
            infoFlagsOut: nil,
            outputHandler: cb
        )
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
    }

    // MARK: - private

    private func rebuildSessionLocked() {
        if let session { VTCompressionSessionInvalidate(session); self.session = nil }

        let spec: CFDictionary? = tuning.lowLatencyRateControl
            ? [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!] as CFDictionary
            : nil

        var sess: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width, height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec,
            imageBufferAttributes: nil,
            compressedDataAllocator: kCFAllocatorDefault,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &sess
        )
        guard status == noErr, let sess else {
            // loud by design: private/driver failures surface, never limp
            FileHandle.standardError.write(Data("H264: session create failed (\(status))\n".utf8))
            return
        }
        for (key, value) in tuning.sessionProperties(bitrate: bitrate, fps: fps) {
            VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
    }

    func handleOutput(_ sample: CMSampleBuffer) {
        // Keyframe rule (baguette's, empirically correct against VT output):
        // a sample is a keyframe unless it carries the NotSync attachment.
        // DependsOnOthers reads inverted on this VT build — every frame
        // looked like a delta under that rule.
        let isKey = !Self.sampleNotSync(sample)

        // Parameter sets ride EVERY keyframe: late joiners and reconnects
        // (re)configure from any IDR without depending on session order.
        let description: Data? = isKey ? Self.extractAvcC(from: sample) : nil
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sample) else { return }
        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0,
                                          lengthAtOffsetOut: &lengthAtOffset,
                                          totalLengthOut: &totalLength,
                                          dataPointerOut: &dataPointer) == noErr,
              let dataPointer else { return }
        // Annex-B (start codes) → AVCC (4-byte big-endian lengths)
        let annexB = UnsafeBufferPointer(start: dataPointer, count: totalLength)
        let avcc = Self.normalizeToAvcc(annexB)
        if avcc.isEmpty { return }
        onEncoded?(Encoded(kind: isKey ? .keyframe : .delta, avcc: avcc, description: description))
    }

    // MARK: - bitstream (pure, unit-tested)



    /// Keyframe probe: VT marks non-key samples with the NotSync attachment;
    /// absence of the key means keyframe (baguette's rule, Apache-2.0).
    private static func sampleNotSync(_ sample: CMSampleBuffer) -> Bool {
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(arr) > 0,
              let cfDict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFDictionary?.self)
        else { return false }
        return CFDictionaryContainsKey(cfDict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    /// The encoder's data buffer, normalized to AVCC. VT's low-latency H264
    /// path can emit either layout; detect rather than assume (empirically:
    /// this Xcode 26.4 build emits AVCC lengths directly — `00 01 43 48` is
    /// a 4-byte NAL length, not a start code).
    static func normalizeToAvcc(_ bytes: UnsafeBufferPointer<Int8>) -> Data {
        if bufferLooksAnnexB(bytes) {
            return annexBToAvcc(bytes)
        }
        return Data(UnsafeBufferPointer(rebasing: bytes[bytes.startIndex...]).map { UInt8(bitPattern: $0) })
    }

    /// Heuristic: any 3/4-byte start code in the first 4KB means Annex-B.
    static func bufferLooksAnnexB(_ bytes: UnsafeBufferPointer<Int8>) -> Bool {
        let n = min(4096, bytes.count)
        guard n >= 4 else { return false }
        for i in 0 ..< (n - 3) {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 { return true }
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 0, bytes[i + 3] == 1 { return true }
        }
        return false
    }

    /// Annex-B start codes (00 00 00 01 / 00 00 01) → AVCC 4-byte length
    /// prefixes. Same conversion baguette performs; pure static for tests.
    static func annexBToAvcc(_ bytes: UnsafeBufferPointer<Int8>) -> Data {
        var nalStarts: [Int] = []
        var i = 0
        let n = bytes.count
        while i + 3 < n {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 0, bytes[i + 3] == 1 {
                nalStarts.append(i + 4); i += 4
            } else if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
                nalStarts.append(i + 3); i += 3
            } else {
                i += 1
            }
        }
        guard !nalStarts.isEmpty else { return Data() }
        var out = Data()
        for (idx, start) in nalStarts.enumerated() {
            let end = idx + 1 < nalStarts.count ? nalStarts[idx + 1] - (bytes[start - 1] == 1 ? 3 : 4) : n
            guard end > start else { continue }
            var len = UInt32(end - start).bigEndian
            withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
            out.append(contentsOf: UnsafeBufferPointer(rebasing: bytes[start ..< end]).map { UInt8(bitPattern: $0) })
        }
        return out
    }

    static func extractAvcC(from sample: CMSampleBuffer) -> Data? {
        guard let format = CMSampleBufferGetFormatDescription(sample) else { return nil }
        var spsPtr: UnsafePointer<UInt8>?, ppsPtr: UnsafePointer<UInt8>?
        var spsSize = 0, ppsSize = 0, spsCount = 0, nalSize: Int32 = 0
        _ = spsCount
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: &nalSize
        ) == noErr, let spsPtr else { return nil }
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPtr else { return nil }

        var blob = Data()
        blob.append(0x01)                     // avcC version
        blob.append(spsPtr[1]); blob.append(spsPtr[2]); blob.append(spsPtr[3])
        blob.append(0xFF); blob.append(0xE1)  // 4-byte lengths, 1 SPS
        blob.append(UInt8((spsSize >> 8) & 0xFF)); blob.append(UInt8(spsSize & 0xFF))
        blob.append(contentsOf: UnsafeBufferPointer(start: spsPtr, count: spsSize))
        blob.append(0x01)
        blob.append(UInt8((ppsSize >> 8) & 0xFF)); blob.append(UInt8(ppsSize & 0xFF))
        blob.append(contentsOf: UnsafeBufferPointer(start: ppsPtr, count: ppsSize))
        return blob
    }
}

