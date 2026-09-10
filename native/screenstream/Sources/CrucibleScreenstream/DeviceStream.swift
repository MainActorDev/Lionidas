// DeviceStream — one device's full pipeline: Screen composites → Scaler →
// H264 (+ Seed on first frame) → tagged envelopes fanned out to sessions.
// Also owns the per-device config (fps/bitrate/scale) and the run hold.
import Foundation
import IOSurface

final class DeviceStream: ScreenDelegate, @unchecked Sendable {
    struct Config: Equatable {
        var fps: Int
        var bitrateBps: Int
        var scale: Int
        // scale=2: encode at 642x1389 — the wall canvas displays at ~320-640px
        // wide; halving the frame QUADRUPLES bits-per-pixel where small text
        // lives. (Control channel: set_scale can raise it back to 1.)
        static let `default` = Config(fps: 30, bitrateBps: 24_000_000, scale: 2)
    }

    let udid: String
    private let screen: Screen
    private let scaler = Scaler()
    private let seed = Seed()
    private var encoder: H264
    private(set) var config: Config
    private var held = false                       // run hold: composites not encoded
    private var pendingSeed = true                 // first frame ships a JPEG seed
    /// Late-joiner recovery: a NEW viewer on a shared stream must not decode
    /// mid-GOP deltas. Each subscribe re-arms seed + IDR so the next composite
    /// repaints from a clean reference. (DeviceStream encodes once; the IDR is
    /// simply the next encode — every session receives it through fan-out.)
    var onViewerJoined: (() -> Void)?
    private var pendingForceKeyframe = true
    private let queue = DispatchQueue(label: "crucible.devicestream", qos: .userInteractive)

    /// sessions enqueue tagged frames through this sink (set by the server)
    var onFrame: (@Sendable (Data) -> Void)?

    /// sim died mid-stream (shutdown/crash while clients attached). Set by the
    /// server; DeviceStream is already stopped when this fires.
    var onDeath: (@Sendable () -> Void)?

    private let discovery: SimulatorResolving

    init(udid: String, discovery: SimulatorResolving, config: Config = .default) throws {
        self.udid = udid
        self.discovery = discovery
        self.config = config
        self.encoder = H264(fps: config.fps, bitrate: config.bitrateBps)
        self.screen = Screen(udid: udid, discovery: discovery)
        screen.delegate = self
        encoder.onEncoded = { [weak self] encoded in
            guard let self else { return }
            if let d = encoded.description {
                self.onFrame?(Envelope.description(avcC: d))
            }
            switch encoded.kind {
            case .keyframe: self.onFrame?(Envelope.keyframe(avcc: encoded.avcc))
            case .delta:    self.onFrame?(Envelope.delta(avcc: encoded.avcc))
            }
        }
        try screen.start()
    }

    func stop() {
        screen.stop()
        encoder.invalidate()
    }

    /// Logical screen size in POINTS for input normalisation. Derived from
    /// the device type's profile.plist (mainScreen{Width,Height}/Scale) —
    /// the framebuffer's pixel dims vary with scale; HID wants points.
    var logicalSize: Size {
        guard let name = discovery.deviceTypeName(udid: udid),
              let chromes = Self.sharedChromesForSize,
              let profile = try? chromes.profileFor(deviceName: name)
        else { return Size(width: 428, height: 926) }   // iPhone-default fallback
        return profile
    }

    /// Input surface — lazily warmed on first gesture (device already
    /// resolved through the same discovery).
    private(set) lazy var input: HIDInput = HIDInput(udid: udid, discovery: discovery)

    /// Device-level input grant: the server grants while a driving session
    /// owns the device. Per-DEVICE (not per-socket): the server's control
    /// socket and the browser's direct stream socket are different
    /// connections; the grant must cover whichever carries input.
    var inputGranted = false

    nonisolated(unsafe) private static var sharedChromesForSize: Chromes? = Chromes()

    func setClientCount(_ n: Int) { screen.setClientCount(n) }

    // MARK: control channel

    func apply(_ new: Config) {
        config = new
        encoder.setFps(new.fps)
        encoder.setBitrate(new.bitrateBps)
        pendingForceKeyframe = true  // scale/fps changes corrupt the timeline
    }

    func runPause() {
        queue.async { self.held = true }
    }

    func runResume() {
        queue.async {
            self.held = false
            self.pendingForceKeyframe = true  // clean IDR on the way back
        }
    }

    /// Client-side recovery hook: next encode is a clean IDR, hold state untouched.
    func forceIDR() {
        queue.async { self.pendingForceKeyframe = true }
    }

    /// A viewer (re)joined: repaint contract — seed for instant paint, IDR for
    /// a clean decode reference. Idempotent when several viewers join at once.
    func viewerJoined() {
        queue.async {
            self.pendingSeed = true
            self.pendingForceKeyframe = true
        }
    }

    // MARK: ScreenDelegate

    func screen(_ screen: Screen, didComposite surface: IOSurface) {
        queue.async { [weak self] in
            guard let self, !self.held else { return }
            guard let pb = self.scaler.scale(surface, divisor: self.config.scale) else { return }
            if self.pendingSeed {
                self.pendingSeed = false
                if let jpeg = self.seed.encode(pb) {
                    self.onFrame?(Envelope.seed(jpeg: jpeg))
                }
            }
            let force = self.pendingForceKeyframe
            self.pendingForceKeyframe = false
            self.encoder.encode(pb, forceKeyframe: force)
        }
    }

    func screenDidDie(_ screen: Screen) {
        onDeath?()
    }
}
