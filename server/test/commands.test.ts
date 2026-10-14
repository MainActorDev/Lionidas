/** Commands-as-chat-turns (plan 20261013T144145Z): registry, ordering, overlay
 *  composition (CR1 sentinel), tool intersection (CR3), route acceptance. */

import { describe, expect, it } from 'vitest';
import { COMMANDS, orderCommands, overlayBlock, toolsFor, commandByCmd } from '../src/agent/commands.ts';

describe('command registry', () => {
  it('the registered commands registered with order + descriptions', () => {
    expect(COMMANDS.map((c) => c.cmd)).toEqual(['/planning', '/breakdown', '/author', '/implement-identifiers', '/recipe-propose', '/recipe-diagnose']);
    expect(COMMANDS.every((c) => c.description.length > 0 && c.instructions.length > 200)).toBe(true);
  });

  it('CR1: instructions contain NO embedded base prompt (author strips it)', () => {
    const sentinel = 'ask about cases, runs, or draft new tests';
    for (const c of COMMANDS) expect(c.instructions).not.toContain(sentinel);
  });

  it('engine order regardless of typing order; dedupes', () => {
    expect(orderCommands(['/author', '/planning']).map((c) => c.cmd)).toEqual(['/planning', '/author']);
    expect(orderCommands(['/breakdown', '/planning', '/planning']).map((c) => c.cmd)).toEqual(['/planning', '/breakdown']);
  });

  it('overlay block: one ACTIVE header per command', () => {
    const blk = overlayBlock(orderCommands(['/author', '/planning']));
    expect(blk).toContain('--- COMMAND /planning ACTIVE');
    expect(blk).toContain('--- COMMAND /author ACTIVE');
    expect(blk.match(/ACTIVE/g)?.length).toBe(2);
  });

  it('CR3: tools INTERSECT the envelope, never expand', () => {
    const env = ['cases.list', 'notes.read', 'jira.get'];
    const t = toolsFor(orderCommands(['/planning']), env);
    expect(t).toEqual(['cases.list', 'notes.read']); // repo.* not in envelope → dropped, not added
    expect(toolsFor(orderCommands(['/author']), env)).toBeNull(); // author has no tools list
  });

  it('commandByCmd + unknown → undefined', () => {
    expect(commandByCmd('/planning')?.order).toBe(1);
    expect(commandByCmd('/nope')).toBeUndefined();
  });
});
