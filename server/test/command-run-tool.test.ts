/** command.run tool + prompt-section tests — dynamic skill routing
 *  (brainstorm 20261016T061611Z, frontier-copy design). */
import { describe, expect, it } from 'vitest';
import { COMMANDS, registerCommandRunTool, type ToolRegistryLike } from '../src/agent/commands.ts';
import { LIONIDAS_SYSTEM_PROMPT } from '../src/agent/system-prompt.ts';

function fakeRegistry(): ToolRegistryLike & { tools: Map<string, { execute(args: Record<string, unknown>): Promise<string> }> } {
  const tools = new Map<string, { execute(args: Record<string, unknown>): Promise<string> }>();
  return {
    tools,
    register(tool) { tools.set(tool.name, tool); },
  };
}

describe('command.run tool', () => {
  it('registers on the tool registry', () => {
    const r = fakeRegistry();
    registerCommandRunTool(r);
    expect(r.tools.has('command.run')).toBe(true);
  });

  it('returns the command instruction body for a known name (slash stripped)', async () => {
    const r = fakeRegistry();
    registerCommandRunTool(r);
    const out = await r.tools.get('command.run')!.execute({ name: '/planning' });
    expect(out).toContain('--- COMMAND /planning ACTIVE');
    const spec = COMMANDS.find((c) => c.cmd === '/planning')!;
    expect(out).toContain(spec.instructions);
    // base prompt never rides the tool result (CR1: command body only)
    expect(out).not.toContain('Lionidas test automation');
  });

  it('unknown name → honest error naming the registry', async () => {
    const r = fakeRegistry();
    registerCommandRunTool(r);
    const out = await r.tools.get('command.run')!.execute({ name: 'nope' });
    expect(out).toMatch(/^error: unknown command "nope" — registered: /);
    expect(out).toContain('planning');
    expect(out).toContain('build-diagnose');
  });

  it('every registry command resolves (6 commands)', async () => {
    const r = fakeRegistry();
    registerCommandRunTool(r);
    expect(COMMANDS).toHaveLength(6);
    for (const c of COMMANDS) {
      const out = await r.tools.get('command.run')!.execute({ name: c.cmd });
      expect(out).toContain(`--- COMMAND ${c.cmd} ACTIVE`);
    }
  });
});

describe('system prompt section', () => {
  it('names all 6 commands for dynamic routing', () => {
    const p = LIONIDAS_SYSTEM_PROMPT;
    for (const c of COMMANDS) {
      expect(p).toContain(c.cmd.replace(/^\//, ''));
    }
  });

  it('teaches the command.run invocation', () => {
    const p = LIONIDAS_SYSTEM_PROMPT;
    expect(p).toContain('command.run');
  });

  it('preserves the ordinary-prose rule verbatim (unknown /text is prose)', () => {
    const p = LIONIDAS_SYSTEM_PROMPT;
    expect(p).toContain('is ORDINARY PROSE from the user, not a command');
    expect(p).toContain('never announce "unknown command"');
  });
});
