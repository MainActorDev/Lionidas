/** Stream codecs — originally mirrored from baguette's frame-decoder.js (their UI streams
 *  H.264 flawlessly; this is their exact decode logic, not an interpretation).
 *  Wire: [1B tag][payload] — 0x01 avcC, 0x02 IDR, 0x03 P, 0x04 JPEG seed. */

import type { Codec, OnFrame, OnLog } from './codec-types.ts';

const hex2 = (b: number): string => ('0' + b.toString(16)).slice(-2);

export function hasAvccSupport(): boolean {
  return typeof globalThis.VideoDecoder === 'function';
}

export function makeAvccDecoder(onFrame: OnFrame, onLog?: OnLog): Codec {
  let ts = 0;
  // GOP gate: decoding a delta before its reference keyframe is THE
  // pixelation/smear bug — hold frames until a keyframe lands. A decoder
  // that errored is CLOSED forever (WebCodecs contract): only a fresh
  // instance configured from the latest avcC can resume decoding.
  let gopArmed = false;
  let decoderDead = false;
  let lastAvcC: ArrayBuffer | null = null;   // parameter sets for (re)configure
  let decoder = makeDecoder();

  function makeDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => onFrame(frame),
      error: (err) => {
        gopArmed = false;              // reference chain broken — resync on next IDR
        decoderDead = true;            // this instance is closed; revive on next 0x01+0x02
        onLog?.('decoder: ' + err.message + ' — resyncing on next keyframe', true);
      },
    });
  }

  function configureWith(avcc: ArrayBuffer): void {
    const bytes = new Uint8Array(avcc);
    const config: VideoDecoderConfig = {
      codec: 'avc1.' + hex2(bytes[1] ?? 0) + hex2(bytes[2] ?? 0) + hex2(bytes[3] ?? 0),
      description: avcc,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    };
    // diagnostic only: silent software fallback is the mystery-lag failure
    // mode — surface it in the log instead of degrading quietly
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
  }

  return {
    feed(data: ArrayBuffer) {
      if (data.byteLength < 2) return;
      const buf = new Uint8Array(data);
      const type = buf[0];
      const payload = buf.slice(1); // COPY — payload.buffer is exactly the bytes

      if (type === 0x01) {
        lastAvcC = payload.buffer.slice(0) as ArrayBuffer;   // own copy (slice() of a view copies)
        if (decoderDead) return;                             // wait for the 0x02 revival path
        configureWith(lastAvcC);
      } else if (type === 0x02) {
        // revival: a dead decoder gets a FRESH instance + the latest avcC;
        // only a keyframe may restart the reference chain
        if (decoderDead) {
          if (!lastAvcC) return;
          decoder = makeDecoder();
          configureWith(lastAvcC);
          decoderDead = false;
        }
        gopArmed = true;
        if (decoder.state !== 'configured') return;
        try {
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: ts, data: payload.buffer }));
          ts += 16667; // 60fps monotonic tick (not displayed)
        } catch { /* drop frame */ }
      } else if (type === 0x03 && decoder.state === 'configured') {
        // gate: never decode deltas without an armed GOP — that is the smear
        if (!gopArmed || decoderDead) return;
        // baguette 1:1: decode EVERY delta — no queue-depth shed. HW decode +
        // optimizeForLatency drains fast; shedding deltas during bursts
        // (keyboard slide-in, caret blink) showed as visible frame jumps.
        try {
          decoder.decode(new EncodedVideoChunk({ type: 'delta', timestamp: ts, data: payload.buffer }));
          ts += 16667;
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
