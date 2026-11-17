import { cp, mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = await mkdtemp(join(tmpdir(), 'veilbound-public-api-'));
const paths = [
  'Dockerfile', '.dockerignore', 'railway.json',
  'server/package.json', 'server/package-lock.json', 'server/src',
  'shared', 'scripts/reconcile-checkpoint-rewards.mjs',
  'deployments/testnet.config.json',
  ...(await readdir(join(root, 'config'))).filter(name => name.endsWith('.json')).map(name => 'config/' + name),
  ...(await readdir(root)).filter(name => /^expedition-.*(?<!\.test)\.mjs$/.test(name)),
];
const publicFile = path => !/^(?:\.env|\.git)/i.test(path.split(/[\\/]/).at(-1)) &&
  !/\.(?:pem|key|sqlite(?:-wal|-shm)?)$/i.test(path);
for (const path of paths) {
  const target = join(destination, path);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, path), target, { recursive: true, filter: publicFile });
}
if (process.argv.includes('--game')) {
  const files = ['journey-share.html', 'journey-share.mjs', 'expedition.html', 'expedition-login.html', 'google-callback.html', 'google-callback.mjs', 'expedition.mjs', 'expedition.css', 'combat-camera.mjs',
    'boss-encounter-effects.mjs', 'boss-encounter-actions.mjs', 'combat-assets',
    'node_modules/three/build/three.module.js', 'node_modules/three/build/three.core.js',
    ...(await readdir(root)).filter(name => /^expedition-.*\.(?:css|mjs)$/.test(name) && !name.endsWith('.test.mjs'))];
  for (const file of files) {
    const target = join(destination, 'public', file.replace(/^node_modules\//, 'vendor/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, file), target, { recursive: true, filter: publicFile });
  }
  const { build } = await import('esbuild');
  await build({ entryPoints: [join(root, 'expedition-login.mjs')], outfile: join(destination, 'public', 'expedition-login.mjs'),
    bundle: true, format: 'esm' });
  for (const name of ['expedition-dice-vfx.mjs', 'expedition-battle-vfx.mjs']) {
    const effect = join(destination, 'public', name);
    await writeFile(effect, (await readFile(effect, 'utf8')).replace('./node_modules/three/', './vendor/three/'));
  }
  const docker = join(destination, 'Dockerfile');
  await writeFile(docker, (await readFile(docker, 'utf8')) +
    '\nCOPY --chown=node:node public/ /app/public/\nENV VEILBOUND_PUBLIC_DIR=/app/public\n');
}
console.log(destination);
