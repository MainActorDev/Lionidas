// Envelope — the 4-tag binary frame wire protocol.
//
// [1B tag][payload]:
//   0x01 avcC description (SPS+PPS, avcC layout)
//   0x02 IDR keyframe (AVCC length-prefixed NALs)
//   0x03 P-frame delta (AVCC length-prefixed NALs)
//   0x04 JPEG seed (instant paint before H.264 warms)
//
// Wire-compatible with baguette's Envelope.swift (Apache-2.0; attributed in
// LICENSES/screenstream-ATTRIBUTION.md) so the proven browser decoder works
// unchanged. Pure value domain — no I/O, fully unit-tested.
import Foundation

enum FrameTag: UInt8 {
    case description = 0x01
    case keyframe = 0x02
    case delta = 0x03
    case seed = 0x04
}

enum Envelope {
    static func wrap(tag: FrameTag, payload: Data) -> Data {
        var out = Data(capacity: payload.count + 1)
        out.append(tag.rawValue)
        out.append(contentsOf: payload)
        return out
    }

    static func keyframe(avcc: Data) -> Data { wrap(tag: .keyframe, payload: avcc) }
    static func delta(avcc: Data) -> Data { wrap(tag: .delta, payload: avcc) }
    static func seed(jpeg: Data) -> Data { wrap(tag: .seed, payload: jpeg) }
    static func description(avcC: Data) -> Data { wrap(tag: .description, payload: avcC) }

    /// Splits an avcC blob (as VideoToolbox's parameter-set extraction yields:
    /// fixed 8-byte header + SPS + 2-byte len + PPS) into its SPS/PPS NAL units.
    /// Used by tests to verify description payloads round-trip.
    static func parameterSets(fromAvcC avcc: Data) -> (sps: Data, pps: Data)? {
        guard avcc.count > 8 else { return nil }
        let spsLen = Int(avcc[6]) << 8 | Int(avcc[7])
        guard spsLen > 0, 8 + spsLen + 3 <= avcc.count else { return nil }
        let sps = avcc[8 ..< 8 + spsLen]
        let ppsLen = Int(avcc[8 + spsLen + 1]) << 8 | Int(avcc[8 + spsLen + 2])
        guard ppsLen > 0, 8 + spsLen + 3 + ppsLen <= avcc.count else { return nil }
        let pps = avcc[(8 + spsLen + 3) ..< (8 + spsLen + 3 + ppsLen)]
        return (Data(sps), Data(pps))
    }
}
