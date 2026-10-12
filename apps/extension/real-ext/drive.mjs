// A long-lived driver for exploring by hand: one Chromium with the extension stays up, and
// each POST to http://127.0.0.1:49600/ runs its body as an async function of (env, S, lib),
// where env is what lib.launch() returns and S is scratch state kept between posts. See
// README.md; ./d.sh posts a snippet.
import http from 'node:http';
import * as lib from './lib.mjs';

const tone = lib.serveTone();
const env = await lib.launch({
  profile: process.env.PROFILE ?? 'drive',
  scale: Number(process.env.SCALE ?? 1),
  fresh: process.env.FRESH !== '0',
});
const S = {};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const out = await new AsyncFunction('env', 'S', 'lib', body)(env, S, lib);
    res.end((typeof out === 'string' ? out : JSON.stringify(out, null, 1)) + '\n');
  } catch (e) {
    res.statusCode = 500;
    res.end('ERR ' + (e.stack ?? e) + '\n');
  }
});
server.listen(Number(process.env.DPORT ?? 49600), '127.0.0.1');
process.on('SIGTERM', async () => {
  await env.close();
  tone.close();
  server.close();
  process.exit(0);
});
console.log('driver ready', env.id);
