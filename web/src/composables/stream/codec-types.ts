/** Shared codec contracts for the device stream composable. */

export interface Codec {
  feed(data: ArrayBuffer): void;
  dispose(): void;
}

/** ImageBitmap (JPEG seed / mjpeg) or VideoFrame (AVCC WebCodecs output). */
export type OnFrame = (frame: ImageBitmap | VideoFrame) => void;
export type OnLog = (msg: string, isErr?: boolean) => void;
