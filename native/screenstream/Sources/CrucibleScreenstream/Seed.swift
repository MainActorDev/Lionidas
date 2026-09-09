// Seed — JPEG snapshot via ImageIO for the tag-0x04 instant-paint frame.
// Follows baguette's JPEGEncoder recipe (Apache-2.0, attributed).
import Foundation
import CoreVideo
import ImageIO
import UniformTypeIdentifiers
import CoreImage

final class Seed {
    private let quality: Double
    init(quality: Double = 0.7) { self.quality = quality }

    func encode(_ pixelBuffer: CVPixelBuffer) -> Data? {
        guard let image = cgImage(from: pixelBuffer) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(dest, image, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}

private func cgImage(from pb: CVPixelBuffer) -> CGImage? {
    let ci = CIImage(cvPixelBuffer: pb)
    let ctx = CIContext()
    return ctx.createCGImage(ci, from: ci.extent)
}
