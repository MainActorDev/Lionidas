// HIDInput — SimulatorKit host-HID dispatch adapter.
// Ported 1:1 from baguette's Infrastructure/Input/IndigoHIDInput.swift
// (Apache-2.0, attributed), scoped to the phone plane (no CarPlay — out of
// scope for Crucible's wall). The fn signatures, warm-up order, retry
// windows, and button recipes are empirical facts; do not "fix".
//
// Thread contract: mouse-event paths read NSEvent thread-local state →
// main thread only. Our WS receive loop runs on the main queue, asserted
// per dispatch. Buttons / HIDArbitrary are pure C — thread-safe.
import Foundation
import ObjectiveC

/// The input surface a device exposes (baguette's `Input` protocol,
/// renamed to our domain noun).
protocol InputSurface: AnyObject {
    func tap(at point: Point, size: Size, duration: Double) -> Bool
    func swipe(from start: Point, to end: Point, size: Size, duration: Double) -> Bool
    func touch1(phase: TouchPhase, at point: Point, size: Size, edge: DeviceEdge?) -> Bool
    func touch2(phase: TouchPhase, first: Point, second: Point, size: Size) -> Bool
    func button(_ button: DeviceButton, duration: Double) -> Bool
    func key(_ key: KeyboardKey, modifiers: Set<KeyModifier>, duration: Double) -> Bool
    func scroll(deltaX: Double, deltaY: Double) -> Bool
}

enum TouchPhase: String, Sendable {
    case down, move, up
}

enum DeviceEdge: String, Sendable {
    case left, top, right, bottom
}

/// Monotonic per-instance touch identifier, sticky across a touch1
/// sequence (down resets, move reuses, up keeps; overflow resets to 1).
/// iOS threads a touch sequence through the HID stack by identifier —
/// reusing one across distinct touches confuses the recogniser.
struct TouchIdentifiers: Equatable, Sendable {
    private var counter: UInt32 = 0
    private var sticky: UInt32?

    mutating func current(for phase: TouchPhase) -> UInt32 {
        if phase == .down {
            counter &+= 1
            if counter == 0 { counter = 1 }
            sticky = counter
        }
        if let sticky { return sticky }
        counter &+= 1
        if counter == 0 { counter = 1 }
        sticky = counter
        return counter
    }
}

final class HIDInput: InputSurface, @unchecked Sendable {
    private let udid: String
    private let discovery: SimulatorResolving
    let touchTarget: UInt32 = IndigoHIDTouchTarget.phone

    private var client: AnyObject?
    private var warmed = false
    private let lock = NSLock()
    private var identifiers = TouchIdentifiers()

    // IndigoHIDMessageForMouseNSEvent — 9-arg shape (Xcode 26 preview-kit).
    // Coords NORMALIZED 0-1; target=0x32 routes to the touch digitizer.
    // direction: 1=down, 0=move, 2=up. nsEventType: 1=down, 2=up, 6=dragged.
    private typealias MouseFn = @convention(c) (
        UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?,
        UInt32, UInt32, UInt32,
        Double, Double,        // unused1, unused2 — pass 1.0
        Double, Double         // widthPoints, heightPoints
    ) -> UnsafeMutableRawPointer?
    /// The *real* 7-arg ABI used for edge gestures where iOS reads x4
    /// as `IndigoHIDEdge` (baguette derived it by disassembling
    /// SimulatorKit; bounds-check `cmp x24, #0x4` at 0x11270).
    private typealias MouseEdgeFn = @convention(c) (
        UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?,
        UInt32, UInt32, UInt32,        // target, eventType, edge
        Double, Double                 // NSSize.width, NSSize.height
    ) -> UnsafeMutableRawPointer?
    // IndigoHIDMessageForHIDArbitrary — iOS 26 signature
    //   (target, page, usage, operation) — NO timestamp.
    // operation 1=down, 2=up.
    private typealias HIDArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias ButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias ScrollFn = @convention(c) (UInt32, Double, Double, Double) -> UnsafeMutableRawPointer?
    private typealias ServiceFn = @convention(c) () -> UnsafeMutableRawPointer?

