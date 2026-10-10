/** capabilitiesFor(role) — the RBAC matrix rendered to booleans (plan
 *  20261009T102032Z, review findings applied). SINGLE source of truth:
 *  route guards call it directly where convenient, `GET /api/me/capabilities`
 *  serves it to the web, and the T6 boundary suite asserts the same map.
 *
 *  Matrix (settled with the operator 2026-10-09):
 *  - VIEWER: read all minus sensitive (env values, users, settings/secrets,
 *    device internals, manual-session recordings — recordings carry raw
 *    typed credentials, review F1)
 *  - OPERATOR (QA): full QA work; abort/delete OWN runs only
 *  - SUPERVISOR (QA lead): operator + abort/delete any, users directory +
 *    create/reset/deactivate, audit log
 *  - ADMIN: everything
 *  - BOT: pipeline-only — capabilities are human-shaped; bots pass only
 *    where a route explicitly allows them (roles.ts bot rule), never via
 *    this map. */
import type { Role } from './users.ts';

export interface Capabilities {
  /** read runs/evidence/cases/suites/devices/builds listings */
  readOverview: boolean;
  /** read env-var values (false = masked) */
  readEnvValues: boolean;
  /** read users directory */
  readUsers: boolean;
  /** read settings/secrets status, setup, device enrollment internals */
  readSettings: boolean;
  /** read manual-session recordings/frames/thumbs (raw typed text) */
  readManualSessions: boolean;
  /** run cases & suites */
  play: boolean;
  /** manual drive: take control + input verbs */
  drive: boolean;
  /** device actions: boot/restart/shutdown/uninstall/install */
  deviceActions: boolean;
  /** author/edit cases, folders, screens, env scenarios, env-var CRUD */
  authorCases: boolean;
  /** trigger builds, connect repos */
  builds: boolean;
  /** abort or delete runs: 'none' | 'own' | 'any' */
  abortDelete: 'none' | 'own' | 'any';
  /** users DB: create / reset password / deactivate */
  manageAccounts: boolean;
  /** users DB: change roles, approve, delete + settings/setup/secrets */
  adminOnly: boolean;
  /** audit log read */
  audit: boolean;
}

export function capabilitiesFor(role: Role): Capabilities {
  switch (role) {
    case 'viewer':
      return {
        readOverview: true, readEnvValues: false, readUsers: false, readSettings: false,
        readManualSessions: false, play: false, drive: false, deviceActions: false,
        authorCases: false, builds: false, abortDelete: 'none', manageAccounts: false,
        adminOnly: false, audit: false,
      };
    case 'operator':
      return {
        readOverview: true, readEnvValues: true, readUsers: false, readSettings: false,
        readManualSessions: true, play: true, drive: true, deviceActions: true,
        authorCases: true, builds: true, abortDelete: 'own', manageAccounts: false,
        adminOnly: false, audit: false,
      };
    case 'supervisor':
      return {
        readOverview: true, readEnvValues: true, readUsers: true, readSettings: false,
        readManualSessions: true, play: true, drive: true, deviceActions: true,
        authorCases: true, builds: true, abortDelete: 'any', manageAccounts: true,
        adminOnly: false, audit: true,
      };
    case 'admin':
      return {
        readOverview: true, readEnvValues: true, readUsers: true, readSettings: true,
        readManualSessions: true, play: true, drive: true, deviceActions: true,
        authorCases: true, builds: true, abortDelete: 'any', manageAccounts: true,
        adminOnly: true, audit: true,
      };
    case 'bot':
      // Bots are not capability-driven (roles.ts bot rule handles them);
      // the map reflects their real surface: pipeline reads + runs.
      return {
        readOverview: true, readEnvValues: true, readUsers: false, readSettings: false,
        readManualSessions: true, play: true, drive: false, deviceActions: false,
        authorCases: false, builds: false, abortDelete: 'none', manageAccounts: false,
        adminOnly: false, audit: false,
      };
  }
}
