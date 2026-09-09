// DeviceChrome — bezel + button layout from Apple's DeviceKit chrome.json.
// Parsing follows baguette's DeviceChrome recipe (Apache-2.0, attributed).
import Foundation

struct DeviceChrome: Equatable, Sendable {
    let identifier: String
    /// Screen cutout insets in chrome-px (chrome.json `images.sizing`).
    let screenInsets: Insets
    /// Outer body corner radius (chrome.json `paths.simpleOutsideBorder.cornerRadiusX`).
    let outerCornerRadius: Double
    let buttons: [ChromeButton]
    /// Baked composite PDF name when the bundle ships one; nil = 9-slice only
    /// (every phone5-and-later iPhone).
    let compositeImageName: String?
    /// 9-slice piece names; all-or-nothing.
    let slice: DeviceChromeSlice?
    /// Authoritative canvas margin around the composite for button overshoot
    /// (`images.devicePadding`). Never inferred from button geometry.
    let devicePadding: Insets

    init(
        identifier: String,
        screenInsets: Insets,
        outerCornerRadius: Double,
        buttons: [ChromeButton],
        compositeImageName: String?,
        slice: DeviceChromeSlice? = nil,
        devicePadding: Insets = .zero
    ) {
        self.identifier = identifier
        self.screenInsets = screenInsets
        self.outerCornerRadius = outerCornerRadius
        self.buttons = buttons
        self.compositeImageName = compositeImageName
        self.slice = slice
        self.devicePadding = devicePadding
    }

    var bezelWidth: Double { max(screenInsets.left, screenInsets.top) }

    /// Screen cutout radius = outer − bezel width, floored at 0.
    var innerCornerRadius: Double { max(outerCornerRadius - bezelWidth, 0) }

    /// Screen rect inside a composite of the given size (pre-devicePadding
    /// space; consumers shift by devicePadding themselves).
    func screenRect(in compositeSize: Size) -> Rect {
        Rect(
            origin: Point(x: screenInsets.left, y: screenInsets.top),
            size: Size(
                width: compositeSize.width - screenInsets.left - screenInsets.right,
                height: compositeSize.height - screenInsets.top - screenInsets.bottom
            )
        )
    }

    static func parsing(json data: Data) throws -> DeviceChrome {
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw DeviceChromeParseError.malformedJSON
        }
        guard let dict = raw as? [String: Any] else {
            throw DeviceChromeParseError.malformedJSON
        }
        guard let fullID = dict["identifier"] as? String else {
            throw DeviceChromeParseError.missingIdentifier
        }

        let prefix = "com.apple.dt.devicekit.chrome."
        let identifier = fullID.hasPrefix(prefix)
            ? String(fullID.dropFirst(prefix.count))
            : fullID

        let images = dict["images"] as? [String: Any] ?? [:]
        let sizing = images["sizing"] as? [String: Any] ?? [:]
        let insets = Insets(
            top:    coerceDouble(sizing["topHeight"]),
            left:   coerceDouble(sizing["leftWidth"]),
            bottom: coerceDouble(sizing["bottomHeight"]),
            right:  coerceDouble(sizing["rightWidth"])
        )

        let paths = dict["paths"] as? [String: Any] ?? [:]
        let border = paths["simpleOutsideBorder"] as? [String: Any] ?? [:]
        let outerRadius = coerceDouble(border["cornerRadiusX"])

        let inputs = dict["inputs"] as? [[String: Any]] ?? []
        let buttons = inputs.compactMap(ChromeButton.init(json:))

        let padding = images["devicePadding"] as? [String: Any] ?? [:]
        let devicePadding = Insets(
            top:    coerceDouble(padding["top"]),
            left:   coerceDouble(padding["left"]),
            bottom: coerceDouble(padding["bottom"]),
            right:  coerceDouble(padding["right"])
        )

        return DeviceChrome(
            identifier: identifier,
            screenInsets: insets,
            outerCornerRadius: outerRadius,
            buttons: buttons,
            compositeImageName: images["composite"] as? String,
            slice: DeviceChromeSlice(json: images),
            devicePadding: devicePadding
        )
    }
}

