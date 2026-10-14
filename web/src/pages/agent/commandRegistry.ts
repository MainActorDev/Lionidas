/** Shared command list for the web (CR4: the FALLBACK is this single module —
 *  the live registry is GET /api/agent/commands; on fetch failure we degrade
 *  to these defaults rather than a dead palette). */
export interface CommandLite { cmd: string; description: string; order: number }
export const DEFAULT_COMMANDS: CommandLite[] = [
  { cmd: '/planning', description: 'Plan test cases from a request', order: 1 },
  { cmd: '/breakdown', description: 'Break a plan into concrete steps', order: 2 },
  { cmd: '/author', description: 'Author case YAML drafts', order: 3 },
  { cmd: '/implement-identifiers', description: 'Implement missing a11y identifiers in app code', order: 4 },
  { cmd: '/recipe-propose', description: 'Propose a build recipe for a blocked repo', order: 5 },
  { cmd: '/recipe-diagnose', description: 'Diagnose a failed verify build', order: 6 },
];
