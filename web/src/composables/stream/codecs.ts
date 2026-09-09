/** Stream codecs — turn relay WS frames into paintable images.
 *  Ported from baguette's Resources/Web/frame-decoder.js (AVCC decoder):
 *  [1B tag][payload] — 0x01 avcC description, 0x02 IDR keyframe, 0x03 P-frame,
 *  0x04 JPEG seed. VideoDecoder (WebCodecs) with hardware preference and an
 *  honest software-fallback log. Pure: no DOM, no WS. */

export interface Codec {
  feed(data: ArrayBuffer): void;
  dispose(): void;
}

export type OnFrame = (frame: ImageBitmap | VideoFrame) => void;
export type OnLog = (msg: string, isErr?: boolean) => void;

const hex2 = (b: number): string => b.toString(16).padStart(2, '0');

export function hasAvccSupport(): boolean {
  return typeof globalThis.VideoDecoder === 'function';
}

export function makeAvccDecoder(onFrame: OnFrame, onLog?: OnLog): Codec {
  let ts = 0;
  const decoder = new VideoDecoder({
    output: (frame) => onFrame(frame),
    error: (err) => onLog?.(`decoder: ${err.message}`, true),
  });

  function configureFromAvcC(payload: Uint8Array): void {
    const config: VideoDecoderConfig = {
      codec: 'avc1.' + hex2(payload[1] ?? 0) + hex2(payload[2] ?? 0) + hex2(payload[3] ?? 0),
      description: payload.buffer,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    };
    // hardware probe (mirrors baguette): mediaCapabilities tells us whether the
    // GPU will actually take this decode; the silent software fallback at
    // full-res 60fps is the failure mode we want logged, not discovered.
    void (async () => {
      try {
        const caps = await navigator.mediaCapabilities?.decodingInfo?.({
          type: 'file', // closest MediaDecodingType; this is a capability probe, not playback
          video: { contentType: 'video/mp4; codecs="' + config.codec + '"', width: 1284, height: 2778, bitrate: 8_000_000, framerate: 60 },
        });
        if (caps && !caps.supported) onLog?.('decode: configuration reported unsupported');
        else if (caps?.powerEfficient === false) onLog?.('decode: SOFTWARE fallback expected for ' + config.codec);
      } catch {
        onLog?.('decode: mediaCapabilities unavailable — configuring blind');
      }
      try { decoder.configure(config); } catch (e) { onLog?.(`configure failed: ${e instanceof Error ? e.message : String(e)}`, true); }
    })();
  }

  return {
    feed(data) {
      const buf = new Uint8Array(data);
      if (buf.byteLength < 2) return;
      const type = buf[0];
      const payload = buf.subarray(1);
      if (type === 0x01) {
        configureFromAvcC(payload);
      } else if ((type === 0x02 || type === 0x03) && decoder.state === 'configured') {
        // backpressure: a burst that outruns decode drops the OLDEST queued
        // delta frame rather than growing the queue (latest-wins philosophy)
        if (decoder.decodeQueueSize > 4) {
          onLog?.('decode: queue pressure — frame dropped');
          return;
        }
        decoder.decode(new EncodedVideoChunk({
          type: type === 0x02 ? 'key' : 'delta',
          timestamp: (ts += 1_000_000 / 60),
          data: payload,
        }));
      } else if (type === 0x04) {
        void (async () => {
          try { onFrame(await createImageBitmap(new Blob([payload], { type: 'image/jpeg' }))); }
          catch { /* corrupt seed — decoder warm-up will still land frames */ }
        })();
      }
    },
    dispose() { try { decoder.close(); } catch { /* already closed */ } },
  };
}

export function makeMjpegDecoder(onFrame: OnFrame, _onLog?: OnLog): Codec {
  return {
    async feed(data) {
      try { onFrame(await createImageBitmap(new Blob([data], { type: 'image/jpeg' }))); }
      catch { /* corrupt frame — skip */ }
    },
    dispose() { /* nothing to release */ },
  };
}
