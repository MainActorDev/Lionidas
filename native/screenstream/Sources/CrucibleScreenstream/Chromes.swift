// Chromes — assembles DeviceKit chrome bundles into bezel assets:
// bare composite, merged bezel (buttons baked at rest), per-button PNGs.
// The buttonTopLeft anchor table follows baguette's LiveChromes recipe
// (Apache-2.0, attributed) — semantics verified against SimulatorKit's
// own layout constraints; each rule guards a regression class.
import Foundation
import CoreGraphics

/// Filesystem access to Apple's chrome + device-type bundles. Roots
/// injectable for tests.
struct ChromeStore {
    let deviceTypesRoot: String
    let chromeRoot: String

    init(
        deviceTypesRoot: String = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes",
        chromeRoot: String = "/Library/Developer/DeviceKit/Chrome"
    ) {
        self.deviceTypesRoot = deviceTypesRoot
        self.chromeRoot = chromeRoot
    }

    func profilePlistData(deviceName: String) throws -> Data {
        try Data(contentsOf: URL(fileURLWithPath: "\(deviceTypesRoot)/\(deviceName).simdevicetype/Contents/Resources/profile.plist"))
    }

    func capabilitiesPlistData(deviceName: String) throws -> Data {
        try Data(contentsOf: URL(fileURLWithPath: "\(deviceTypesRoot)/\(deviceName).simdevicetype/Contents/Resources/capabilities.plist"))
    }

    func chromeJSONData(chromeIdentifier: String) throws -> Data {
        try Data(contentsOf: URL(fileURLWithPath: "\(chromeRoot)/\(chromeIdentifier).devicechrome/Contents/Resources/chrome.json"))
    }

    func chromeAssetPDF(chromeIdentifier: String, imageName: String) throws -> Data {
        try Data(contentsOf: URL(fileURLWithPath: "\(chromeRoot)/\(chromeIdentifier).devicechrome/Contents/Resources/\(imageName).pdf"))
    }
}

struct DeviceChromeAssets {
    let chrome: DeviceChrome
    /// Merged bezel PNG bytes (buttons baked at rest), canvas includes
    /// devicePadding margins. Rasterized at `scale`.
    let bezelPNG: Data
    /// Bare body (no buttons) — same canvas size.
    let barePNG: Data
    /// Per-button PNG bytes keyed "<name>" and "<name>-down".
    let buttonPNGs: [String: Data]
    /// Raster scale the PNGs were produced at (pixels = chrome-px × scale).
    let scale: Int
    /// Composite size in scale-1 chrome-px (WITHOUT devicePadding).
    let compositeSize: Size

    /// definition.json payload — percent-space so CSS positions directly.
    /// All percentages derive from the CANVAS (composite + devicePadding).
    func definitionJSON(udid: String) -> String {
        let m = chrome.devicePadding
        let canvasW = compositeSize.width + m.left + m.right
        let canvasH = compositeSize.height + m.top + m.bottom
        let screen = chrome.screenRect(in: compositeSize)
        let pct = { (v: Double, total: Double) in
            String(format: "%.2f", (v / total) * 100)
        }
        // Screen box rect — inset origin shifted by the LEFT/TOP margins so
        // it lands on the real cutout inside the padded canvas.
        let sx = m.left + screen.origin.x
        let sy = m.top + screen.origin.y
        let sw = screen.size.width
        let sh = screen.size.height
        // Two-axis corner radius: CSS border-radius a%/b% reads a% of box
        // WIDTH for the horizontal radius and b% of box HEIGHT vertically;
        // equal chrome-px on both axes stays circular on a non-square box.
        let r = chrome.innerCornerRadius

        let buttons = chrome.buttons.map { b in
            let box = buttonBoxPct(b, composite: compositeSize, margins: m)
            return """
            {"name":"\(b.name)","anchor":"\(b.anchor.rawValue)","onTop":\(b.onTop),
             "boxPct":{\(box)},
             "imageUrl":"/devices/\(udid)/bezel-button/\(b.name).png"}
            """
        }.joined(separator: ",")

        return """
        {"identifier":"\(chrome.identifier)","scale":\(scale),
         "bezel":{"width":\(Int((canvasW * Double(scale)).rounded())),"height":\(Int((canvasH * Double(scale)).rounded())),
                  "url":"/devices/\(udid)/bezel.png"},
         "screen":{"xPct":\(pct(sx, canvasW)),"yPct":\(pct(sy, canvasH)),
                   "wPct":\(pct(sw, canvasW)),"hPct":\(pct(sh, canvasH))},
         "screenRadius":{"pctW":\(pct(r, sw)),"pctH":\(pct(r, sh))},
         "buttons":[\(buttons)]}
        """
    }

