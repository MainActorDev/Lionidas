// DeviceProfile — what we read from a CoreSimulator device-type's
// profile.plist: the chrome bundle id for bezels and the 1x-point screen
// size for 9-slice composition. Parsing follows baguette's DeviceProfile
// recipe (Apache-2.0, attributed).
import Foundation

// Shared value types for chrome geometry (scale-1 chrome-px space).
struct Size: Equatable, Sendable {
    var width: Double; var height: Double
    static let zero = Size(width: 0, height: 0)
}
struct Point: Equatable, Sendable { var x: Double; var y: Double }
struct Rect: Equatable, Sendable { var origin: Point; var size: Size }
struct Insets: Equatable, Sendable {
    var top: Double; var left: Double; var bottom: Double; var right: Double
    static let zero = Insets(top: 0, left: 0, bottom: 0, right: 0)
}

struct DeviceProfile: Equatable, Sendable {
    /// Bare bundle name like "phone5" (prefix stripped at parse time).
    let chromeIdentifier: String
    /// Screen size in 1x points; `Screen.pdf` is a 1×1 marker so 9-slice
    /// composition needs the real numbers. `nil` when neither source
    /// carries them.
    ///
    /// Two sources: Xcode ≤26 puts mainScreen{Width,Height,Scale} on the
    /// profile; Xcode 27 moved them to capabilities.plist
    /// (`capabilities.displays[]`, `displayType == "integrated"` only —
    /// taking the first entry silently picks 720×480 tvOut).
    let screenSize: Size?

    static func parsing(
        plistData data: Data,
        capabilitiesData: Data? = nil
    ) throws -> DeviceProfile {
        let raw: Any
        do {
            raw = try PropertyListSerialization.propertyList(
                from: data, options: [], format: nil
            )
        } catch {
            throw DeviceProfileParseError.malformedPlist
        }
        guard let dict = raw as? [String: Any] else {
            throw DeviceProfileParseError.malformedPlist
        }
        guard let fullID = dict["chromeIdentifier"] as? String else {
            throw DeviceProfileParseError.missingChromeIdentifier
        }

        let prefix = "com.apple.dt.devicekit.chrome."
        let bare = fullID.hasPrefix(prefix)
            ? String(fullID.dropFirst(prefix.count))
            : fullID

        return DeviceProfile(
            chromeIdentifier: bare,
            screenSize: parseScreenSize(dict)
                ?? capabilitiesData.flatMap(parseIntegratedDisplay)
        )
    }

    /// Xcode 27's capabilities.plist → the device's own panel only.
    private static func parseIntegratedDisplay(_ data: Data) -> Size? {
        guard let raw = try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil
              ),
              let root = raw as? [String: Any],
              let capabilities = root["capabilities"] as? [String: Any],
              let displays = capabilities["displays"] as? [[String: Any]],
              let panel = displays.first(where: {
                  $0["displayType"] as? String == "integrated"
              })
        else { return nil }
        return parseDisplaySize(panel)
    }

    private static func parseDisplaySize(_ dict: [String: Any]) -> Size? {
        guard let w = dict["width"] as? Double,
              let h = dict["height"] as? Double,
              let s = dict["scale"] as? Double,
              s > 0
        else { return nil }
        return Size(width: w / s, height: h / s)
    }

    private static func parseScreenSize(_ dict: [String: Any]) -> Size? {
        guard let w = dict["mainScreenWidth"] as? Double,
              let h = dict["mainScreenHeight"] as? Double,
              let s = dict["mainScreenScale"] as? Double,
              s > 0
        else { return nil }
        return Size(width: w / s, height: h / s)
    }
}

enum DeviceProfileParseError: Error, Equatable {
    case malformedPlist
    case missingChromeIdentifier
}
