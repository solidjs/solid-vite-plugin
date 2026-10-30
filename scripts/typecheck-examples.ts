// Type-checks every example that has a tsconfig.json, against the built
// plugin's types (run `pnpm build` first).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const examples = readdirSync('examples').filter((name) =>
  existsSync(path.join('examples', name, 'tsconfig.json')),
);

let failed = false;
for (const name of examples) {
  try {
    execFileSync('tsc', ['--noEmit', '-p', path.join('examples', name, 'tsconfig.json')], {
      stdio: 'inherit',
    });
    console.log(`ok ${name}`);
  } catch {
    console.error(`failed ${name}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
