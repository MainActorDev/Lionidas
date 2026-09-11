/** Chrome adapter tests, hosted in the server suite (the web package has no
 *  test runner; the module under test is PURE TS with no vue imports). */
import { describe, expect, it } from 'vitest';
import { adaptChromeDefinition, type ChildDefinition } from '../../../web/src/composables/simdeckChrome.ts';

const CHILD_DEF: ChildDefinition = {
  buttons: [
    { id: 'action', box: { leftPct: -1.146788990825688, topPct: 17.62114537444934, widthPct: 3.669724770642202, heightPct: 3.7444933920704844 }, envelope: { button: 'action' }, images: { rest: '/simulators/835/chrome-button/action.png', pressed: '/simulators/835/chrome-button/action-down.png' }, transform: { rest: 'none', hover: 'translate(-31.25%, 0%)', pressed: 'translate(31.25%, 0%)' }, z: 'below' },
    { id: 'volume-up', box: { leftPct: -1.146788990825688, topPct: 24.33920704845815, widthPct: 3.669724770642202, heightPct: 7.048458149779736 }, envelope: { button: 'volume-up' }, images: { rest: '/simulators/835/chrome-button/volume-up.png', pressed: '' }, transform: { rest: 'none', hover: '', pressed: '' }, z: 'above' },
  ],
  identity: { model: 'iPhone 17 Pro', name: 'iPhone 17 Pro', udid: 'UDID' },
  keyboard: {},
  screen: {
    bezelImage: { bare: '/simulators/835/bezel.png?buttons=false', rest: '/simulators/835/bezel.png' },
    clipRadius: 62,
    rect: { x: 18, y: 18, width: 400, height: 872 },
    viewport: { width: 436, height: 908 },
  },
};

describe('adaptChromeDefinition', () => {
  const d = adaptChromeDefinition('UDID', CHILD_DEF);

  it('bezel = viewport px + bare image url', () => {
    expect(d.bezel.width).toBe(436);
    expect(d.bezel.height).toBe(908);
    expect(d.bezel.url).toContain('bezel.png?buttons=false');
  });

  it('screen rect chrome-px → % of viewport', () => {
    expect(d.screen.xPct).toBeCloseTo((18 / 436) * 100);
    expect(d.screen.yPct).toBeCloseTo((18 / 908) * 100);
    expect(d.screen.wPct).toBeCloseTo((400 / 436) * 100);
    expect(d.screen.hPct).toBeCloseTo((872 / 908) * 100);
  });

  it('clipRadius px → % of screen w/h', () => {
    expect(d.screenRadius.pctW).toBeCloseTo((62 / 400) * 100);
    expect(d.screenRadius.pctH).toBeCloseTo((62 / 872) * 100);
  });

  it('buttons: envelope name, box% passthrough, rest image, z→onTop', () => {
    expect(d.buttons).toHaveLength(2);
    const b0 = d.buttons[0]!;
    expect(b0.name).toBe('action');
    expect(b0.imageUrl).toContain('/chrome-button/action.png');
    expect(b0.onTop).toBe(false);
    const b1 = d.buttons[1]!;
    expect(b1.name).toBe('volume-up');
    expect(b1.onTop).toBe(true);
  });
});
