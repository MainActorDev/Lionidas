// A6 design input: AX coverage audit for the Lion Parcel app.
import { crucibleAlloy } from '../src/alloy/client.ts';
import { initAlloyRuntime } from '../src/alloy/runtime.ts';

const UDID = '30B28173-D2C6-4D1A-B544-49EB4BEF7A4D';
const rt = await initAlloyRuntime();
const alloy = crucibleAlloy();
const snap = await alloy.dispatch('alloy_snapshot', { udid: UDID, interactiveOnly: false }, rt.deps);
if (!snap.ok) { console.log('snap error:', JSON.stringify(snap.error).slice(0, 300)); process.exit(1); }
const nodes = snap.result?.nodes ?? [];
const app = nodes.find((n) => n.type === 'Application');
console.log(`app: ${app?.label ?? '?'} | total nodes: ${nodes.length}`);

// coverage stats over ALL nodes and over hittable (actually tappable) ones
function stats(ns, tag) {
  const withId = ns.filter((n) => n.identifier);
  const withLabel = ns.filter((n) => n.label);
  console.log(`${tag}: ${ns.length} nodes | id: ${withId.length} (${Math.round(withId.length / ns.length * 100)}%) | label: ${withLabel.length} (${Math.round(withLabel.length / ns.length * 100)}%)`);
  return { withId, withLabel };
}
stats(nodes, 'all     ');
const hittable = nodes.filter((n) => n.hittable);
stats(hittable, 'hittable');

// type breakdown for hittable nodes without identifier — the A6 fallback population
const byType = {};
for (const n of hittable) {
  const k = `${n.type}${n.identifier ? '+id' : ''}${!n.identifier && n.label ? '+label' : ''}`;
  byType[k] = (byType[k] ?? 0) + 1;
}
console.log('hittable type breakdown:', JSON.stringify(byType));

// sample: what do the identifiers actually look like?
for (const n of hittable.filter((n) => n.identifier).slice(0, 6)) {
  console.log(`  id="${n.identifier}" type=${n.type} label="${(n.label ?? '').slice(0, 36)}"`);
}
// sample: hittable WITHOUT id — what would the fallback rely on?
for (const n of hittable.filter((n) => !n.identifier).slice(0, 6)) {
  console.log(`  [no id] type=${n.type} label="${(n.label ?? '').slice(0, 36)}" value="${String(n.value ?? '').slice(0, 20)}"`);
}
