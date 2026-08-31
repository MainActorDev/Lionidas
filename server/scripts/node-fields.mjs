import { crucibleAlloy } from '../src/alloy/client.ts';
import { initAlloyRuntime } from '../src/alloy/runtime.ts';
const rt = await initAlloyRuntime();
const alloy = crucibleAlloy();
const snap = await alloy.dispatch('alloy_snapshot', { udid: '30B28173-D2C6-4D1A-B544-49EB4BEF7A4D', interactiveOnly: false }, rt.deps);
if (!snap.ok) { console.log('snap error:', JSON.stringify(snap.error).slice(0, 300)); process.exit(0); }
const nodes = snap.result?.nodes ?? [];
console.log('total nodes:', nodes.length);
console.log('field keys union:', [...new Set(nodes.flatMap((n) => Object.keys(n)))].join(', '));
const leaves = nodes.filter((n) => n.type !== 'Application');
console.log('leaf nodes:', leaves.length);
for (const n of leaves.slice(0, 4)) console.log(JSON.stringify(n).slice(0, 240));
const hittable = nodes.filter((n) => n.hittable);
const withId = hittable.filter((n) => n.identifier);
const withLabel = hittable.filter((n) => n.label);
console.log(`hittable: ${hittable.length}, with identifier: ${withId.length}, with label: ${withLabel.length}`);
for (const n of withId.slice(0, 4)) console.log(`  id="${n.identifier}" type=${n.type} label="${(n.label ?? '').slice(0, 30)}"`);
