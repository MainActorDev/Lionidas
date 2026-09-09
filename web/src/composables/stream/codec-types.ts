/** Shared codec contracts for the device stream composable. */

export interface Codec {
  feed(data: ArrayBuffer): void;
  dispose(): void;
}

/** Called with a paintable source: ImageBitmap (JPEG seed / mjpeg frames) or a
 *  playing <video> element (AVCC via jmuxer/MSE — current frame at call time). */
export type OnFrame = (frame: ImageBitmap | HTMLVideoElement) => void;
export type OnLog = (msg: string, isErr?: boolean) => void;
