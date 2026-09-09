/** Stream codecs — turn relay WS frames into paintable sources.
 *  AVCC path rides jmuxer (MIT): it muxes our length-prefixed H.264 NALs into
 *  MSE and drives a <video> element, so the BROWSER owns decoder lifecycle —
 *  no hand-rolled avcC/VideoDecoder state machine to misconfigure. The relay
 *  wire is [1B tag][payload]: 0x01 avcC, 0x02 IDR, 0x03 P-frame, 0x04 JPEG
 *  seed. jmuxer takes NAL units raw; the avcC bytes are SPS+PPS NALs, and the
 *  key/delta payloads are already length-prefixed AVCC chunks — jmuxer's
 *  `duration` + `chunkSize` framing accepts exactly this feed shape. */

import type { Codec, OnFrame, OnLog } from './codec-types.ts';

const hex2 = (b: number): string => b.toString(16).padStart(2, '0');

export function hasAvccSupport(): boolean {
  return typeof globalThis.MediaSource !== 'undefined'
    && (MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"') || MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'));
}

/** AVCC NAL chunk → raw NAL units (strips 4-byte big-endian length prefixes).
 *  baguette's WS payloads are AVCC (length-prefixed); jmuxer wants raw NALs
 *  (it writes its own lengths). */
function avccToNalus(payload: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const len = (payload[i]! << 24) | (payload[i + 1]! << 16) | (payload[i + 2]! << 8) | payload[i + 3]!;
    if (len <= 0 || i + 4 + len > payload.length) break; // corrupt — stop at what we have
    nalus.push(payload.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return nalus;
}

export function makeAvccDecoder(onFrame: OnFrame, onLog?: OnLog): Codec {
  // hidden <video> — jmuxer's sink; we never show it, only paint from it
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  let disposed = false;
  let jmuxer: { destroy(): void; feed(data: { video: Uint8Array; duration?: number }): void } | null = null;
  let rvfcId = 0;
  /** frames racing jmuxer init are BUFFERED — the avcC + first IDR arrive
   *  immediately on connect; dropping them starves the MSE track (readyState
   *  stays 0 forever — the frozen-seed symptom). */
  const preInit: ArrayBuffer[] = [];

  void (async () => {
    try {
      const { default: JMuxer } = await import('jmuxer');
      if (disposed) return;
      jmuxer = new JMuxer({
        node: video,
        mode: 'video',
        flushingTime: 0,          // latency: flush every fed chunk immediately
        fps: 60,                  // container timing hint only
        debug: false,
      });
      // frame-accurate paint: rVFC fires per presented frame; each callback
      // hands the CURRENT video element to the painter (like VideoDecoder.output)
      const anyVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      const pump = (): void => {
        if (disposed) return;
        if (video.readyState >= 2 && video.videoWidth > 0) onFrame(video);
        rvfcId = anyVideo.requestVideoFrameCallback?.(pump) ?? 0;
        if (!anyVideo.requestVideoFrameCallback) {
          // Safari <15.4 fallback: sample at display cadence
          rvfcId = window.setTimeout(pump, 16) as unknown as number;
        }
      };
      video.play().catch((e) => onLog?.(`autoplay blocked: ${e instanceof Error ? e.message : String(e)}`, true));
      pump();
      const backlog = preInit.splice(0);
      for (const b2 of backlog) feedRaw(b2);
    } catch (e) {
      onLog?.(`jmuxer load failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  })();

  function feedRaw(data: ArrayBuffer): void {
    const buf = new Uint8Array(data);
    if (buf.byteLength < 2) return;
    const type = buf[0];
    const payload = buf.subarray(1);
    if (!jmuxer) { preInit.push(data); return; } // replayed once jmuxer init lands
    if (type === 0x01) {
        // avcC: bytes after the 8-byte fixed header are SPS/PPS NALs; feed them
        // so the stream starts with parameter sets (jmuxer inits its track)
        const spsLen = payload.length > 6 ? ((payload[6]! << 8) | payload[7]!) + 8 : 0;
        const nalus: Uint8Array[] = [];
        if (spsLen > 8 && spsLen <= payload.length) nalus.push(payload.subarray(8, spsLen));
        if (spsLen + 3 <= payload.length) {
          const ppsLen = (payload[spsLen + 1]! << 8) | payload[spsLen + 2]!;
          if (ppsLen > 0 && spsLen + 3 + ppsLen <= payload.length) nalus.push(payload.subarray(spsLen + 3, spsLen + 3 + ppsLen));
        }
        for (const n of nalus) jmuxer.feed({ video: n });
  } else if (type === 0x02 || type === 0x03) {
    for (const n of avccToNalus(payload)) jmuxer.feed({ video: n });
  } else if (type === 0x04) {
    void (async () => {
      try { onFrame(await createImageBitmap(new Blob([payload], { type: 'image/jpeg' }))); }
      catch { /* corrupt seed — H.264 will take over */ }
    })();
  }
  }

  return {
    feed(data: ArrayBuffer): void { feedRaw(data); },
    dispose() {
      disposed = true;
      try { jmuxer?.destroy(); } catch { /* ok */ }
      const anyVideo = video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
      if (anyVideo.cancelVideoFrameCallback && rvfcId) anyVideo.cancelVideoFrameCallback(rvfcId);
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
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

// re-export for existing importers
export type { Codec, OnFrame, OnLog };
