/** Stream codecs — mirror of baguette's frame-decoder.js (their UI streams
 *  H.264 flawlessly; this is their exact decode logic, not an interpretation).
 *  Wire: [1B tag][payload] — 0x01 avcC, 0x02 IDR, 0x03 P, 0x04 JPEG seed. */

import type { Codec, OnFrame, OnLog } from './codec-types.ts';

const hex2 = (b: number): string => ('0' + b.toString(16)).slice(-2);

export function hasAvccSupport(): boolean {
  return typeof globalThis.VideoDecoder === 'function';
}

export function makeAvccDecoder(onFrame: OnFrame, onLog?: OnLog): Codec {
  let ts = 0;
  const decoder = new VideoDecoder({
    output: (frame) => onFrame(frame),
    error: (err) => onLog?.('decoder: ' + err.message, true),
  });
  return {
    feed(data: ArrayBuffer) {
      if (data.byteLength < 2) return;
      const buf = new Uint8Array(data);
      const type = buf[0];
      const payload = buf.slice(1); // COPY — payload.buffer is exactly the bytes

      if (type === 0x01) {
        const config: VideoDecoderConfig = {
          codec: 'avc1.' + hex2(payload[1] ?? 0) + hex2(payload[2] ?? 0) + hex2(payload[3] ?? 0),
          description: payload.buffer,
          optimizeForLatency: true,
          hardwareAcceleration: 'prefer-hardware',
        };
        // diagnostic only (baguette's comment): silent software fallback is the
        // mystery-lag failure mode — surface it in the log instead
        const mc = navigator.mediaCapabilities;
        if (mc && typeof mc.decodingInfo === 'function') {
          mc.decodingInfo({
            type: 'file',
            video: { contentType: 'video/mp4; codecs="' + config.codec + '"', width: 1170, height: 2532, bitrate: 8_000_000, framerate: 60 },
          }).then((info) => {
            onLog?.('decode: ' + (info.powerEfficient ? 'hardware' : 'SOFTWARE fallback')
              + ' (' + config.codec + ' — supported=' + info.supported + ')'
              + (info.powerEfficient ? '' : ' — H.264 latency will be poor'), !info.powerEfficient);
          }).catch(() => { onLog?.('decode: HW probe failed for ' + config.codec, true); });
        }
        try { decoder.configure(config); }
        catch (ex) { onLog?.('config: ' + (ex instanceof Error ? ex.message : String(ex)), true); }
      } else if ((type === 0x02 || type === 0x03) && decoder.state === 'configured') {
        try {
          decoder.decode(new EncodedVideoChunk({
            type: type === 0x02 ? 'key' : 'delta',
            timestamp: ts,
            data: payload.buffer,
          }));
          ts += 16667; // 60fps monotonic tick (not displayed)
        } catch { /* drop frame */ }
      } else if (type === 0x04) {
        createImageBitmap(new Blob([payload], { type: 'image/jpeg' }))
          .then(onFrame)
          .catch(() => { /* corrupt seed */ });
      }
    },
    dispose() { try { decoder.close(); } catch { /* already closed */ } },
  };
}

export function makeMjpegDecoder(onFrame: OnFrame, _onLog?: OnLog): Codec {
  return {
    async feed(data: ArrayBuffer) {
      try { onFrame(await createImageBitmap(new Blob([data], { type: 'image/jpeg' }))); }
      catch { /* corrupt frame — skip */ }
    },
    dispose() { /* nothing to release */ },
  };
}

export type { Codec, OnFrame, OnLog } from './codec-types.ts';
