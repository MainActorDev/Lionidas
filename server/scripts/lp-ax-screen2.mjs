// navigate to account tab, re-audit — two-screen coverage check
import { crucibleAlloy } from '../src/alloy/client.ts';
import { initAlloyRuntime } from '../src/alloy/runtime.ts';
const UDID = '30B28173-D2C6-4D1A-B544-49EB4BEF7A4D';
const rt = await initAlloyRuntime();
const alloy = crucibleAlloy();
const snap1 = await alloy.dispatch('alloy_snapshot', { udid: UDID, interactiveOnly: false }, rt.deps);
const tab = snap1.result.nodes.find((n) => n.identifier === 'ic_tabbar_account_inactive');
if (!tab) { console.log('tab icon not found'); process.exit(0); }
const { x, y, width, height } = tab.rect;
const tap = await alloy.dispatch('alloy_act', { udid: UDID, action: 'press', target: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) } }, rt.deps);
console.log('tap ok:', tap.ok);
await new Promise((r) => setTimeout(r, 2500));
const snap2 = await alloy.dispatch('alloy_snapshot', { udid: UDID, interactiveOnly: false }, rt.deps);
const nodes = snap2.result?.nodes ?? [];
const app = nodes.find((n) => n.type === 'Application');
console.log(`screen 2 app: ${app?.label ?? '?'} | nodes: ${nodes.length}`);
const hittable = nodes.filter((n) => n.hittable);
const withId = hittable.filter((n) => n.identifier);
const withLabel = hittable.filter((n) => n.label);
console.log(`hittable: ${hittable.length} | id: ${withId.length} (${Math.round(withId.length / Math.max(hittable.length, 1) * 100)}%) | label: ${withLabel.length} (${Math.round(withLabel.length / Math.max(hittable.length, 1) * 100)}%)`);
for (const n of withId.slice(0, 8)) console.log(`  id="${n.identifier}" type=${n.type}`);
for (const n of hittable.filter((n) => !n.identifier).slice(0, 8)) console.log(`  [no id] type=${n.type} label="${(n.label ?? '').slice(0, 40)}"`);