    private func buttonBoxPct(_ b: ChromeButton, composite: Size, margins: Insets) -> String {
        // Reuse the same anchor math with a nominal 1×1 image at the button's
        // at-rest top-left, then report the box from actual rasterized size.
        // For the definition we only need the top-left point; size percentages
        // come from the rasterized button image, recorded at assembly.
        sizePercentCache[b.name].map { sz in
            let p = Chromes.buttonTopLeft(button: b, imageSize: sz, compositeSize: composite, margins: margins)
            let canvasW = composite.width + margins.left + margins.right
            let canvasH = composite.height + margins.top + margins.bottom
            return "\"left\":\(String(format: "%.2f", p.x / canvasW * 100)),\"top\":\(String(format: "%.2f", p.y / canvasH * 100)),\"width\":\(String(format: "%.2f", sz.width / canvasW * 100)),\"height\":\(String(format: "%.2f", sz.height / canvasH * 100))"
        } ?? "\"left\":0,\"top\":0,\"width\":0,\"height\":0"
    }

    /// Filled by Chromes at assembly: rasterized button sizes (scale-1
    /// chrome-px) for the definition boxes.
    var sizePercentCache: [String: Size] = [:]
}

/// Cache + assembly. Cached by chrome identifier (many simulators share a
/// bundle); nil results cached too so missing bundles don't re-read.
final class Chromes: @unchecked Sendable {
    private let store: ChromeStore
    private let rasterizer: PDFRasterizer
    private let scale: CGFloat

    private let lock = NSLock()
    private var cache: [String: DeviceChromeAssets?] = [:]

    init(store: ChromeStore = ChromeStore(), rasterizer: PDFRasterizer = PDFRasterizer(), scale: CGFloat = 2) {
        self.store = store
        self.rasterizer = rasterizer
        self.scale = scale
    }

    func assets(deviceName: String) -> DeviceChromeAssets? {
        let profile: DeviceProfile
        do {
            let plist = try store.profilePlistData(deviceName: deviceName)
            let caps = try? store.capabilitiesPlistData(deviceName: deviceName)
            profile = try DeviceProfile.parsing(plistData: plist, capabilitiesData: caps)
        } catch {
            return nil
        }
        let chromeID = profile.chromeIdentifier

        lock.lock()
        if let cached = cache[chromeID] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let resolved = loadAssets(chromeIdentifier: chromeID, profile: profile)

        lock.lock()
        cache[chromeID] = resolved
        lock.unlock()
        return resolved
    }

    // MARK: - button anchor table (pure, unit-tested)

    /// Top-left draw position (scale-1 chrome-px) for a button image inside
    /// the padded canvas. `rest = 2·normal − rollover` mirrors the hover
    /// delta inward on the protrusion axis (chrome.json's `normal` is the
    /// HOVER position — the cap already popped past the rail).
    ///
    /// Anchor semantics (asymmetric — each rule guards a regression class
    /// documented in baguette's chrome-bezel.md):
    ///   left   : x = image CENTRE, y = image TOP edge
    ///   right  : x = image LEFT (inner) edge measured outward from
    ///            composite.width, y = image TOP edge (via 2N−R)
    ///   top    : x = image TRAILING/LEADING edge (per align),
    ///            y = image BOTTOM (inner) edge via 2N−R
    ///   bottom : x same as top; y = image TOP (inner) edge via 2N−R
    static func buttonTopLeft(
        button: ChromeButton,
        imageSize: Size,
        compositeSize: Size,
        margins: Insets
    ) -> Point {
        let compX = margins.left
        let compY = margins.top
        let restX = 2 * button.normalOffset.x - button.rolloverOffset.x
        let restY = 2 * button.normalOffset.y - button.rolloverOffset.y
        switch button.anchor {
        case .left:
            let cx = compX + button.normalOffset.x
            let topY = compY + button.normalOffset.y
            return Point(x: cx - imageSize.width / 2, y: topY)
        case .right:
            let leftX = compX + compositeSize.width + restX
            let topY = compY + restY
            return Point(x: leftX, y: topY)
        case .top:
            let leftX: Double
            switch button.align {
            case .trailing: leftX = compX + compositeSize.width + restX - imageSize.width
            case .leading:  leftX = compX + restX
            }
            let topY = compY + restY - imageSize.height
            return Point(x: leftX, y: topY)
        case .bottom:
            let leftX: Double
            switch button.align {
            case .trailing: leftX = compX + compositeSize.width + restX - imageSize.width
            case .leading:  leftX = compX + restX
            }
            let topY = compY + compositeSize.height + restY
            return Point(x: leftX, y: topY)
        }
    }

    // MARK: - private (assembly)

