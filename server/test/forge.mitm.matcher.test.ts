/** Cross-implementation matcher contract: the Python addon's rules (via the
 *  compiled rule functions) must pick the SAME winner as the JS matcher for
 *  every fixture. Runs the addon's matching logic by invoking mitmdump's
 *  python is heavy; instead we exec a small python harness that imports the
 *  addon module's pure functions and prints verdicts — drift fails CI. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchPreset, type Preset } from '../src/forge/matcher.ts';

const here = dirname(fileURLToPath(import.meta.url));
const addonPy = join(here, '..', 'src', 'forge', 'mitm', 'addon.py');

const FIXTURES: Array<{ presets: Array<Partial<Preset> & { id: string }>; method: string; path: string; expectId: string | null; name: string }> = [
  { name: 'exact hit', presets: [{ id: 'a', pathPattern: '/api/x', match: 'exact' }], method: 'GET', path: '/api/x', expectId: 'a' },
  { name: 'exact miss', presets: [{ id: 'a', pathPattern: '/api/x', match: 'exact' }], method: 'GET', path: '/other', expectId: null },
  { name: 'glob hit', presets: [{ id: 'g', pathPattern: '/api/*', match: 'glob' }], method: 'GET', path: '/api/anything', expectId: 'g' },
  { name: 'regex hit', presets: [{ id: 'r', pathPattern: '^/v[0-9]+/items$', match: 'regex' }], method: 'GET', path: '/v2/items', expectId: 'r' },
  { name: 'longest path wins', presets: [{ id: 'short', pathPattern: '/api/*', match: 'glob' }, { id: 'long', pathPattern: '/api/users/*', match: 'glob' }], method: 'GET', path: '/api/users/1', expectId: 'long' },
  { name: 'method * matches POST', presets: [{ id: 'any', method: '*' }], method: 'POST', path: '/api/x', expectId: 'any' },
  { name: 'method mismatch', presets: [{ id: 'post', method: 'POST' }], method: 'GET', path: '/api/x', expectId: null },
];

describe('forge mitm cross-matcher contract', () => {
  it('python and JS pick the same winner on all fixtures', () => {
    // build the python harness input: presets + requests
    const payload = JSON.stringify({
      fixtures: FIXTURES.map((f) => ({
        presets: f.presets.map((p) => ({ method: 'GET', pathPattern: '/api/x', match: 'exact', status: 200, ...p })),
        method: f.method,
        path: f.path,
      })),
    });
    const pyCode = `
import json, sys, importlib.util, types
spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(addonPy)})
mod = importlib.util.module_from_spec(spec)
# stub mitmproxy module (addon imports it lazily inside hooks only)
sys.modules.setdefault("mitmproxy", types.ModuleType("mitmproxy"))
spec.loader.exec_module(mod)
class FakeFlow:
    def __init__(self, method, path, query, headers):
        from types import SimpleNamespace
        self.request = SimpleNamespace(method=method, path=path, headers=headers)
        self.query = query
data = json.loads(${JSON.stringify(payload)})
state = mod.ForgeState("/nonexistent")
out = []
for fx in data["fixtures"]:
    state.presets = fx["presets"]
    flow = FakeFlow(fx["method"], fx["path"], {}, {})
    p = mod.match_preset(state, flow)
    out.append(p["id"] if p else None)
print(json.dumps(out))
`;
    const out = execFileSync('python3', ['-c', pyCode], { encoding: 'utf8' }).trim();
    const pyWinners = JSON.parse(out) as Array<string | null>;
    const jsWinners = FIXTURES.map((f) => {
      const hit = matchPreset(
        f.presets.map((p) => ({ method: 'GET', pathPattern: '/api/x', match: 'exact', status: 200, ...p })) as Preset[],
        { method: f.method, path: f.path, query: {}, headers: {} },
      );
      return hit?.preset.id ?? null;
    });
    for (let i = 0; i < FIXTURES.length; i++) {
      expect(jsWinners[i], FIXTURES[i]!.name).toBe(FIXTURES[i]!.expectId);
      expect(pyWinners[i], `${FIXTURES[i]!.name} (python agrees)`).toBe(jsWinners[i]);
    }
  });
});
