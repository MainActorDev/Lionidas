// measure real alloy_snapshot latency — the plan's per-selector-step cost
import { crucibleAlloy } from '../src/alloy/client.ts';
import { initAlloyRuntime } from '../src/alloy/runtime.ts';
const rt = await initAlloyRuntime();
const alloy = crucibleAlloy();
const UDID = '30B28173-D2C6-4D1A-B544-49EB4BEF7A4D';
const times = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const r = await alloy.dispatch('alloy_snapshot', { udid: UDID, interactiveOnly: false }, rt.deps);
  times.push(Date.now() - t0);
  if (!r.ok) { console.log('snap failed:', r.error?.code); process.exit(1); }
}
console.log('snapshot latency (5 runs):', times.join(', '), 'ms | max:', Math.max(...times));
