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

@Suite struct DeviceProfileTests {
    static let plist = try! PropertyListSerialization.data(fromPropertyList: [
        "chromeIdentifier": "com.apple.dt.devicekit.chrome.phone5",
        "mainScreenWidth": 1284, "mainScreenHeight": 2778, "mainScreenScale": 3,
    ], format: .binary, options: 0)

    @Test func parsesBareIdentifierAndScreenPoints() throws {
        let p = try DeviceProfile.parsing(plistData: Self.plist)
        #expect(p.chromeIdentifier == "phone5")
        #expect(p.screenSize == Size(width: 428, height: 926))
    }

    @Test func missingChromeIdentifierThrows() {
        let empty = try! PropertyListSerialization.data(fromPropertyList: ["x": 1], format: .binary, options: 0)
        #expect(throws: DeviceProfileParseError.missingChromeIdentifier) {
            _ = try DeviceProfile.parsing(plistData: empty)
        }
    }

    @Test func xcode27CapabilitiesFallback() throws {
        let caps = try! PropertyListSerialization.data(fromPropertyList: [
            "capabilities": ["displays": [
                ["displayType": "tvOut", "width": 720, "height": 480, "scale": 1],
                ["displayType": "integrated", "width": 1170, "height": 2532, "scale": 3],
            ]],
        ], format: .binary, options: 0)
        let bare = try! PropertyListSerialization.data(fromPropertyList: [
            "chromeIdentifier": "com.apple.dt.devicekit.chrome.phone11",
        ], format: .binary, options: 0)
        let p = try DeviceProfile.parsing(plistData: bare, capabilitiesData: caps)
        #expect(p.screenSize == Size(width: 390, height: 844))  // integrated, NOT tvOut
    }
}

@Suite struct DeviceChromeTests {
    static let phone5JSON = """
    {"identifier":"com.apple.dt.devicekit.chrome.phone5",
     "images":{"topLeft":"Phone TL","top":"PhoneTop","topRight":"Phone TR",
       "right":"PhoneRight","bottomRight":"Phone BR","bottom":"PhoneBase",
       "bottomLeft":"Phone BL","left":"PhoneLeft","screen":"Screen",
       "sizing":{"leftWidth":22,"rightWidth":22,"topHeight":22,"bottomHeight":22},
       "padding":{"width":9,"height":0},
       "devicePadding":{"top":0,"left":9,"bottom":0,"right":9}},
     "paths":{"simpleOutsideBorder":{"cornerRadiusX":75}},
     "inputs":[
       {"name":"mute","anchor":"left","image":"Mute BTN","imageDown":"Mute BTN Dn",
        "onTop":false,"offsets":{"normal":{"x":8,"y":160},"rollover":{"x":3,"y":160}}},
       {"name":"power","anchor":"right","image":"X_Power BTN","imageDown":"X_Power BTN Dn",
        "align":"leading","onTop":false,"offsets":{"normal":{"x":-8,"y":262},"rollover":{"x":-3,"y":262}}}]}
    """

    @Test func parsesFullChrome() throws {
        let c = try DeviceChrome.parsing(json: Data(Self.phone5JSON.utf8))
        #expect(c.identifier == "phone5")
        #expect(c.screenInsets == Insets(top: 22, left: 22, bottom: 22, right: 22))
        #expect(c.outerCornerRadius == 75)
        #expect(c.devicePadding == Insets(top: 0, left: 9, bottom: 0, right: 9))
        #expect(c.compositeImageName == nil)          // phone5 is 9-slice only
        #expect(c.slice?.topLeft == "Phone TL")
        #expect(c.buttons.count == 2)
        #expect(c.buttons[1].anchor == .right)
        #expect(c.buttons[1].normalOffset == Point(x: -8, y: 262))
        #expect(c.buttons[1].imageDownName == "X_Power BTN Dn")
        #expect(c.buttons[1].onTop == false)
    }

    @Test func derivedRadii() throws {
        let c = try DeviceChrome.parsing(json: Data(Self.phone5JSON.utf8))
        #expect(c.bezelWidth == 22)
        #expect(c.innerCornerRadius == 53)            // 75 − 22
    }

    @Test func screenRectInComposite() throws {
        let c = try DeviceChrome.parsing(json: Data(Self.phone5JSON.utf8))
        let r = c.screenRect(in: Size(width: 472, height: 970))
        #expect(r.origin == Point(x: 22, y: 22))
        #expect(r.size == Size(width: 428, height: 926))
    }

    @Test func sliceIsAllOrNothing() {
        #expect(DeviceChromeSlice(json: ["topLeft": "a"]) == nil)
    }
}