    private func loadAssets(chromeIdentifier: String, profile: DeviceProfile) -> DeviceChromeAssets? {
        let chrome: DeviceChrome
        do {
            chrome = try DeviceChrome.parsing(json: try store.chromeJSONData(chromeIdentifier: chromeIdentifier))
        } catch {
            return nil
        }
        guard let composite = loadComposite(chromeIdentifier: chromeIdentifier, chrome: chrome, profile: profile) else {
            return nil
        }
        return assemble(chromeIdentifier: chromeIdentifier, chrome: chrome, composite: composite)
    }

    private func loadComposite(chromeIdentifier: String, chrome: DeviceChrome, profile: DeviceProfile) -> CGImage? {
        if let imageName = chrome.compositeImageName,
           let pdf = try? store.chromeAssetPDF(chromeIdentifier: chromeIdentifier, imageName: imageName),
           let image = try? rasterizer.rasterize(pdfData: pdf, scale: scale) {
            return image
        }
        guard let slice = chrome.slice,
              let inner = profile.screenSize else { return nil }
        let names = [slice.topLeft, slice.top, slice.topRight, slice.right,
                     slice.bottomRight, slice.bottom, slice.bottomLeft, slice.left]
        var pdfs: [String: Data] = [:]
        for n in names {
            guard let pdf = try? store.chromeAssetPDF(chromeIdentifier: chromeIdentifier, imageName: n) else { return nil }
            pdfs[n] = pdf
        }
        let layout = NineSliceLayout.compose(
            insets: chrome.screenInsets, inner: inner,
            corner: .zero, edge: .zero
        )
        return try? rasterizer.compose9Slice(pdfs: pdfs, layout: layout, scale: scale)
    }

    private func assemble(chromeIdentifier: String, chrome: DeviceChrome, composite: CGImage) -> DeviceChromeAssets? {
        let m = chrome.devicePadding
        // composite rasterized at `scale`; scale-1 size = pixels / scale
        let compW = Double(composite.width) / Double(scale)
        let compH = Double(composite.height) / Double(scale)
        let compositeSize = Size(width: compW, height: compH)
        let canvas = Size(width: compW + m.left + m.right, height: compH + m.top + m.bottom)

        var buttonImages: [(button: ChromeButton, image: CGImage)] = []
        for button in chrome.buttons {
            guard let pdf = try? store.chromeAssetPDF(chromeIdentifier: chromeIdentifier, imageName: button.imageName),
                  let image = try? rasterizer.rasterize(pdfData: pdf, scale: scale)
            else { continue }
            buttonImages.append((button, image))
        }

        // per-button PNGs (+down variants) for the overlay UI
        var buttonPNGs: [String: Data] = [:]
        var sizes: [String: Size] = [:]
        for entry in buttonImages {
            guard let png = try? rasterizer.pngData(entry.image) else { continue }
            buttonPNGs[entry.button.name] = png
            sizes[entry.button.name] = Size(
                width: Double(entry.image.width) / Double(scale),
                height: Double(entry.image.height) / Double(scale)
            )
            if let downName = entry.button.imageDownName,
               let pdf = try? store.chromeAssetPDF(chromeIdentifier: chromeIdentifier, imageName: downName),
               let downImage = try? rasterizer.rasterize(pdfData: pdf, scale: scale),
               let downPNG = try? rasterizer.pngData(downImage) {
                buttonPNGs["\(entry.button.name)-down"] = downPNG
            }
        }

        // merged: behind-buttons → composite → on-top buttons
        var layers: [(image: CGImage, topLeft: Point)] = []
        for entry in buttonImages where !entry.button.onTop {
            let size = Size(width: Double(entry.image.width) / Double(scale),
                            height: Double(entry.image.height) / Double(scale))
            layers.append((entry.image, Self.buttonTopLeft(
                button: entry.button, imageSize: size,
                compositeSize: compositeSize, margins: m
            )))
        }
        layers.append((composite, Point(x: m.left, y: m.top)))
        for entry in buttonImages where entry.button.onTop {
            let size = Size(width: Double(entry.image.width) / Double(scale),
                            height: Double(entry.image.height) / Double(scale))
            layers.append((entry.image, Self.buttonTopLeft(
                button: entry.button, imageSize: size,
                compositeSize: compositeSize, margins: m
            )))
        }

        guard let merged = try? rasterizer.compose(canvasSize: canvas, scale: scale, layers: layers),
              let mergedPNG = try? rasterizer.pngData(merged),
              let barePNG = try? rasterizer.pngData(composite)
        else { return nil }

        var assets = DeviceChromeAssets(
            chrome: chrome,
            bezelPNG: mergedPNG,
            barePNG: barePNG,
            buttonPNGs: buttonPNGs,
            scale: Int(scale),
            compositeSize: compositeSize
        )
        assets.sizePercentCache = sizes
        return assets
    }
}
