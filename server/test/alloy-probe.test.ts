import { describe, it, expect } from 'vitest';
import { makeProbe } from '../src/alloy/probe.ts';

const view = (over: Record<string, unknown>): Record<string, unknown> => ({
  className: 'UIButton',
  label: 'Pesanan',
  frame: { x: 260, y: 730, width: 80, height: 40 },
  userInteractionEnabled: true,
  hidden: false,
  ...over,
});

describe('makeProbe', () => {
  it('translates a hit view (+children) into SnapNode shape', async () => {
    const dispatch = async () => ({
      ok: true as const,
      result: { status: 'ok', view: { ...view({}), children: [view({ label: 'Profil', frame: { x: 300, y: 730, width: 60, height: 40 } })] } },
    });
    const probe = makeProbe(dispatch as never, undefined, 'U', 'B');
    const nodes = await probe(295, 750);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ type: 'UIButton', label: 'Pesanan', hittable: true, rect: { x: 260, y: 730, width: 80, height: 40 } });
    expect(nodes[1]).toMatchObject({ label: 'Profil' });
  });

  it('restart_required and non-ok results are [] — data, not errors', async () => {
    const dispatch = async () => ({ ok: true as const, result: { status: 'restart_required' } });
    const probe = makeProbe(dispatch as never, undefined, 'U', 'B');
    expect(await probe(1, 1)).toEqual([]);
    const failer = async () => ({ ok: false as const, error: { message: 'x' } });
    expect(await makeProbe(failer as never, undefined, 'U', 'B')(1, 1)).toEqual([]);
    const thrower = async () => { throw new Error('boom'); };
    expect(await makeProbe(thrower as never, undefined, 'U', 'B')(1, 1)).toEqual([]);
  });

  it('non-interactable / hidden views map hittable=false (selector policy applies)', async () => {
    const dispatch = async () => ({ ok: true as const, result: { status: 'ok', view: view({ userInteractionEnabled: false }) } });
    const nodes = await makeProbe(dispatch as never, undefined, 'U', 'B')(1, 1);
    expect(nodes[0]?.hittable).toBe(false);
  });
});
