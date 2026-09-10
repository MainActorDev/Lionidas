// IOHIDDigitizerDispatch — the digitizer-event dispatch path.
// Ported 1:1 from baguette's Infrastructure/Input/IOHIDDigitizerDispatch.swift
// (Apache-2.0, attributed). The byte offsets, event-mask values, and pressure
// zero are empirical facts verified against booted iOS 26.4 — do not "fix".
//
// Xcode 26's 9-arg IndigoHIDMessageForMouseNSEvent taps get misinterpreted
// as Home gestures or silently drop. The fix: build a real IOHIDEvent
// digitizer parent + finger child, run it through
// IndigoHIDMessageForTrackpadEventFromHIDEventRef (the only *FromHIDEventRef
// wrapper that accepts digitizer events), then patch two byte slots the
// wrapper leaves uninitialised:
//   • 0x6c + 0x10c → 0x32 (IndigoHIDTouchTarget) — digitizer routing tag
//   • 0x3a/0x3b + 0xda/0xdb → edge bitmask (bottom = home indicator)
import Foundation
import ObjectiveC

/// Integrated phone digitizer target (`0x32`). Registered means safe to
/// send to: a wrong one goes to the wrong surface; only an *unregistered*
/// one throws and takes the guest down.
enum IndigoHIDTouchTarget {
    static let phone: UInt32 = 0x32
}

enum IOHIDDigitizerDispatch {
    /// Screen-edge bitmask written at byte 0x3b/0xdb of the Indigo
    /// message. Empirically derived by sweeping `edge=0..4` and
    /// diffing the produced bytes (baguette's derivation).
    enum Edge {
        case none, left, top, right, bottom

        var bit: UInt8 {
            switch self {
            case .none:   return 0x00
            case .left:   return 0x02
            case .top:    return 0x08
            case .right:  return 0x04
            case .bottom: return 0x01
            }
        }
    }

    /// Phase of a touch sequence. `down` is the initial press,
    /// `move` is a sustained-touch position update, `up` is the
    /// finger lift. Each maps to a different `IOHIDDigitizerEventMask`
    /// + range/touch flag combination.
    enum Phase {
        case down, move, up

        var eventMask: UInt32 {
            switch self {
            case .down: return 0x07  // Range | Touch | Position
            case .move: return 0x07  // sustained
            case .up:   return 0x06  // Touch | Position (lift)
            }
        }
        var range: Bool { self != .up }
        var touch: Bool { self != .up }
    }

    // MARK: - one-shot helpers

    /// Single-finger tap at `point` (normalised 0..1).
    static func tap(point: CGPoint, holdSeconds: Double,
                    edge: Edge = .none, identifier: UInt32,
                    target: UInt32 = IndigoHIDTouchTarget.phone,
                    on client: AnyObject) -> Bool {
        guard send(point: point, identifier: identifier, phase: .down,
                   edge: edge, target: target, on: client) else { return false }
        let holdUs = UInt32(max(0.02, holdSeconds) * 1_000_000)
        usleep(holdUs)
        return send(point: point, identifier: identifier, phase: .up,
                    edge: edge, target: target, on: client)
    }

