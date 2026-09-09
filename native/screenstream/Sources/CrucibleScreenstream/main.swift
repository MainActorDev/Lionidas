// crucible-screenstream — first-party device stream engine for Crucible.
// Routes: /healthz, /devices/<udid>/stream (WS), /devices/<udid>/bezel.png
// (?buttons=false for bare), /devices/<udid>/definition.json (bezel layout),
// /devices/<udid>/bezel-button/<name>.png (overlay sprites).
// Architecture follows baguette (Apache-2.0); see LICENSES/screenstream-ATTRIBUTION.md.
import Foundation

let version = "0.1.0"

let args = CommandLine.arguments
func flag(_ name: String, default def: String) -> String {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return def }
    return args[i + 1]
}

if args.contains("--version") {
    print("crucible-screenstream \(version)")
    exit(0)
}

// `devices` — debug subcommand: dump the discovery chain's view of the world.
// Existence proof for the private-API chain on THIS machine/Xcode pair.
// `device-name <udid>` — debug subcommand: resolve the device-type name
// (chrome lookup key). Used to verify bezel plumbing end-to-end.
if args.dropFirst().first == "device-name", args.count > 2 {
    let udid = args[2]
    let discovery = SimDiscovery()
    if let name = discovery.deviceTypeName(udid: udid) {
        print(name)
    } else {
        FileHandle.standardError.write(Data("device not found: \(udid)\n".utf8))
    }
    exit(0)  // CoreSimulator keeps runloop sources alive; a successful debug
             // resolve exits explicitly (same shape as the devices branch)
} else if args.dropFirst().first == "devices" {
    let d = SimDiscovery()
    let booted = d.bootedUdids()
    print("frameworks: CoreSimulator=\(NSClassFromString("SimServiceContext") != nil) " +
          "SimulatorKit=\(NSClassFromString("SimDeviceFramebufferDisplayDescriptor") != nil)")
    print("booted: \(booted.count) device(s)")
    for u in booted { print("  \(u)") }
    exit(booted.isEmpty ? 1 : 0)
}

let port = UInt16(flag("--port", default: "8440")) ?? 8440
let server = ScreenstreamServer(port: port)
server.run()
