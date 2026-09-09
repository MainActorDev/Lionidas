// PDFRasterizer — DeviceKit PDF assets → CGImage, and compositing.
// The 9-slice layout math is pure (NineSliceLayout); only the CG calls
// live in the class. Rasterize/compose follows baguette's PDFRasterizer
// recipe (Apache-2.0, attributed).
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Destination rect (scale-1 chrome-px) for each of the 8 body pieces.
/// Corners keep natural size; edges stretch between them; the screen
/// area stays transparent.
struct NineSliceLayout: Equatable, Sendable {
    let topLeft: Rect
    let top: Rect
    let topRight: Rect
    let right: Rect
    let bottomRight: Rect
    let bottom: Rect
    let bottomLeft: Rect
    let left: Rect

    /// - Parameters:
    ///   - insets: chrome sizing (rail thickness each side).
    ///   - inner: 1x screen size in points (from profile.plist).
    ///   - corner/topLeft natural size etc. — used only for sizes here;
    ///     the composer stretches edges, corners are natural.
    static func compose(
        insets: Insets, inner: Size,
        corner: Size, edge: Size
    ) -> NineSliceLayout {
        _ = corner; _ = edge  // sizes derive from insets; params kept for clarity
        let w = insets.left + inner.width + insets.right
        let h = insets.top + inner.height + insets.bottom
        let t = insets.top, l = insets.left, b = insets.bottom, r = insets.right
        return NineSliceLayout(
            topLeft:     Rect(origin: Point(x: 0, y: 0), size: Size(width: l, height: t)),
            top:         Rect(origin: Point(x: l, y: 0), size: Size(width: inner.width, height: t)),
            topRight:    Rect(origin: Point(x: l + inner.width, y: 0), size: Size(width: r, height: t)),
            right:       Rect(origin: Point(x: l + inner.width, y: t), size: Size(width: r, height: inner.height)),
            bottomRight: Rect(origin: Point(x: l + inner.width, y: t + inner.height), size: Size(width: r, height: b)),
            bottom:      Rect(origin: Point(x: l, y: t + inner.height), size: Size(width: inner.width, height: b)),
            bottomLeft:  Rect(origin: Point(x: 0, y: t + inner.height), size: Size(width: l, height: b)),
            left:        Rect(origin: Point(x: 0, y: t), size: Size(width: l, height: inner.height))
        )
    }
}

enum PDFRasterizerError: Error, Equatable {
    case invalidPDF
    case encodeFailed
}

final class PDFRasterizer: @unchecked Sendable {
    /// PDF page 1 → CGImage at `scale` (2 = retina-crisp for the wall).
    func rasterize(pdfData: Data, scale: CGFloat = 2) throws -> CGImage {
        guard let provider = CGDataProvider(data: pdfData as CFData),
              let doc = CGPDFDocument(provider),
              let page = doc.page(at: 1)
        else { throw PDFRasterizerError.invalidPDF }
        let box = page.getBoxRect(.mediaBox)
        let w = max(1, Int(box.width * scale))
        let h = max(1, Int(box.height * scale))
        guard let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw PDFRasterizerError.invalidPDF }
        ctx.interpolationQuality = CGInterpolationQuality.none
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
        ctx.drawPDFPage(page)
        guard let image = ctx.makeImage() else { throw PDFRasterizerError.invalidPDF }
        return image
    }

    /// Natural (scale-1) size of PDF page 1 — the marker size, not rasterized.
    func naturalSize(pdfData: Data) throws -> Size {
        guard let provider = CGDataProvider(data: pdfData as CFData),
              let doc = CGPDFDocument(provider),
              let page = doc.page(at: 1)
        else { throw PDFRasterizerError.invalidPDF }
        let box = page.getBoxRect(.mediaBox)
        return Size(width: box.width, height: box.height)
    }

    /// Draw layers (topLeft in scale-1 chrome-px) onto a canvas, × scale.
    func compose(
        canvasSize: Size, scale: CGFloat,
        layers: [(image: CGImage, topLeft: Point)]
    ) throws -> CGImage {
        try compose(canvasSize: canvasSize, scale: scale,
                    sized: layers.map { ($0.image, $0.topLeft,
                        Size(width: Double($0.image.width) / Double(scale),
                             height: Double($0.image.height) / Double(scale))) })
    }

    /// Draw layers at EXPLICIT scale-1 sizes (edges stretch to layout rects).
    func compose(
        canvasSize: Size, scale: CGFloat,
        sized: [(image: CGImage, topLeft: Point, size: Size)]
    ) throws -> CGImage {
        let w = max(1, Int(canvasSize.width * scale))
        let h = max(1, Int(canvasSize.height * scale))
        guard let ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw PDFRasterizerError.invalidPDF }
        // CG origin is bottom-left; chrome-px space is top-left. Flip once.
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        for layer in sized {
            let rect = CGRect(
                x: layer.topLeft.x * scale, y: layer.topLeft.y * scale,
                width: layer.size.width * scale, height: layer.size.height * scale
            )
            ctx.draw(layer.image, in: rect)
        }
        guard let image = ctx.makeImage() else { throw PDFRasterizerError.invalidPDF }
        return image
    }

    /// 9-slice compose: corners natural-size, edges stretched per layout.
    func compose9Slice(
        pdfs: [String: Data],
        layout: NineSliceLayout,
        scale: CGFloat
    ) throws -> CGImage {
        func img(_ name: String) throws -> CGImage {
            guard let data = pdfs[name] else { throw PDFRasterizerError.invalidPDF }
            return try rasterize(pdfData: data, scale: scale)
        }
        // rasterize each piece once (corners reused sizes; edges rasterize at
        // natural width but stretch horizontally — draw() scales for us)
        let tl = try img("topLeft"), tp = try img("top"), tr = try img("topRight")
        let rt = try img("right"), br = try img("bottomRight"), bt = try img("bottom")
        let bl = try img("bottomLeft"), lf = try img("left")
        let canvas = Size(
            width: layout.topLeft.size.width + layout.top.size.width + layout.topRight.size.width,
            height: layout.topLeft.size.height + layout.left.size.height + layout.bottomLeft.size.height
        )
        // Edges STRETCH to their layout rects (draw rect ≠ natural size);
        // corners draw natural. Pass explicit sizes.
        func layer(_ image: CGImage, _ rect: Rect) -> (image: CGImage, topLeft: Point, size: Size) {
            (image, rect.origin, rect.size)
        }
        let entries: [(image: CGImage, topLeft: Point, size: Size)] = [
            layer(tl, layout.topLeft), layer(tp, layout.top), layer(tr, layout.topRight),
            layer(lf, layout.left), layer(rt, layout.right),
            layer(bl, layout.bottomLeft), layer(bt, layout.bottom), layer(br, layout.bottomRight),
        ]
        return try compose(canvasSize: canvas, scale: scale, sized: entries)
    }

    /// CGImage → PNG bytes (lossless — bezels are flat vector art).
    func pngData(_ image: CGImage) throws -> Data {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil
        ) else { throw PDFRasterizerError.encodeFailed }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw PDFRasterizerError.encodeFailed }
        return out as Data
    }
}
