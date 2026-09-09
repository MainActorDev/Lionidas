// Unit tests — the pure domain: envelope, tuning, bitstream conversion,
// WS frame subset, backpressure queue, run-hold state machine.
import Testing
import Foundation
import VideoToolbox
@testable import CrucibleScreenstream

@Suite struct EnvelopeTests {
    @Test func tagsRoundTrip() {
        let payload = Data([0xAA, 0xBB, 0xCC])
        for (tag, frame) in [
            (FrameTag.description, Envelope.description(avcC: payload)),
            (FrameTag.keyframe, Envelope.keyframe(avcc: payload)),
            (FrameTag.delta, Envelope.delta(avcc: payload)),
            (FrameTag.seed, Envelope.seed(jpeg: payload)),
        ] {
            #expect(frame.first == tag.rawValue)
            #expect(Data(frame.dropFirst()) == payload)
        }
    }

    @Test func parameterSetsSplit() {
        // avcC: 8B header + SPS(len 3) + PPS count(1) + PPS len(2) + PPS(len 2)
        var avcc = Data([0x01, 0x64, 0x00, 0x1F, 0xFF, 0xE1, 0x00, 0x03, 0x67, 0x42, 0x00])
        avcc.append(0x01); avcc.append(0x00); avcc.append(0x02)
        avcc.append(contentsOf: [0x68, 0xCE])
        let sets = Envelope.parameterSets(fromAvcC: avcc)
        #expect(sets?.sps == Data([0x67, 0x42, 0x00]))
        #expect(sets?.pps == Data([0x68, 0xCE]))
    }
}

@Suite struct TuningTests {
    @Test func lowLatencyValues() {
        let t = Tuning.lowLatency
        #expect(t.realTime && !t.allowFrameReordering && t.maxFrameDelayCount == 0 && t.lowLatencyRateControl)
        #expect(t.maxKeyFrameInterval(fps: 30) == 150)      // 5s GOP at 30fps
        #expect(t.maxKeyFrameInterval(fps: 0) == 300)        // guarded
    }

    @Test func sessionPropertyKeys() {
        let props = Tuning.lowLatency.sessionProperties(bitrate: 24_000_000, fps: 30)
        let keys = props.map(\.0)
        #expect(keys.contains(kVTCompressionPropertyKey_RealTime))
        #expect(keys.contains(kVTCompressionPropertyKey_AverageBitRate))
        // MaxFrameDelayCount rides only when maxFrameDelayCount != nil
        #expect(Tuning.lowLatency.maxFrameDelayCount == 0)
    }
}

@Suite struct AnnexBTests {
    @Test func convertsStartCodesToLengths() {
        // one NAL: 00 00 00 01 61 42 43  ; one NAL: 00 00 01 65 01
        let bytes: [Int8] = [0, 0, 0, 1, 0x61, 0x42, 0x43, 0, 0, 1, 0x65, 0x01]
        let avcc = bytes.withUnsafeBufferPointer { H264.annexBToAvcc($0) }
        // NAL1: len 3 + 3 bytes ; NAL2: len 2 + 2 bytes
        #expect(avcc.count == 4 + 3 + 4 + 2)
        #expect(Array(avcc.prefix(4)) == [0, 0, 0, 3])
        #expect(Array(avcc.dropFirst(4).prefix(3)) == [0x61, 0x42, 0x43])
        #expect(Array(avcc.dropFirst(7).prefix(4)) == [0, 0, 0, 2])
    }

    @Test func garbageYieldsEmpty() {
        let bytes: [Int8] = [1, 2, 3, 4, 5]
        let avcc = bytes.withUnsafeBufferPointer { H264.annexBToAvcc($0) }
        #expect(avcc.isEmpty)
    }
}

@Suite struct WSFrameTests {
    @Test func smallFrameLayout() {
        let f = Session.opFrame(0x02, payload: Data(repeating: 7, count: 5))
        #expect(Array(f.prefix(2)) == [0x82, 0x05])
        #expect(f.count == 7)
    }

    @Test func extended16BitLength() {
        let f = Session.opFrame(0x01, payload: Data(repeating: 1, count: 300))
        #expect(f[1] == 126)
        #expect(f[2] == 0x01 && f[3] == 0x2C)   // 300
        #expect(f.count == 4 + 300)
    }

    @Test func inboundParseWithMask() {
        // masked text frame "A" (opcode 1, mask set, len 1)
        var raw = Data([0x81, 0x81])
        raw.append(contentsOf: [0x01, 0x02, 0x03, 0x04])   // mask
        raw.append(0x41 ^ 0x01)                            // 'A' masked
        var buf = raw
        var got: (Session.WsOp, Data)?
        Session.parseInbound(&buf) { op, payload in got = (op, payload) }
        #expect(got?.0 == .text)
        #expect(got?.1 == Data("A".utf8))
        #expect(buf.isEmpty)
    }
}

@Suite struct RunHoldStateTests {
    @Test func pauseDropsResumeForces() {
        var s = RunHoldState()
        s.pause()
        var encodedWhileHeld = false
        #expect(s.compositeSeen() == false)  // held: composites ignored
        encodedWhileHeld = s.compositeSeen()
        #expect(!encodedWhileHeld)
        s.resume()
        let encoded = s.compositeSeen()      // first composite after resume encodes…
        #expect(encoded)
        #expect(!s.pendingForceKeyframe)     // …and consumed the forced IDR
    }
}