@Suite struct NineSliceLayoutTests {
    @Test func phone5Canvas() {
        // corner NATIVE 97 (phone5 art); insets are only the screen cutout
        let l = NineSliceLayout.compose(
            insets: Insets(top: 22, left: 22, bottom: 22, right: 22),
            inner: Size(width: 428, height: 926),
            corner: Size(width: 97, height: 97)
        )
        #expect(l.topLeft == Rect(origin: Point(x: 0, y: 0), size: Size(width: 97, height: 97)))
        #expect(l.top.size == Size(width: 472 - 194, height: 97))   // mid region
        #expect(l.left.size == Size(width: 97, height: 970 - 194))
        #expect(l.bottomRight.origin == Point(x: 375, y: 873))
        let canvasW = l.topLeft.size.width + l.top.size.width + l.topRight.size.width
        let canvasH = l.topLeft.size.height + l.left.size.height + l.bottomLeft.size.height
        #expect(Size(width: canvasW, height: canvasH) == Size(width: 472, height: 970))
    }
}

@Suite struct ButtonPlacementTests {
    static let phone5Padding = Insets(top: 0, left: 9, bottom: 0, right: 9)
    static let comp = Size(width: 472, height: 970)

    static let power = ChromeButton(
        name: "power", imageName: "X_Power BTN",
        anchor: .right, align: .leading,
        normalOffset: Point(x: -8, y: 262), rolloverOffset: Point(x: -3, y: 262)
    )
    static let mute = ChromeButton(
        name: "mute", imageName: "Mute BTN",
        anchor: .left, align: .leading,
        normalOffset: Point(x: 8, y: 160), rolloverOffset: Point(x: 3, y: 160)
    )
    // iPad-style top anchor (trailing): N=(-74,8), R=(-74,3)
    static let ipadPower = ChromeButton(
        name: "power", imageName: "P",
        anchor: .top, align: .trailing,
        normalOffset: Point(x: -74, y: 8), rolloverOffset: Point(x: -74, y: 3)
    )
    static let bottomBtn = ChromeButton(
        name: "home", imageName: "H",
        anchor: .bottom, align: .trailing,
        normalOffset: Point(x: -30, y: -6), rolloverOffset: Point(x: -30, y: -1)
    )

    @Test func rightAnchorAtRestMirrorsRollover() {
        // restX = 2(-8) - (-3) = -13 → leftX = 9 + 472 - 13 = 468
        // restY = 2(262) - 262   = 262 → topY  = 0 + 262
        let p = Chromes.buttonTopLeft(button: Self.power, imageSize: Size(width: 16, height: 64),
                                      compositeSize: Self.comp, margins: Self.phone5Padding)
        #expect(p == Point(x: 468, y: 262))
    }

    @Test func leftAnchorBakesHoverState() {
        // merged image bakes HOVER (baguette convention): centre = 9 + ROLLOVER(3)
        // = 12; imgW 16 → leftX = 12 - 8 = 4 (5 chrome-px cap protrusion at
        // the left rail); y = top edge at rollover y (160)
        let p = Chromes.buttonTopLeft(button: Self.mute, imageSize: Size(width: 16, height: 32),
                                      compositeSize: Self.comp, margins: Self.phone5Padding)
        #expect(p == Point(x: 4, y: 160))
    }

    @Test func topAnchorTrailingEdgeAligns() {
        // restY = 2(8) - 3 = 13 → topY = 0 + 13 - imgH(16) = -3
        // restX = 2(-74)-(-74) = -74 → trailing leftX = 9 + 472 - 74 - imgW(32) = 375
        let p = Chromes.buttonTopLeft(button: Self.ipadPower, imageSize: Size(width: 32, height: 16),
                                      compositeSize: Self.comp, margins: Self.phone5Padding)
        #expect(p == Point(x: 375, y: -3))
    }

    @Test func bottomAnchorTrailing() {
        // restY = 2(-6) - (-1) = -11 → topY = 0 + 970 + (-11) = 959
        // restX = 2(-30) - (-30) = -30 → leftX = 9 + 472 - 30 - imgW(20) = 431
        let p = Chromes.buttonTopLeft(button: Self.bottomBtn, imageSize: Size(width: 20, height: 10),
                                      compositeSize: Self.comp, margins: Self.phone5Padding)
        #expect(p == Point(x: 431, y: 959))
    }
}

@Suite struct ChromeIntegrationTests {
    @Test func phone5Live() throws {
        let chromes = Chromes()
        let assets = chromes.assets(deviceName: "iPhone 14 Plus")
        #expect(assets != nil)
    }
}

