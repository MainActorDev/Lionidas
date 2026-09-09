// Tuning — encoder-latency knobs as a pure value (testable apart from the
// irreducible VideoToolbox calls in H264.swift).
//
// Values follow baguette's H264Tuning.lowLatency (Apache-2.0, attributed):
// the recipe that produced QA-approved sharpness at low latency.
import Foundation
import CoreVideo
import VideoToolbox

struct Tuning: Equatable, Sendable {
    let realTime: Bool
    let allowFrameReordering: Bool
    let maxFrameDelayCount: Int?
    let lowLatencyRateControl: Bool
    let keyFrameIntervalSeconds: Int

    static let lowLatency = Tuning(
        realTime: true,
        allowFrameReordering: false,
        maxFrameDelayCount: 0,
        lowLatencyRateControl: true,
        keyFrameIntervalSeconds: 5
    )

    /// Frames between forced IDRs at a given capture rate; guards fps <= 0.
    func maxKeyFrameInterval(fps: Int) -> Int {
        guard fps > 0 else { return 300 }
        return max(1, fps * keyFrameIntervalSeconds)
    }

    /// The VTSession property list this tuning maps to. Pure — unit-tested
    /// against the expected keys/values before any native call consumes it.
    func sessionProperties(bitrate: Int, fps: Int) -> [(CFString, Any)] {
        var props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, realTime ? kCFBooleanTrue! : kCFBooleanFalse!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, allowFrameReordering ? kCFBooleanTrue! : kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: maxKeyFrameInterval(fps: fps))),
        ]
        if let maxDelay = maxFrameDelayCount {
            props.append((kVTCompressionPropertyKey_MaxFrameDelayCount, NSNumber(value: maxDelay)))
        }
        return props
    }
}
