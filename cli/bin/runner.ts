/** bin runner: imports run() and exits with its code (the bin spawns tsx on
 *  THIS file; src/main.ts only exports). */
import { run } from '../src/main.ts';

const code = await run(process.argv.slice(2));
process.exit(code);