@Suite struct KeyboardTests {
    @Test func wireCodes() {
        #expect(KeyboardKey.from(wireCode: "KeyA")?.hidUsage.usage == 0x04)
        #expect(KeyboardKey.from(wireCode: "KeyZ")?.hidUsage.usage == 0x1D)
        #expect(KeyboardKey.from(wireCode: "Digit1")?.hidUsage.usage == 0x1E)
        #expect(KeyboardKey.from(wireCode: "Digit0")?.hidUsage.usage == 0x27)
        #expect(KeyboardKey.from(wireCode: "ArrowUp")?.hidUsage.usage == 0x52)
        #expect(KeyboardKey.from(wireCode: "Numpad5")?.hidUsage.usage == 0x5D)
        #expect(KeyboardKey.from(wireCode: "Nope") == nil)
    }
    @Test func decompose() {
        #expect(KeyboardKey.decompose(character: "a")?.key.hidUsage.usage == 0x04)
        #expect(KeyboardKey.decompose(character: "A")?.modifiers == [.shift])
        #expect(KeyboardKey.decompose(character: "!")?.key.hidUsage.usage == KeyboardKey.decompose(character: "1")?.key.hidUsage.usage)
        #expect(KeyboardKey.decompose(character: "é") == nil)   // non-US fails up front
    }
    @Test func deviceButtons() {
        #expect(DeviceButton.from(wireName: "volume-up") == .volumeUp)
        #expect(DeviceButton.power.standardHIDUsage != nil)
        #expect(DeviceButton.home.standardHIDUsage == nil)      // legacy path
        #expect(DeviceButton.from(wireName: "siri") == nil)     // rejected by absence
    }
}

@Suite struct TouchIdentifiersTests {
    @Test func downResetsAndStickiness() {
        var ids = TouchIdentifiers()
        let a = ids.current(for: .down)
        #expect(a == 1)
        #expect(ids.current(for: .move) == 1)   // sticky across the sequence
        #expect(ids.current(for: .up) == 1)
        let b = ids.current(for: .down)          // new touch → new id
        #expect(b == 2)
    }
    @Test func interleavedSequences() {
        var ids = TouchIdentifiers()
        _ = ids.current(for: .down)              // touch 1
        _ = ids.current(for: .up)
        _ = ids.current(for: .down)              // touch 2
        _ = ids.current(for: .move)
        #expect(ids.current(for: .up) == 2)      // still touch 2 at lift
    }
}

@Suite struct GestureJSONTests {
    @Test func parsesAllKinds() throws {
        #expect(try GestureJSON.parse(["kind": "tap", "x": 10.0, "y": 20.0]) == .tap(x: 10, y: 20, duration: 0.05))
        #expect(try GestureJSON.parse(["kind": "swipe", "startX": 1.0, "startY": 2.0, "endX": 3.0, "endY": 4.0]) ==
                .swipe(startX: 1, startY: 2, endX: 3, endY: 4, duration: 0.25))
        #expect(try GestureJSON.parse(["kind": "touch1", "phase": "down", "x": 5.0, "y": 5.0, "edge": "bottom"]) ==
                .touch1(phase: .down, x: 5, y: 5, edge: .bottom))
        #expect(try GestureJSON.parse(["kind": "press", "button": "volume-up", "duration": 0.5]) ==
                .press(button: .volumeUp, duration: 0.5))
        #expect(try GestureJSON.parse(["kind": "key", "code": "Enter", "modifiers": ["shift"]]) ==
                .key(code: "Enter", modifiers: [.shift], duration: 0.1))
        #expect(try GestureJSON.parse(["kind": "type", "text": "hi"]) == .type(text: "hi"))
        #expect(try GestureJSON.parse(["kind": "scroll", "deltaY": -120.0]) == .scroll(deltaX: 0, deltaY: -120))
    }

    @Test func rejections() {
        #expect(throws: GestureJSONError.missingField("x")) {
            _ = try GestureJSON.parse(["kind": "tap", "y": 1.0])
        }
        #expect(throws: GestureJSONError.unknownKind("fling")) {
            _ = try GestureJSON.parse(["kind": "fling"])
        }
        #expect(throws: GestureJSONError.badPhase("sideways")) {
            _ = try GestureJSON.parse(["kind": "touch1", "phase": "sideways", "x": 1.0, "y": 1.0])
        }
        #expect(throws: GestureJSONError.unknownButton("fire")) {
            _ = try GestureJSON.parse(["kind": "press", "button": "fire"])
        }
        #expect(throws: GestureJSONError.rejectedButton("siri")) {
            _ = try GestureJSON.parse(["kind": "press", "button": "siri"])
        }
        #expect(throws: GestureJSONError.badKey("Nope")) {
            _ = try GestureJSON.parse(["kind": "key", "code": "Nope"])
        }
        #expect(throws: GestureJSONError.unsupportedText("é")) {
            _ = try GestureJSON.parse(["kind": "type", "text": "café"])
        }
    }
}
