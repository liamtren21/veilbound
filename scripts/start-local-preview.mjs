import { build } from 'esbuild';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const stage = await mkdtemp(join(tmpdir(), 'veilbound-local-preview-'));
const stageProcess = spawn(process.execPath, ['scripts/stage-public-api.mjs', '--game'], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
stageProcess.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
await new Promise((resolve, reject) => {
  stageProcess.once('error', reject);
  stageProcess.once('close', code => code === 0 ? resolve() : reject(new Error('Game staging failed')));
});
const publicDir = join(output.trim(), 'public');
for (const name of ['online-expedition.html', 'google-callback.html', 'google-callback.mjs', 'economy.html', 'economy.css', 'modes.html', 'modes.css', 'waymark-screens.css']) {
  await cp(name, join(publicDir, name));
}
for (const name of ['online-expedition.mjs', 'economy.mjs', 'modes.mjs']) {
  await build({ entryPoints: [name], outfile: join(publicDir, name), bundle: true, format: 'esm' });
}
console.log('Local preview assets: ' + publicDir);
process.env.VEILBOUND_PUBLIC_DIR = publicDir;
process.env.VEILBOUND_DATA_DIR ??= join(stage, 'data');
process.env.VEILBOUND_LOCAL_STARTER ??= 'true';
await import('../server/src/main.mjs');
