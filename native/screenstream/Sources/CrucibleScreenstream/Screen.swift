// Screen — SimulatorKit framebuffer callbacks → IOSurface per composite.
//
// Follows baguette's SimulatorKitScreen recipe (Apache-2.0, attributed):
// SimDevice.io → deviceIOPorts → com.apple.framebuffer.display descriptors →
// registerScreenCallbacksWithUUID:callbackQueue:frameCallback:... — the
// private-API heart of the engine. Multi-descriptor surfaces picked by
// largest area (baguette's default policy). Includes the stall watchdog:
// composites gone quiet for >5s with a live client → rewire callbacks.
import Foundation
import IOSurface
import ObjectiveC

protocol ScreenDelegate: AnyObject {
    func screen(_ screen: Screen, didComposite surface: IOSurface)
}

final class Screen: @unchecked Sendable {
    enum ScreenError: Error, CustomStringConvertible {
        case notFound(udid: String)
        case ioUnavailable
        case noFramebuffer
        case callbackUnavailable

        var description: String {
            switch self {
            case .notFound(let udid): return "simulator not found: \(udid)"
            case .ioUnavailable: return "SimDevice.io unavailable"
            case .noFramebuffer: return "no framebuffer.display descriptor"
            case .callbackUnavailable: return "screen callback selector unavailable"
            }
        }
    }

    weak var delegate: ScreenDelegate?

    private let udid: String
    private let discovery: SimulatorResolving
    private let queue = DispatchQueue(label: "crucible.screen", qos: .userInteractive)
    private var device: NSObject?
    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: NSUUID] = [:]
    private var pending = false
    private(set) var lastCompositeAt = Date.distantPast
    private var watchdog: DispatchSourceTimer?
    private var clientCount = 0  // set by the server; 0 = nobody watching, watchdog idles

    init(udid: String, discovery: SimulatorResolving) {
        self.udid = udid
        self.discovery = discovery
    }

    func start() throws {
        guard let device = discovery.resolveDevice(udid: udid) else {
            throw ScreenError.notFound(udid: udid)
        }
        self.device = device
        guard let io = device.perform(NSSelectorFromString("io"))?
            .takeUnretainedValue() as? NSObject
        else { throw ScreenError.ioUnavailable }

        var candidates = findFramebufferDescriptors(io: io)
        if candidates.isEmpty {
            io.perform(NSSelectorFromString("updateIOPorts"))
            candidates = findFramebufferDescriptors(io: io)
        }
        guard !candidates.isEmpty else { throw ScreenError.noFramebuffer }
        descriptors = candidates
        for desc in candidates { try registerCallbacks(on: desc) }
        queue.async { [weak self] in self?.scheduleCapture() }
        startWatchdog()
    }

    func stop() {
        watchdog?.cancel(); watchdog = nil
        let unreg = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
        for desc in descriptors {
            if let uuid = callbackUUIDs[ObjectIdentifier(desc)], desc.responds(to: unreg) {
                _ = desc.perform(unreg, with: uuid)
            }
        }
        descriptors = []
        callbackUUIDs.removeAll()
        device = nil
    }

    func setClientCount(_ n: Int) { queue.async { self.clientCount = n } }

    // MARK: - private

    /// Coalesce composite notifications: one in-flight capture at a time —
    /// the framebuffer mutates per composite; overlapping reads race.
    fileprivate func scheduleCapture() {
        guard !pending else {
            return
        }
        pending = true
        defer { pending = false }
        lastCompositeAt = Date()
        guard let surface = largestSurface() else { return }
        delegate?.screen(self, didComposite: surface)
    }

    private func largestSurface() -> IOSurface? {
        var best: IOSurface?
        var bestArea = 0
        let sel = NSSelectorFromString("framebufferSurface")
        for desc in descriptors where desc.responds(to: sel) {
            guard let surf = desc.perform(sel)?.takeUnretainedValue() as? IOSurface else { continue }
            let area = IOSurfaceGetWidth(surf) * IOSurfaceGetHeight(surf)
            if area > bestArea { bestArea = area; best = surf }
        }
        return best
    }

    private func findFramebufferDescriptors(io: NSObject) -> [NSObject] {
        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else { return [] }
        let pidSel = NSSelectorFromString("portIdentifier")
        let descSel = NSSelectorFromString("descriptor")
        let surfSel = NSSelectorFromString("framebufferSurface")
        var out: [NSObject] = []
        for port in ports where port.responds(to: pidSel) {
            guard let pid = port.perform(pidSel)?.takeUnretainedValue(),
                  "\(pid)" == "com.apple.framebuffer.display",
                  port.responds(to: descSel),
                  let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject,
                  desc.responds(to: surfSel)
            else { continue }
            out.append(desc)
        }
        return out
    }

    private func registerCallbacks(on desc: NSObject) throws {
        let regSel = NSSelectorFromString(
            "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:" +
            "surfacesChangedCallback:propertiesChangedCallback:"
        )
        guard desc.responds(to: regSel) else { throw ScreenError.callbackUnavailable }

        let uuid = NSUUID()
        callbackUUIDs[ObjectIdentifier(desc)] = uuid

        let frame: @convention(block) () -> Void = { [weak self] in
            self?.queue.async { self?.scheduleCapture() }
        }
        let surfaces: @convention(block) () -> Void = { [weak self] in
            self?.queue.async { self?.scheduleCapture() }
        }
        let props: @convention(block) () -> Void = {}

        guard let imp = class_getMethodImplementation(type(of: desc), regSel) else {
            throw ScreenError.callbackUnavailable
        }
        typealias Fn = @convention(c) (
            AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject
        ) -> Void
        unsafeBitCast(imp, to: Fn.self)(
            desc, regSel,
            uuid, queue as AnyObject,
            frame as AnyObject, surfaces as AnyObject, props as AnyObject
        )
    }

    // MARK: stall watchdog — the robustness fold

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: .seconds(5))
        timer.setEventHandler { [weak self] in
            guard let self, self.clientCount > 0 else { return }
            let quiet = Date().timeIntervalSince(self.lastCompositeAt)
            if quiet > 10 {
                // composites stalled with a live client — rewire the callbacks
                // (the wedged-instance class dies here, not in a supervisor)
                FileHandle.standardError.write(Data("Screen: composite stall (\(Int(quiet))s) — rewiring\n".utf8))
                self.stop()
                try? self.start()
            }
        }
        timer.resume()
        watchdog = timer
    }
}