/// Nine PDF asset names composing a bezel when no baked composite exists.
struct DeviceChromeSlice: Equatable, Sendable {
    let topLeft: String
    let top: String
    let topRight: String
    let right: String
    let bottomRight: String
    let bottom: String
    let bottomLeft: String
    let left: String
    let screen: String

    init(
        topLeft: String, top: String, topRight: String,
        right: String,
        bottomRight: String, bottom: String, bottomLeft: String,
        left: String,
        screen: String
    ) {
        self.topLeft = topLeft
        self.top = top
        self.topRight = topRight
        self.right = right
        self.bottomRight = bottomRight
        self.bottom = bottom
        self.bottomLeft = bottomLeft
        self.left = left
        self.screen = screen
    }

    /// All-or-nothing: a partial bundle can't produce a half-drawn bezel.
    init?(json images: [String: Any]) {
        guard
            let topLeft = images["topLeft"] as? String,
            let top = images["top"] as? String,
            let topRight = images["topRight"] as? String,
            let right = images["right"] as? String,
            let bottomRight = images["bottomRight"] as? String,
            let bottom = images["bottom"] as? String,
            let bottomLeft = images["bottomLeft"] as? String,
            let left = images["left"] as? String,
            let screen = images["screen"] as? String
        else { return nil }

        self.init(
            topLeft: topLeft, top: top, topRight: topRight,
            right: right,
            bottomRight: bottomRight, bottom: bottom, bottomLeft: bottomLeft,
            left: left,
            screen: screen
        )
    }
}

/// One hardware button overlaid on the device body.
struct ChromeButton: Equatable, Sendable {
    enum Anchor: String, Sendable, Equatable { case left, right, top, bottom }
    enum Align: String, Sendable, Equatable { case leading, trailing }

    let name: String
    let imageName: String
    let imageDownName: String?
    let imageDownDrawMode: String?
    let anchor: Anchor
    let align: Align
    /// `offsets.normal` — the HOVER position (cap popped past the rail).
    let normalOffset: Point
    /// `offsets.rollover` — pairs with normal for the hover animation.
    let rolloverOffset: Point
    /// z-order: false = behind the composite (iPhone caps), true = on top
    /// (watch action button).
    let onTop: Bool

    init(
        name: String, imageName: String,
        imageDownName: String? = nil,
        imageDownDrawMode: String? = nil,
        anchor: Anchor, align: Align,
        normalOffset: Point,
        rolloverOffset: Point? = nil,
        onTop: Bool = false
    ) {
        self.name = name
        self.imageName = imageName
        self.imageDownName = imageDownName
        self.imageDownDrawMode = imageDownDrawMode
        self.anchor = anchor
        self.align = align
        self.normalOffset = normalOffset
        self.rolloverOffset = rolloverOffset ?? normalOffset
        self.onTop = onTop
    }

    init?(json dict: [String: Any]) {
        guard let name = dict["name"] as? String,
              let imageName = dict["image"] as? String
        else { return nil }

        let anchor = (dict["anchor"] as? String).flatMap(Anchor.init(rawValue:)) ?? .left
        let align  = (dict["align"]  as? String).flatMap(Align.init(rawValue:))  ?? .leading

        let offsets = dict["offsets"] as? [String: Any]
        let normalDict   = (offsets?["normal"]   as? [String: Any])
        let rolloverDict = (offsets?["rollover"] as? [String: Any])
        let primary = normalDict ?? rolloverDict ?? [:]
        let normal = Point(
            x: coerceDouble(primary["x"]),
            y: coerceDouble(primary["y"])
        )
        let secondary = rolloverDict ?? normalDict ?? [:]
        let rollover = Point(
            x: coerceDouble(secondary["x"]),
            y: coerceDouble(secondary["y"])
        )
        self.init(
            name: name, imageName: imageName,
            imageDownName: dict["imageDown"] as? String,
            imageDownDrawMode: dict["imageDownDrawMode"] as? String,
            anchor: anchor, align: align,
            normalOffset: normal,
            rolloverOffset: rollover,
            onTop: dict["onTop"] as? Bool ?? false
        )
    }
}

enum DeviceChromeParseError: Error, Equatable {
    case malformedJSON
    case missingIdentifier
}

/// JSONSerialization wraps every numeric in NSNumber → bridges to Double.
fileprivate func coerceDouble(_ any: Any?) -> Double {
    (any as? Double) ?? 0
}
