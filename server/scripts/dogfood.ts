/** Dogfood: first real-app E2E through Crucible.
 *  Generates the DOGFOOD-1 flow set (engine-canonical layout from the gitignored
 *  engines config) against the real consumer DEV app and enqueues it. Run against
 *  a LIVE server (the dispatcher is what executes it): `tsx scripts/dogfood.ts`. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const enginesCfg = JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as {
  engineB: { flowsDirSegments?: string[] };
};
const segments = enginesCfg.engineB.flowsDirSegments ?? ['flows'];
const FLOWS = join('/tmp/crucible-dogfood', ...segments);
mkdirSync(FLOWS, { recursive: true });

const APP = 'com.lionparcel.services.consumer-dev';

writeFileSync(
  join(FLOWS, 'onboarding-smoke.yaml'),
  `# AC metadata (scanned by crucible; ignored by the flow engine)
ticket: DOGFOOD-1
ac_id: AC-1
ac_text: "App launches to the membership onboarding screen"
category: visual
name: onboarding-smoke
steps:
  - launch: ${APP}
  - await:
      visible: "Lanjutkan Tanpa Akun"
    optional: true
`,
);

writeFileSync(
  join(FLOWS, 'login-nav.yaml'),
  `# AC metadata (scanned by crucible; ignored by the flow engine)
ticket: DOGFOOD-1
ac_id: AC-2
ac_text: "Tapping Masuk opens the login screen"
category: interaction
name: login-nav
steps:
  - launch: ${APP}
  - await:
      visible: "Lanjutkan Tanpa Akun"
    optional: true
  - tap: "Masuk"
  - await:
      visible: "Daftar"
`,
);

const UDID = process.argv[2] ?? '5640A847-E6A8-4293-A139-066B11F2CEA6';
const base = process.env['CRUCIBLE_URL'] ?? 'http://127.0.0.1:8787';
const res = await fetch(`${base}/api/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ticketKey: 'DOGFOOD-1',
    flowsDir: FLOWS,
    udid: UDID,
    app: APP,
    artifactPath: '/tmp/alloy-demo-app/LionParcel.app',
    triggeredBy: 'dogfood',
    priority: 'manual',
    triage: true,
  }),
});
console.log('POST /api/runs →', res.status, JSON.stringify(await res.json()));
