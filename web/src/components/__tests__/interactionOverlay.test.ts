import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import InteractionOverlay from '../../components/cockpit/InteractionOverlay.vue';

/** The live-drill lesson baked into a test: never verify canvas output by
 *  eye/pixels (focus + throttling make it flaky). Patch getContext with a
 *  recorder, mount the real component, tick rAF synchronously, assert the
 *  DRAW OPERATIONS — deterministic everywhere. */
const OPS: string[] = [];
const CTX = {
  clearRect: (...a: number[]) => OPS.push(`clear ${a.join(',')}`),
  beginPath: () => OPS.push('beginPath'),
  arc: (...a: number[]) => OPS.push(`arc ${a.slice(0, 3).map((v) => Math.round(v)).join(',')}`),
  moveTo: (...a: number[]) => OPS.push(`moveTo ${a.map((v) => Math.round(v)).join(',')}`),
  lineTo: (...a: number[]) => OPS.push(`lineTo ${a.map((v) => Math.round(v)).join(',')}`),
  stroke: () => OPS.push('stroke'),
  fill: () => OPS.push('fill'),
  fillRect: (...a: number[]) => OPS.push(`fillRect ${a.map((v) => Math.round(v)).join(',')}`),
  strokeRect: (...a: number[]) => OPS.push(`strokeRect ${a.map((v) => Math.round(v)).join(',')}`),
  fillText: (t: string, x: number, y: number) => OPS.push(`text ${t} @${Math.round(x)},${Math.round(y)}`),
  measureText: (t: string) => ({ width: t.length * 6 }),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
};

let rafCbs: Array<(t: number) => void> = [];
let now = 0;

describe('InteractionOverlay (030-B crosshair+label)', () => {
  beforeEach(() => {
    OPS.length = 0;
    rafCbs = [];
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { rafCbs.push(cb); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('performance', { now: () => now });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(CTX as unknown as CanvasRenderingContext2D);
    Object.defineProperty(HTMLCanvasElement.prototype, 'parentElement', { configurable: true, get: () => ({ getBoundingClientRect: (): { width: number; height: number } => ({ width: 268, height: 550 }) }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function tick(): void { const cbs = rafCbs; rafCbs = []; for (const cb of cbs) cb(now); }

  it('draws crosshair guides + ring + label chip for a fresh marker at the right spot', () => {
    const w = mount(InteractionOverlay, {
      props: { markers: [{ id: 1, fx: 0.5, fy: 0.8, label: 'tap · login_button', kind: 'tap' }] },
    });
    tick();
    const joined = OPS.join('\n');
    // center point: fx*268=134, fy*550=440
    expect(joined).toContain('arc 134,440');        // ring at the tap point
    expect(joined).toContain('moveTo 0,440');       // horizontal guide
    expect(joined).toContain('lineTo 268,440');
    expect(joined).toContain('moveTo 134,0');       // vertical guide
    expect(joined).toContain('lineTo 134,550');
    expect(joined).toContain('text tap · login_button'); // the label chip
    w.unmount();
  });

  it('type markers draw a caret tick; label chips never leave the canvas', () => {
    const w = mount(InteractionOverlay, {
      props: { markers: [{ id: 2, fx: 0.99, fy: 0.01, label: 'type · phone_field', kind: 'type' }] },
    });
    tick();
    const joined = OPS.join('\n');
    // caret tick at the point (fillRect x-1, y-12, w2, h24)
    expect(joined).toContain('fillRect 264,-6');    // 0.99*268≈265−1, 0.01*550≈6−12 (caret tick)
    // label flips LEFT (x+14 would overflow 268): chip x < point x
    const m = /text type · phone_field @(\d+),/.exec(joined);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThan(265); // chip flipped left of the near-right-edge point
    w.unmount();
  });

  it('markers older than 1400ms draw nothing; empty markers = clear only', () => {
    const w = mount(InteractionOverlay, { props: { markers: [{ id: 3, fx: 0.5, fy: 0.5, label: 'x', kind: 'tap' }] } });
    tick();               // t=0: born now, draws
    expect(OPS.join('\n')).toContain('arc 134,275');
    OPS.length = 0;
    now = 2000;           // aged past fade
    tick();
    expect(OPS.filter((o) => o.startsWith('arc')).length).toBe(0);
    w.unmount();
  });
});
