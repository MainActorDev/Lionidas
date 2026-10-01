import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { harness, seedOperator, OPERATOR, type Harness } from './harness.ts';

describe('CLI contract harness (F2)', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h.close(); h.cleanup(); });

  it('boots a real listening server with health', async () => {
    const r = await fetch(`${h.baseUrl}/api/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it('operator login yields a session cookie', async () => {
    const sid = await seedOperator(h);
    expect(sid).toMatch(/^[a-f0-9]{64}$/);
  });
  void OPERATOR;
});
