import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const [stage, apiOrigin] = process.argv.slice(2);
if (!stage || !apiOrigin) throw new Error('Usage: stage-vercel-frontend.mjs COMPACT_GAME_STAGE HTTPS_API_ORIGIN');
const api = new URL(apiOrigin);
if (api.protocol !== 'https:' || api.origin !== apiOrigin) throw new Error('Expected an HTTPS API origin');
const destination = await mkdtemp(join(tmpdir(), 'veilbound-testnet-web-'));
await cp(resolve(stage, 'public'), destination, { recursive: true });

async function prepare(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'vendor') await prepare(path);
    if (!entry.isFile()) continue;
    if (path.endsWith('.png.webp')) await rename(path, path.slice(0, -9) + '.webp');
    else if (['.mjs', '.css', '.html', '.json'].includes(extname(path))) {
      await writeFile(path, (await readFile(path, 'utf8')).replaceAll('.png', '.webp'));
    }
  }
}
const root = fileURLToPath(new URL('../', import.meta.url));
const onlineAssets = ['expedition-login.html', 'google-callback.html', 'google-callback.mjs', 'online-expedition.html', 'economy.html', 'economy.css', 'modes.html', 'modes.css', 'waymark-screens.css'];
for (const name of onlineAssets) await cp(join(root, name), join(destination, name));
for (const name of ['expedition-login.mjs', 'online-expedition.mjs', 'economy.mjs', 'modes.mjs']) {
  await build({
    entryPoints: [join(root, name)],
    outfile: join(destination, name),
    bundle: true,
    format: 'esm',
    minify: true,
  });
}
await prepare(destination);
await rename(join(destination, 'expedition.html'), join(destination, 'index.html'));
await writeFile(join(destination, 'vercel.json'), JSON.stringify({
  framework: null,
  rewrites: [
    { source: '/api/:path*', destination: api.origin + '/api/:path*' },
    { source: '/health', destination: api.origin + '/health' },
  ],
}, null, 2));
console.log(destination);
