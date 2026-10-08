/** Env-field secrets (Phase 2 T3, plan 20261008T103310Z): the operator sets
 *  tokens where the server runs (.env / launchd / docker env). The app NEVER
 *  holds secret values in the DB or renders them — this module exposes
 *  PRESENCE ONLY (for the Settings mirror) plus the read points the engine
 *  uses. Container-ready by construction (12-factor env config). */

export const GITHUB_TOKEN_ENV = 'CRUCIBLE_GITHUB_TOKEN';
// NOTE: Jira auth is ALREADY env-configured in this codebase — the agent
// GC reads JIRA_TOKEN and SSO reads CRUCIBLE_JIRA_CLIENT_ID/SECRET. The
// mirror reflects the existing key (survey finding, review R3).
export const JIRA_TOKEN_ENV = 'JIRA_TOKEN';

export interface SecretStatus {
  githubToken: boolean;
  jiraToken: boolean;
  /** env key names, surfaced so the Settings mirror can tell the operator
   *  exactly what to set — values are never read here */
  keys: { githubToken: string; jiraToken: string };
}

/** Presence-only: booleans + key names. Values never leave the process. */
export function secretStatus(env: NodeJS.ProcessEnv = process.env): SecretStatus {
  return {
    githubToken: Boolean(env[GITHUB_TOKEN_ENV] && env[GITHUB_TOKEN_ENV]!.length > 0),
    jiraToken: Boolean(env[JIRA_TOKEN_ENV] && env[JIRA_TOKEN_ENV]!.length > 0),
    keys: { githubToken: GITHUB_TOKEN_ENV, jiraToken: JIRA_TOKEN_ENV },
  };
}

/** The GitHub token clone/pull should use, when the project has none of its
 *  own: the env field, else nothing (ambient credentials). */
export function envGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[GITHUB_TOKEN_ENV];
  return v && v.length > 0 ? v : null;
}
