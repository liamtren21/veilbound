import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

export function createPublicGame(directory) {
  return async (request, response, pathname) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const file = pathname === '/' ? 'expedition.html' : pathname.slice(1);
    if (!file.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) return false;
    let type = types[extname(file)];
    if (!type) return false;
    let path = join(directory, file);
    const readMetadata = candidate => stat(candidate).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    });
    let metadata = await readMetadata(path);
    if (!metadata && file.endsWith('.png')) {
      path += '.webp';
      metadata = await readMetadata(path);
      type = types['.webp'];
    }
    if (!metadata?.isFile()) return false;
    const etag = '"' + metadata.size.toString(16) + '-' + Math.trunc(metadata.mtimeMs).toString(16) + '"';
    const headers = { 'content-type': type, 'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=0, must-revalidate', etag };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers).end();
      return true;
    }
    response.writeHead(200, { ...headers, 'content-length': metadata.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(path), response).catch(() => response.destroy());
    return true;
  };
}
