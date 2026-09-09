// Scaler — IOSurface → pooled, codec-ready CVPixelBuffer.
//
// VideoToolbox encodes asynchronously on its own queue while SimulatorKit
// recycles the framebuffer IOSurface in place — the encoder needs a stable
// copy. Follows baguette's VideoFrameScaler recipe (Apache-2.0, attributed):
// CVPixelBuffer pool keyed by size, CoreImage GPU write with a fence before
// the sync/async consumer reads.
import Foundation
import CoreVideo
import CoreImage
import IOSurface

final class Scaler: @unchecked Sendable {
    private let context = CIContext(options: [.priorityRequestLow: false])
    private var pool: CVPixelBufferPool?
    private var poolW = 0, poolH = 0

    func scale(_ surface: IOSurface, divisor: Int = 1) -> CVPixelBuffer? {
        let srcW = IOSurfaceGetWidth(surface)
        let srcH = IOSurfaceGetHeight(surface)
        let w = divisor > 1 ? srcW / divisor : srcW
        let h = divisor > 1 ? srcH / divisor : srcH
        guard w > 0, h > 0 else { return nil }

        if pool == nil || w != poolW || h != poolH {
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey: w,
                kCVPixelBufferHeightKey: h,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
            ]
            var newPool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &newPool)
            pool = newPool
            poolW = w; poolH = h
        }
        guard let pool else { return nil }

        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let out else { return nil }

        let ci = CIImage(ioSurface: surface)
        let sx = CGFloat(w) / CGFloat(srcW)
        let sy = CGFloat(h) / CGFloat(srcH)
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        context.render(scaled, to: out)
        return out
    }
}
