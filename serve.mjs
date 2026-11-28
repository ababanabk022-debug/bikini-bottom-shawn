import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('./web', import.meta.url)));
const host = '127.0.0.1';
const defaultPort = 8846;
const args = process.argv.slice(2);
const port = Number(args.find(argument => argument !== '--open') ?? defaultPort);
const openBrowser = process.platform === 'win32' && args.includes('--open');
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
      response.writeHead(404).end();
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if ((await stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      file = resolve(file, 'index.html');
    }
    const type = mime[extname(file)];
    const absolute = await realpath(file);
    if (!type || !absolute.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    const info = await stat(absolute);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(absolute);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : 404).end();
  }
});

if (openBrowser && port === defaultPort) {
  server.once('error', error => {
    if (error.code !== 'EADDRINUSE') throw error;
    server.listen(0, host);
  });
}

server.on('listening', () => {
  const address = `http://${host}:${server.address().port}/`;
  console.log(`Bikini Bottom: ${address}`);
  if (openBrowser) {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', address], { windowsHide: true }, error => {
      if (error) console.error(`Open this address in your browser: ${address}`);
    });
  }
});
server.listen(port, host);
