/** lionidas CLI entry — cac command tree (plan 20260930T092035Z rev 2).
 *  Every handler returns an exit code; --json switches output globally. */
import { cac } from 'cac';
import { version } from './version.ts';
import { authCommand } from './commands/auth.ts';
import { stackCommand } from './commands/stack.ts';
import { caseCommand } from './commands/case.ts';
import { runCommand } from './commands/run.ts';
import { envCommand } from './commands/env.ts';
import { contextCommand } from './commands/context.ts';
import { folderCommand } from './commands/folder.ts';
import { screenCommand } from './commands/screen.ts';
import { suiteCommand } from './commands/suite.ts';
import { setJson, error as outError } from './output.ts';

export async function run(argv: string[]): Promise<number> {
  const cli = cac('lionidas');
  cli.option('--json', 'machine-readable output (every command)');
  cli.help();
  cli.version(version);

  authCommand(cli);
  stackCommand(cli);
  caseCommand(cli);
  runCommand(cli);
  envCommand(cli);
  contextCommand(cli);
  folderCommand(cli);
  screenCommand(cli);
  suiteCommand(cli);

  setJson(argv.includes('--json'));
  // cac strips argv[0..1] (bin + script path) before matching — run() receives
  // bare args, so re-prefix. parse(run:false) sets matchedCommand; we AWAIT
  // runMatchedCommand ourselves (cac does not await async actions inline).
  try {
    cli.parse(['lionidas', 'bin/lionidas.js', ...argv], { run: false });
    if (!cli.matchedCommand) {
      if (cli.options.version) { cli.outputVersion(); return 0; }
      cli.outputHelp();
      return cli.options.help ? 0 : 1;
    }
    await cli.runMatchedCommand();
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    outError(err);
    return 1;
  }
}