    /// Continuous swipe from `start` to `end` over `steps`
    /// interpolated moves. Optional `dwellMs` holds the finger at
    /// the endpoint before lift — iOS uses dwell to discriminate
    /// Home from App Switcher when `edge == .bottom`.
    static func swipe(from start: CGPoint, to end: CGPoint,
                      steps: Int = 10, stepMs: UInt32 = 16,
                      dwellMs: UInt32 = 0,
                      edge: Edge = .none, identifier: UInt32,
                      target: UInt32 = IndigoHIDTouchTarget.phone,
                      on client: AnyObject) -> Bool {
        guard send(point: start, identifier: identifier, phase: .down,
                   edge: edge, target: target, on: client) else { return false }
        var ok = 0
        for i in 1...steps {
            usleep(stepMs * 1000)
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: start.x + (end.x - start.x) * t,
                            y: start.y + (end.y - start.y) * t)
            if send(point: p, identifier: identifier, phase: .move,
                    edge: edge, target: target, on: client) { ok += 1 }
        }
        // Hold at end so iOS picks App Switcher over Home for slow
        // drags from the bottom edge. Resending move events at the
        // same point keeps the touch alive across the recogniser's
        // decision window.
        if dwellMs > 0 {
            let pulses = max(1, Int(dwellMs / 50))
            for _ in 0..<pulses {
                _ = send(point: end, identifier: identifier, phase: .move,
                         edge: edge, target: target, on: client)
                usleep(50_000)
            }
        }
        usleep(stepMs * 1000)
        return send(point: end, identifier: identifier, phase: .up,
                    edge: edge, target: target, on: client) && ok >= steps / 2
    }

    // MARK: - core

    /// Build, patch, and dispatch one digitizer event. Returns
    /// `false` if any step fails — symbol resolution, IOHIDEvent
    /// construction, wrapper rejection, or message build.
    static func send(point: CGPoint, identifier: UInt32, phase: Phase,
                     edge: Edge,
                     target: UInt32 = IndigoHIDTouchTarget.phone,
                     on client: AnyObject) -> Bool {
        guard ensureSymbols() else { return false }
        guard let parent = makeDigitizerEvent(point: point,
                                              identifier: identifier,
                                              phase: phase) else { return false }
        // `parent` is a CF-typed object (IOHIDEventRef bridged through
        // takeRetainedValue); keep it alive long enough for the wrapper
        // call to copy out the data.
        let raw: UnsafeMutableRawPointer? = withExtendedLifetime(parent) {
            wrapTrackpad(event: parent)
        }
        guard let raw else { return false }
        patch(message: raw, edge: edge, target: target)
        sendMessage(raw, to: client)
        return true
    }

    // MARK: - private — IOHIDEvent construction

    /// Build a digitizer parent event with a finger child appended.
    /// Real iOS touches always arrive as parent + child IOHIDEvent
    /// pairs, never as bare finger events; without the parent the
    /// trackpad wrapper produces a 192-byte stub iOS ignores.
    private static func makeDigitizerEvent(point: CGPoint,
                                           identifier: UInt32,
                                           phase: Phase) -> CFTypeRef? {
        guard let createParent = createDigitizerFn,
              let createFinger = createFingerFn,
              let appendFn      = appendEventFn else { return nil }

        let mask = phase.eventMask
        let range = phase.range
        let touch = phase.touch
        let pressure = 0.0  // pressure non-zero crashed earlier (baguette
                            // empirical); 0.0 stays safe.
        let now = mach_absolute_time()
        let transducerFinger: UInt32 = 2  // kIOHIDDigitizerTransducerTypeFinger

        guard let parentUM = createParent(
            nil, now, transducerFinger,
            0, identifier, mask, 0,
            point.x, point.y, 0.0,
            pressure, 0.0,
            range, touch, 0
        ) else { return nil }
        let parent = parentUM.takeRetainedValue()

        guard let fingerUM = createFinger(
            nil, now,
            0, identifier, mask,
            point.x, point.y, 0.0,
            pressure, 0.0,
            range, touch, 0
        ) else { return parent }
        let finger = fingerUM.takeRetainedValue()
        appendFn(parent, finger, 0)
        return parent
    }

    /// Run the digitizer event through
    /// `IndigoHIDMessageForTrackpadEventFromHIDEventRef`. The wrapper
    /// accepts digitizer-typed events (unlike the pointer/scroll
    /// variants) and produces a 384-byte two-record message at the
    /// correct layout.
    private static func wrapTrackpad(event: CFTypeRef) -> UnsafeMutableRawPointer? {
        guard let wrapFn = trackpadWrapFn else { return nil }
        let raw = Unmanaged.passUnretained(event as AnyObject).toOpaque()
        return wrapFn(raw)
    }

    /// Patch the byte slots the trackpad wrapper leaves uninitialised.
    /// Both target records must be set for iOS to consume the touch.
    static func patch(message msg: UnsafeMutableRawPointer, edge: Edge,
                      target: UInt32 = IndigoHIDTouchTarget.phone) {
        msg.storeBytes(of: target, toByteOffset: 0x6c, as: UInt32.self)
        let size = malloc_size(msg)
        if size >= 0x110 {
            msg.storeBytes(of: target, toByteOffset: 0x10c, as: UInt32.self)
        }
        let edgeBit = edge.bit
        let edgePresent: UInt8 = edgeBit == 0 ? 0 : 0x04
        msg.storeBytes(of: edgePresent, toByteOffset: 0x3a, as: UInt8.self)
        msg.storeBytes(of: edgeBit,     toByteOffset: 0x3b, as: UInt8.self)
        if size >= 0xdc {
            msg.storeBytes(of: edgePresent, toByteOffset: 0xda, as: UInt8.self)
            msg.storeBytes(of: edgeBit,     toByteOffset: 0xdb, as: UInt8.self)
        }
    }

    /// Dispatch the patched message via `SimDeviceLegacyHIDClient.send`.
    private static func sendMessage(_ message: UnsafeMutableRawPointer, to client: AnyObject) {
        let sel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let cls = object_getClass(client),
              let imp = class_getMethodImplementation(cls, sel) else { return }
        typealias Fn = @convention(c) (
            AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?
        ) -> Void
        unsafeBitCast(imp, to: Fn.self)(client, sel, message, ObjCBool(true), nil, nil)
    }

    // MARK: - private — symbol resolution

    /// `IOHIDEventCreateDigitizerEvent(allocator, ts, transducer,
    ///   index, identifier, eventMask, buttonMask, x, y, z,
    ///   tipPressure, barrelPressure, range, touch, options)`.
    typealias CreateDigitizerFn = @convention(c) (
        CFAllocator?, UInt64, UInt32,
        UInt32, UInt32, UInt32, UInt32,
        Double, Double, Double, Double, Double,
        Bool, Bool, UInt32
    ) -> Unmanaged<CFTypeRef>?

    /// `IOHIDEventCreateDigitizerFingerEvent(allocator, ts, index,
    ///   identifier, eventMask, x, y, z, tipPressure, twist,
    ///   range, touch, options)`.
    typealias CreateFingerFn = @convention(c) (
        CFAllocator?, UInt64,
        UInt32, UInt32, UInt32,
        Double, Double, Double, Double, Double,
        Bool, Bool, UInt32
    ) -> Unmanaged<CFTypeRef>?

    typealias AppendEventFn = @convention(c) (CFTypeRef, CFTypeRef, UInt32) -> Void
    typealias TrackpadWrapFn = @convention(c) (UnsafeRawPointer) -> UnsafeMutableRawPointer?

    // Write-once function pointers cached on first dispatch;
    // effectively-immutable, no lock (baguette's rationale).
    nonisolated(unsafe) private static var createDigitizerFn: CreateDigitizerFn?
    nonisolated(unsafe) private static var createFingerFn:    CreateFingerFn?
    nonisolated(unsafe) private static var appendEventFn:     AppendEventFn?
    nonisolated(unsafe) private static var trackpadWrapFn:    TrackpadWrapFn?
    nonisolated(unsafe) private static var symbolsResolved = false

    /// Lazy one-time resolve. IOKit symbols live in the dyld shared
    /// cache — RTLD_DEFAULT suffices. The trackpad wrapper requires
    /// dlopen-ing SimulatorKit explicitly (our SimDiscovery already
    /// loads the same framework; the handle here is independent).
    private static func ensureSymbols() -> Bool {
        if symbolsResolved { return true }
        guard let kit = Self.simulatorKitHandle() else { return false }
        let dyld = UnsafeMutableRawPointer(bitPattern: -2)
        guard let pCreateDig = dlsym(dyld, "IOHIDEventCreateDigitizerEvent"),
              let pCreateFin = dlsym(dyld, "IOHIDEventCreateDigitizerFingerEvent"),
              let pAppend    = dlsym(dyld, "IOHIDEventAppendEvent"),
              let pWrap      = dlsym(kit,  "IndigoHIDMessageForTrackpadEventFromHIDEventRef")
        else { return false }
        createDigitizerFn = unsafeBitCast(pCreateDig, to: CreateDigitizerFn.self)
        createFingerFn    = unsafeBitCast(pCreateFin, to: CreateFingerFn.self)
        appendEventFn     = unsafeBitCast(pAppend,    to: AppendEventFn.self)
        trackpadWrapFn    = unsafeBitCast(pWrap,      to: TrackpadWrapFn.self)
        symbolsResolved = true
        return true
    }

    private static func simulatorKitHandle() -> UnsafeMutableRawPointer? {
        // Reuse SimDiscovery's candidate paths; first dlopen wins and
        // returns the same handle SimDiscovery already loaded.
        for candidate in SimDiscovery.simKitCandidatePaths() {
            if let h = dlopen(candidate, RTLD_NOW | RTLD_GLOBAL) { return h }
        }
        return nil
    }
}
