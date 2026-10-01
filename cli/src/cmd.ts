/** shared command registration helper: every subcommand gets --json (cac
 *  scopes options per-command; a root-only option trips Unknown option). */
import type { CAC, Command } from 'cac';

export function sub(cli: CAC, name: string, description: string): Command {
  const c = cli.command(name, description);
  c.option('--json', 'machine-readable output');
  return c;
}
