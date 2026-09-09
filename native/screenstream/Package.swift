// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "CrucibleScreenstream",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "CrucibleScreenstream",
            path: "Sources/CrucibleScreenstream"
        ),
        .testTarget(
            name: "CrucibleScreenstreamTests",
            dependencies: ["CrucibleScreenstream"],
            path: "Tests/CrucibleScreenstreamTests"
        ),
    ]
)
