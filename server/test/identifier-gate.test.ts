/** Identifier gate tests (plan 20261014T132710Z Phase I step 3). */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { reindexBundle, lookupIdentifier, conventionFor, ensureIdentifierTables } from '../src/agent/identifier-index.ts';
import { resolveCaseRefs } from '../src/routes/templates.ts';

let tmp: string;
let db: Database.Database;
let repoA: string;

const SWIFT = `
import SwiftUI
struct PayView: View {
  var body: some View {
    VStack {
      Button("Pay Now") {}
        .accessibilityIdentifier("btn_pay_now")
      Text("Total")
        .accessibilityIdentifier("lbl_total")
      TextField("Search", text: .constant(""))
        .accessibilityIdentifier(fieldId)
    }
  }
}
`;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ident-gate-'));
  db = new Database(join(tmp, 'c.db'));
  db.exec(`CREATE TABLE app_catalog(bundle TEXT PRIMARY KEY); INSERT INTO app_catalog VALUES ('com.x.app');
  CREATE TABLE templates(id TEXT PRIMARY KEY); CREATE TABLE scenarios(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE presets(id TEXT PRIMARY KEY, method TEXT, path_pattern TEXT); CREATE TABLE scenario_overrides(scenario_id TEXT, preset_id TEXT, enabled INTEGER);`);
  repoA = join(tmp, 'app-repo');
  mkdirSync(join(repoA, 'Features'), { recursive: true });
  writeFileSync(join(repoA, 'Features', 'PayView.swift'), SWIFT);
  mkdirSync(join(repoA, '.wt'), { recursive: true });
  writeFileSync(join(repoA, '.wt', 'ignored.swift'), '.accessibilityIdentifier("wt_ghost")');
});
afterAll(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('index builder (working tree scan, review PR1)', () => {
  it('literals + dynamic extracted with file:line; dot-dirs skipped', () => {
    const meta = reindexBundle(db, 'com.x.app', 'app-repo', repoA);
    expect(meta.files).toBe(1); // .wt excluded
    const lit = lookupIdentifier(db, 'com.x.app', 'btn_pay_now');
    expect(lit.state).toBe('literal');
    expect(lit.detail).toContain('PayView.swift:');
    expect(lookupIdentifier(db, 'com.x.app', 'lbl_total').state).toBe('literal');
    expect(lookupIdentifier(db, 'com.x.app', 'wt_ghost').state).toBe('missing'); // .wt never indexed
    const dyn = lookupIdentifier(db, 'com.x.app', 'anything_dynamic');
    expect(dyn.state).toBe('missing'); // dynamic rows are CONTEXT ONLY (v1 tightened)
    expect(dyn.detail).toMatch(/dynamic call sites exist/);
  });

  it('convention mining finds the dominant prefix', () => {
    expect(conventionFor(db, 'com.x.app')).toMatch(/btn_ \(1 of 2/);
  });

  it('no index → honest no-index state', () => {
    expect(lookupIdentifier(db, 'com.other.app', 'x').state).toBe('no-index');
  });
});

describe('the gate (resolveCaseRefs)', () => {
  const base = { name: 't', app: 'com.x.app' };

  it('present identifier passes', () => {
    expect(resolveCaseRefs(db, { ...base, steps: [{ idx: 1, action: 'tap', selector: { identifier: 'btn_pay_now' } }] } as never, null)).toBeNull();
  });

  it('ABSENT identifier hard-blocks with the actionable message', () => {
    const err = resolveCaseRefs(db, { ...base, steps: [{ idx: 2, action: 'tap', selector: { identifier: 'btn_ghost' } }] } as never, null);
    expect(err).toMatch(/identifier gate: tap 2 uses identifier "btn_ghost" which does not exist/);
    expect(err).toMatch(/Use \/implement-identifiers/);
  });

  it('mapping form {identifier:} gated too; setup steps covered', () => {
    const err = resolveCaseRefs(db, { ...base, setup: [{ idx: 1, action: 'tap', selector: { identifier: 'btn_missing' } }], steps: [{ idx: 1, action: 'expect', selector: { identifier: 'btn_pay_now' } }] } as never, null);
    expect(err).toMatch(/btn_missing/);
  });

  it('labels and coordinates are NOT gated (runtime-only selectors)', () => {
    expect(resolveCaseRefs(db, { ...base, steps: [{ idx: 1, action: 'tap', selector: { label: 'Pay Now' } }] } as never, null)).toBeNull(); // non-IDENT_RE string = label
    expect(resolveCaseRefs(db, { ...base, steps: [{ idx: 1, action: 'tap', x: 10, y: 20 }] } as never, null)).toBeNull();
  });

  it('unknown identifier near dynamic call sites BLOCKS with dynamic context (tightened policy)', () => {
    const err = resolveCaseRefs(db, { ...base, steps: [{ idx: 1, action: 'tap', selector: { identifier: 'some_dynamic_id' } }] } as never, null);
    expect(err).toMatch(/some_dynamic_id/);
    expect(err).toMatch(/dynamic call sites exist/); // context guides /implement-identifiers
  });

  it('registered app WITHOUT index → ingest-first error; UNREGISTERED app → gate skips (runtime-only world)', () => {
    db.exec("INSERT OR REPLACE INTO app_catalog VALUES ('com.registered-noindex')");
    const err = resolveCaseRefs(db, { name: 't', app: 'com.registered-noindex', steps: [{ idx: 1, action: 'tap', selector: { identifier: 'btn_x' } }] } as never, null);
    expect(err).toMatch(/no identifier index for com.registered-noindex/);
    // unregistered: identifiers unverifiable — no block, no index demand
    expect(resolveCaseRefs(db, { name: 't', app: 'com.never-registered', steps: [{ idx: 1, action: 'tap', selector: { identifier: 'btn_anything' } }] } as never, null)).toBeNull();
  });
});