    private var mouseFn: MouseFn?
    private var mouseEdgeFn: MouseEdgeFn?
    private var buttonFn: ButtonFn?
    private var hidArbFn: HIDArbitraryFn?
    private var scrollFn: ScrollFn?
    private var createPointerSvc: ServiceFn?
    private var createMouseSvc: ServiceFn?
    private var removePointerSvc: ServiceFn?

    // Wire constants (baguette, verbatim).
    private static let nsEventDown:    UInt32 = 1
    private static let nsEventUp:      UInt32 = 2
    private static let nsEventDragged: UInt32 = 6
    private static let dirDown: UInt32 = 1
    private static let dirMove: UInt32 = 0
    private static let dirUp:   UInt32 = 2

    init(udid: String, discovery: SimulatorResolving) {
        self.udid = udid
        self.discovery = discovery
    }

    deinit {
        // Release the pointer service on teardown; the digitizer stays
        // registered (baguette's lesson: the host still uses the display).
        guard warmed, let client else { return }
        if let remove = removePointerSvc, let msg = remove() {
            Self.send(message: msg, to: client)
        }
    }

    // MARK: - InputSurface

    func tap(at point: Point, size: Size, duration: Double) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm() else { return false }
        let normalised = CGPoint(x: clamp01(point.x / size.width),
                                 y: clamp01(point.y / size.height))
        return IOHIDDigitizerDispatch.tap(
            point: normalised,
            holdSeconds: duration > 0 ? duration : 0.05,
            edge: .none, identifier: identifiers.current(for: .down),
            target: touchTarget, on: c
        )
    }

    func swipe(from start: Point, to end: Point, size: Size, duration: Double) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm() else { return false }
        let total = duration > 0 ? duration : 0.25
        let steps = 10
        let stepMs = UInt32((total * 1000) / Double(steps + 2))
        let normStart = CGPoint(x: clamp01(start.x / size.width),
                                y: clamp01(start.y / size.height))
        let normEnd = CGPoint(x: clamp01(end.x / size.width),
                              y: clamp01(end.y / size.height))
        return IOHIDDigitizerDispatch.swipe(
            from: normStart, to: normEnd,
            steps: steps, stepMs: max(8, stepMs),
            edge: .none, identifier: identifiers.current(for: .down),
            target: touchTarget, on: c
        )
    }

    func touch1(phase: TouchPhase, at point: Point, size: Size,
                edge: DeviceEdge?) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm() else { return false }
        let dispatchPhase: IOHIDDigitizerDispatch.Phase
        switch phase {
        case .down: dispatchPhase = .down
        case .move: dispatchPhase = .move
        case .up:   dispatchPhase = .up
        }
        let normalised = CGPoint(x: clamp01(point.x / size.width),
                                 y: clamp01(point.y / size.height))
        let id = identifiers.current(for: phase)
        let dispatchEdge: IOHIDDigitizerDispatch.Edge
        switch edge {
        case .left:   dispatchEdge = .left
        case .top:    dispatchEdge = .top
        case .right:  dispatchEdge = .right
        case .bottom: dispatchEdge = .bottom
        case nil:     dispatchEdge = .none
        }
        return IOHIDDigitizerDispatch.send(
            point: normalised, identifier: id,
            phase: dispatchPhase, edge: dispatchEdge,
            target: touchTarget, on: c
        )
    }

    func touch2(phase: TouchPhase, first: Point, second: Point, size: Size) -> Bool {
        // Two-finger streaming stays on the legacy 9-arg mouse path —
        // coincident-finger streaming the digitizer recipe doesn't model.
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm() else { return false }
        let (et, dir) = mouseEvent(for: phase)
        return sendMouse(client: c, p1: first, p2: second, eventType: et, direction: dir, size: size)
    }

    func button(_ button: DeviceButton, duration: Double) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm() else { return false }
        let holdUs = holdMicroseconds(for: duration)
        switch button {
        case .home, .lock:
            return pressLegacyButton(button, holdUs: holdUs, on: c)
        case .power, .volumeUp, .volumeDown, .action,
             .digitalCrown, .sideButton, .leftSideButton:
            guard let usage = button.standardHIDUsage else { return false }
            return pressArbitraryHID(button, usage: usage, holdUs: holdUs, on: c)
        case .appSwitcher:
            // Two consecutive home presses ~150 ms apart. SpringBoard
            // listens to the home event source regardless of physical
            // button presence (works on Face ID iPhones). Matches idb's
            // app-switcher path.
            let downA = pressLegacyButton(.home, holdUs: holdUs, on: c)
            usleep(150_000)
            let downB = pressLegacyButton(.home, holdUs: holdUs, on: c)
            return downA && downB
        case .swipeToAppSwitcher:
            // Slow edge-flagged drag from the home indicator with a long
            // dwell at the midpoint: 30 steps × 35 ms + 900 ms dwell at
            // y=0.58 fires the cards (baguette's empirical recipe).
            return IOHIDDigitizerDispatch.swipe(
                from: CGPoint(x: 0.5, y: 0.998),
                to:   CGPoint(x: 0.5, y: 0.58),
                steps: 30, stepMs: 35, dwellMs: 900,
                edge: .bottom, identifier: identifiers.current(for: .down),
                target: touchTarget, on: c
            ) ? true : false
        case .swipeToHome:
            // Fast edge-flagged flick: 12 steps × 16 ms to y=0.30.
            return IOHIDDigitizerDispatch.swipe(
                from: CGPoint(x: 0.5, y: 0.998),
                to:   CGPoint(x: 0.5, y: 0.30),
                steps: 12, stepMs: 16, dwellMs: 0,
                edge: .bottom, identifier: identifiers.current(for: .down),
                target: touchTarget, on: c
            ) ? true : false
        case .pullDownToLockScreen:
            // Slow drag from top-LEFT (camera side), edge=top → lock cover.
            return IOHIDDigitizerDispatch.swipe(
                from: CGPoint(x: 0.25, y: 0.002),
                to:   CGPoint(x: 0.25, y: 0.55),
                steps: 24, stepMs: 25, dwellMs: 0,
                edge: .top, identifier: identifiers.current(for: .down),
                target: touchTarget, on: c
            ) ? true : false
        case .pullDownToNotificationCenter:
            // Slow drag from top-RIGHT (battery/time side), edge=top → NC.
            return IOHIDDigitizerDispatch.swipe(
                from: CGPoint(x: 0.75, y: 0.002),
                to:   CGPoint(x: 0.75, y: 0.55),
                steps: 24, stepMs: 25, dwellMs: 0,
                edge: .top, identifier: identifiers.current(for: .down),
                target: touchTarget, on: c
            ) ? true : false
        }
    }

    func key(_ key: KeyboardKey, modifiers: Set<KeyModifier>, duration: Double) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let c = ensureWarm(), let kfn = hidArbFn else { return false }
        let holdUs = holdMicroseconds(for: duration)
        let target = touchTarget
        let mods = modifiers.sorted { $0.rawValue < $1.rawValue }  // deterministic order

        // Modifier-down → key-down → hold → key-up → modifier-up.
        for m in mods {
            guard let down = kfn(target, m.hidUsage.page, m.hidUsage.usage, 1) else { return false }
            Self.send(message: down, to: c)
        }
        guard let keyDown = kfn(target, key.hidUsage.page, key.hidUsage.usage, 1) else { return false }
        Self.send(message: keyDown, to: c)
        usleep(holdUs)
        guard let keyUp = kfn(target, key.hidUsage.page, key.hidUsage.usage, 2) else { return false }
        Self.send(message: keyUp, to: c)
        for m in mods.reversed() {
            guard let up = kfn(target, m.hidUsage.page, m.hidUsage.usage, 2) else { return false }
            Self.send(message: up, to: c)
        }
        return true
    }

    func scroll(deltaX: Double, deltaY: Double) -> Bool {
        guard let c = ensureWarm(), let sfn = scrollFn else { return false }
        guard let msg = sfn(touchTarget, deltaX, deltaY, 0) else { return false }
        Self.send(message: msg, to: c)
        return true
    }

    // MARK: - private

    /// Default tap 100 ms — registers without crossing into long-press.
    /// Non-zero duration (seconds) overrides; floor-clamped so a 1 ms
    /// request doesn't underrun the simulator's HID dispatch.
    private func holdMicroseconds(for duration: Double) -> UInt32 {
        guard duration > 0 else { return 100_000 }
        let us = duration * 1_000_000
        return UInt32(min(max(us, 20_000), Double(UInt32.max)))
    }

    private func mouseEvent(for phase: TouchPhase) -> (UInt32, UInt32) {
        switch phase {
        case .down: return (Self.nsEventDown, Self.dirDown)
        case .move: return (Self.nsEventDragged, Self.dirMove)
        case .up:   return (Self.nsEventUp, Self.dirUp)
        }
    }

    /// `IndigoHIDMessageForButton` arg0 + 3rd arg for the legacy home /
    /// lock path. The 3rd arg is a routing target on iOS 26.4 (0x33 =
    /// digitizer); not a timestamp.
    private func buttonCodes(for button: DeviceButton) -> (UInt32, UInt32) {
        switch button {
        case .home: return (0x0, 0x33)
        case .lock: return (0x1, 0x33)
        default:    return (0, 0)  // routed via pressArbitraryHID / gestures
        }
    }

    private func pressLegacyButton(_ button: DeviceButton, holdUs: UInt32, on client: AnyObject) -> Bool {
        guard let bfn = buttonFn else { return false }
        let (arg0, target) = buttonCodes(for: button)
        guard let down = bfn(arg0, 1, target) else { return false }
        Self.send(message: down, to: client)
        usleep(holdUs)
        // Release — direction 2; 0 crashes backboardd on iOS 26.4.
        guard let up = bfn(arg0, 2, target) else { return false }
        Self.send(message: up, to: client)
        return true
    }

    private func pressArbitraryHID(_ button: DeviceButton, usage: HIDUsage, holdUs: UInt32, on client: AnyObject) -> Bool {
        guard let kfn = hidArbFn else { return false }
        let target = touchTarget
        guard let down = kfn(target, usage.page, usage.usage, 1) else { return false }
        Self.send(message: down, to: client)
        usleep(holdUs)
        guard let up = kfn(target, usage.page, usage.usage, 2) else { return false }
        Self.send(message: up, to: client)
        return true
    }

    /// Build + dispatch one 9-arg mouse event. Retries on the 2-finger
    /// settle window — the builder returns nil for ~50 ms after a
    /// 2-finger mouseDown; 12 × 5 ms covers it.
    private func sendMouse(
        client: AnyObject,
        p1: Point, p2: Point?,
        eventType: UInt32, direction: UInt32,
        size: Size
    ) -> Bool {
        guard let mfn = mouseFn else { return false }
        let maxAttempts = (p2 != nil) ? 12 : 3
        var pt1 = CGPoint(x: clamp01(p1.x / size.width),
                          y: clamp01(p1.y / size.height))
        var msg: UnsafeMutableRawPointer?
        if let p2 {
            var pt2 = CGPoint(x: clamp01(p2.x / size.width),
                              y: clamp01(p2.y / size.height))
            for _ in 0..<maxAttempts {
                msg = withUnsafePointer(to: &pt1) { p1Ref in
                    withUnsafePointer(to: &pt2) { p2Ref in
                        mfn(p1Ref, p2Ref, touchTarget, eventType, direction, 1.0, 1.0, size.width, size.height)
                    }
                }
                if msg != nil { break }
                usleep(5_000)
            }
        } else {
            for _ in 0..<maxAttempts {
                msg = withUnsafePointer(to: &pt1) { p1Ref in
                    mfn(p1Ref, nil, touchTarget, eventType, direction, 1.0, 1.0, size.width, size.height)
                }
                if msg != nil { break }
                usleep(5_000)
            }
        }
        guard let msg else { return false }
        Self.send(message: msg, to: client)
        return true
    }

    private func clamp01(_ v: Double) -> Double {
        v < 0 ? 0 : (v > 1 ? 1 : v)
    }

    private static func send(message: UnsafeMutableRawPointer, to client: AnyObject) {
        let sel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let cls = object_getClass(client),
              let imp = class_getMethodImplementation(cls, sel) else {
            if ProcessInfo.processInfo.environment["HID_DEBUG"] != nil {
                FileHandle.standardError.write(Data("[hid] send selector missing on client\n".utf8))
            }
            return
        }
        typealias Fn = @convention(c) (
            AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?
        ) -> Void
        unsafeBitCast(imp, to: Fn.self)(client, sel, message, ObjCBool(true), nil, nil)
    }

    /// Lazy resolve + warm. Synchronised — control messages may arrive
    /// while a warm-up is in flight.
    private func ensureWarm() -> AnyObject? {
        lock.lock()
        defer { lock.unlock() }
        if let client { return client }

        resolveFunctions()
        guard let device = discovery.resolveDevice(udid: udid) else { return nil }
        guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
            FileHandle.standardError.write(Data("HIDInput: SimDeviceLegacyHIDClient class not found\n".utf8))
            return nil
        }
        let initSel = NSSelectorFromString("initWithDevice:error:")
        guard let imp = class_getMethodImplementation(cls, initSel) else { return nil }
        typealias InitFn = @convention(c) (
            AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> AnyObject?
        let initFn = unsafeBitCast(imp, to: InitFn.self)
        guard let metaCls = object_getClass(cls) else { return nil }
        let allocSel = NSSelectorFromString("alloc")
        guard let allocImp = class_getMethodImplementation(metaCls, allocSel) else { return nil }
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject?
        let allocFn = unsafeBitCast(allocImp, to: AllocFn.self)
        guard let allocated = allocFn(cls, allocSel) else { return nil }

        var err: NSError?
        guard let c = initFn(allocated, initSel, device, &err) else {
            if let err {
                FileHandle.standardError.write(Data("HIDInput: client init failed: \(err)\n".utf8))
            }
            return nil
        }
        // Fail closed: dispatching to a target no service registered
        // throws inside SimHIDVirtualServiceManager and takes backboardd
        // + SpringBoard with it. A refused gesture beats a dead simulator.
        guard warmServices(on: c) else {
            FileHandle.standardError.write(Data("HIDInput: service warm-up failed — refusing to dispatch\n".utf8))
            return nil
        }
        client = c
        warmed = true
        if ProcessInfo.processInfo.environment["HID_DEBUG"] != nil {
            FileHandle.standardError.write(Data("[hid] warm OK\n".utf8))
        }
        return c
    }

    private func resolveFunctions() {
        guard mouseFn == nil else { return }
        var handle: UnsafeMutableRawPointer?
        for candidate in SimDiscovery.simKitCandidatePaths() {
            if let h = dlopen(candidate, RTLD_NOW | RTLD_GLOBAL) { handle = h; break }
        }
        guard let handle else {
            FileHandle.standardError.write(Data("HIDInput: SimulatorKit not found\n".utf8))
            return
        }
        let mouseSym = dlsym(handle, "IndigoHIDMessageForMouseNSEvent")
        // Same C function, two Swift typedefs — 9-arg for taps/pans/
        // pinches, 7-arg real ABI for edge gestures (x4 = IndigoHIDEdge).
        mouseFn     = mouseSym.map { unsafeBitCast($0, to: MouseFn.self) }
        mouseEdgeFn = mouseSym.map { unsafeBitCast($0, to: MouseEdgeFn.self) }
        buttonFn   = dlsym(handle, "IndigoHIDMessageForButton").map { unsafeBitCast($0, to: ButtonFn.self) }
        hidArbFn   = dlsym(handle, "IndigoHIDMessageForHIDArbitrary").map { unsafeBitCast($0, to: HIDArbitraryFn.self) }
        scrollFn   = dlsym(handle, "IndigoHIDMessageForScrollEvent").map { unsafeBitCast($0, to: ScrollFn.self) }
        createPointerSvc = dlsym(handle, "IndigoHIDMessageToCreatePointerService").map { unsafeBitCast($0, to: ServiceFn.self) }
        createMouseSvc   = dlsym(handle, "IndigoHIDMessageToCreateMouseService").map { unsafeBitCast($0, to: ServiceFn.self) }
        removePointerSvc = dlsym(handle, "IndigoHIDMessageToRemovePointerService").map { unsafeBitCast($0, to: ServiceFn.self) }
    }

    /// Register the pointer + mouse services before first event.
    @discardableResult
    private func warmServices(on client: AnyObject) -> Bool {
        if let create = createPointerSvc, let msg = create() {
            Self.send(message: msg, to: client)
            usleep(20_000)
        }
        if let create = createMouseSvc, let msg = create() {
            Self.send(message: msg, to: client)
            usleep(20_000)
        }
        // Phone plane: its digitizer is part of the device — asking for a
        // second one (CarPlay path) is its own kind of wrong. Warm.
        return true
    }
}
