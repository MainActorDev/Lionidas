// SimDiscovery — resolve a booted simulator's SimDevice object via the
// private CoreSimulator service context. Follows baguette's CoreSimulators
// recipe (Apache-2.0, attributed). The ObjC-runtime dance is the irreducible
// part; everything around it is typed and testable via the protocol seam.
import Foundation
import ObjectiveC

protocol SimulatorResolving: AnyObject {
    func resolveDevice(udid: String) -> NSObject?
}

final class SimDiscovery: SimulatorResolving {
    private let deviceSetPath: String?

    init(deviceSetPath: String? = nil) {
        self.deviceSetPath = deviceSetPath
        Self.loadFrameworks()
    }

    /// Private frameworks aren't linked at build time — dlopen them
    /// (baguette's loader recipe, Apache-2.0, attributed): CoreSimulator
    /// lives in a system path; SimulatorKit inside the active Xcode.
    private static let loadLock = NSLock()
    private nonisolated(unsafe) static var loaded = false
    private static func loadFrameworks() {
        loadLock.lock(); defer { loadLock.unlock() }
        guard !loaded else { return }
        loaded = true
        let coreSim = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
        if dlopen(coreSim, RTLD_NOW | RTLD_GLOBAL) == nil {
            FileHandle.standardError.write(Data("CoreSimulator load failed\n".utf8))
        }
        var simKitLoaded = false
        for candidate in Self.simKitCandidates() {
            if dlopen(candidate, RTLD_NOW | RTLD_GLOBAL) != nil { simKitLoaded = true; break }
        }
        if !simKitLoaded {
            FileHandle.standardError.write(Data("SimulatorKit not found in any candidate path\n".utf8))
        }
    }

    private static func simKitCandidates() -> [String] {
        var out: [String] = []
        if let dev = self.developerDir() {
            out.append("\(dev)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
            out.append("\(dev)/Library/PrivateFrameworks/SimulatorKit.framework")
            out.append("\(dev)/../Frameworks/SimulatorKit.framework")
        }
        out.append("/Library/Developer/PrivateFrameworks/SimulatorKit.framework")
        return out
    }

    private static func developerDir() -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        proc.arguments = ["-p"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        try? proc.run()
        proc.waitUntilExit()
        let s = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty == false) ? s : nil
    }

    func resolveDevice(udid: String) -> NSObject? {
        guard let set = resolveSet() else {
            FileHandle.standardError.write(Data("[discovery] resolveSet=nil\n".utf8))
            return nil
        }
        for device in availableDevices(in: set) {
            let du = (device.value(forKey: "UDID") as? NSUUID)?.uuidString
                 ?? (device.value(forKey: "UDID") as? NSString) as String?
            if du == udid { return device }
        }
        FileHandle.standardError.write(Data("[discovery] device not in set (udid=\(udid))\n".utf8))
        return nil
    }

    /// deviceType.name → "iPhone 14 Plus" — the .simdevicetype bundle
    /// filename, stable across simctl clone/rename (device.name is not).
    /// Falls back to the user-given name for devices with no type handle.
    func deviceTypeName(udid: String) -> String? {
        guard let device = resolveDevice(udid: udid) else { return nil }
        if let type = device.value(forKey: "deviceType") as? NSObject,
           let name = type.value(forKey: "name") as? String {
            return name
        }
        return device.value(forKey: "name") as? String
    }

    func bootedUdids() -> [String] {
        guard let set = resolveSet() else {
            FileHandle.standardError.write(Data("[booted] no set\n".utf8))
            return []
        }
        let all = availableDevices(in: set)
        FileHandle.standardError.write(Data("[booted] set=\(type(of: set)) devices=\(all.count)\n".utf8))
        for d in all {
            let udid = (d.value(forKey: "UDID") as? NSUUID)?.uuidString ?? "?"
            let state = d.value(forKey: "state") ?? "nil-state"
            FileHandle.standardError.write(Data("[booted] \(udid) state=\(state)\n".utf8))
        }
        return all.compactMap { d in
            let state = d.value(forKey: "state")
            let booted = (state as? String) == "Booted" || (state as? NSNumber)?.intValue == 3
            guard booted else { return nil }
            return (d.value(forKey: "UDID") as? NSUUID)?.uuidString
        }
    }

    // MARK: - private (irreducible ObjC-runtime calls)

    private func resolveSet() -> NSObject? {
        guard let ctx = sharedServiceContext() else {
            FileHandle.standardError.write(Data("[set] no service context\n".utf8))
            return nil
        }
        if let path = deviceSetPath {
            let sel = NSSelectorFromString("deviceSetWithPath:error:")
            guard let set = ctx.perform(sel, with: path as NSString)?.takeUnretainedValue() as? NSObject
            else { return defaultDeviceSet(context: ctx) }
            return set
        }
        return defaultDeviceSet(context: ctx)
    }

    private func sharedServiceContext() -> NSObject? {
        guard let cls = NSClassFromString("SimServiceContext") else { return nil }
        let sel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        var err: NSError?
        guard let metaCls = object_getClass(cls),
              let imp = class_getMethodImplementation(metaCls, sel)
        else { return nil }
        typealias Fn = @convention(c) (
            AnyClass, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>?
        ) -> AnyObject?
        let ctx = unsafeBitCast(imp, to: Fn.self)(cls, sel, developerDir() as NSString, &err) as? NSObject
        FileHandle.standardError.write(Data("[ctx] type=\(ctx.map { String(describing: type(of: $0)) } ?? "nil") err=\(err.map {"\($0)"} ?? "none")\n".utf8))
        if ctx == nil, let err {
            FileHandle.standardError.write(Data("sharedServiceContext: \(err)\n".utf8))
        }
        return ctx
    }

    private func defaultDeviceSet(context: NSObject) -> NSObject? {
        // IMP-cast unconditionally — responds(to:) lies for some private
        // methods on newer CoreSimulator builds (observed on Xcode 26.4).
        let sel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let imp = class_getMethodImplementation(type(of: context), sel) else {
            FileHandle.standardError.write(Data("[set] no IMP for defaultDeviceSetWithError:\n".utf8))
            return nil
        }
        var err: NSError?
        typealias Fn = @convention(c) (
            AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?
        ) -> AnyObject?
        let set = unsafeBitCast(imp, to: Fn.self)(context, sel, &err) as? NSObject
        if let set { return set }
        FileHandle.standardError.write(Data("[set] defaultDeviceSetWithError -> nil err=\(err.map {"\($0)"} ?? "none")\n".utf8))
        return nil
    }

    private func availableDevices(in set: NSObject) -> [NSObject] {
        guard let available = set.value(forKey: "availableDevices") as? [NSObject] else { return [] }
        return available
    }

    private func developerDir() -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        proc.arguments = ["-p"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        try? proc.run()
        proc.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "/Applications/Xcode.app/Contents/Developer"
    }
}
