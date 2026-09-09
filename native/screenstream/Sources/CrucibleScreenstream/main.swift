// crucible-screenstream — first-party device stream engine for Crucible.
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
if args.dropFirst().first == "devices" {
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
