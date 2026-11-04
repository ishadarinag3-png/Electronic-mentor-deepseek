/* ==========================================================================
   Electronics Mentor — server.mjs
   Zero-dependency Node 18+ server.

   Responsibilities (see AUDIT.md C2 / M9):
     1. Hold DEEPSEEK_API_KEY server-side so it NEVER reaches the browser.
     2. Validate + rate-limit + shape-check every chat request.
     3. Relay DeepSeek's SSE stream to the client verbatim.
     4. Fall back to a clearly-labelled offline demo FAQ when no key is set.
     5. Serve the static shell with security headers, gzip and sane caching.

   Run:   DEEPSEEK_API_KEY=sk-... node server.mjs      (key optional -> demo mode)
   ========================================================================== */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { answerFor } from './lib/demo-mentor.js';

// fileURLToPath leaves a trailing slash on directory URLs and normalize() keeps
// it, which would break the ROOT+sep containment check below — strip it.
const ROOT = normalize(fileURLToPath(new URL('.', import.meta.url))).replace(/[/\\]+$/, '');

// The Arena live-preview embeds this app in an iframe on the sandbox proxy host.
// Allow exactly that origin (and nowhere else); outside the sandbox stay 'none'.
const FRAME_ANCESTORS = process.env.E2B_SANDBOX_ID
  ? `'self' https://${process.env.PORT || 8080}-${process.env.E2B_SANDBOX_ID}.e2b.app`
  : "'none'";
const PORT = Number(process.env.PORT || 8080);
const KEY  = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const UPSTREAM = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT =
  'You are Electronics Mentor: a patient, encouraging tutor for electronics students. ' +
  'Explain circuits, components and calculations step by step. Show formulas in LaTeX ' +
  '($...$ inline, $$...$$ display), use markdown tables and code blocks where helpful, ' +
  'give a worked numeric example, and check the student\u2019s reasoning. ' +
  'Politely redirect topics unrelated to electronics or engineering education.';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
};

// Never serve these, even though some match the extension allow-list.
// NOTE: /lib/ is intentionally NOT denied — it holds the isomorphic modules the
// browser imports (sanitize-config, demo-mentor). Server-only files stay denied.
const DENY = ['/tests/', '/.git', '/node_modules', '/server.mjs',
              '/package-lock.json', '/.env', '/AUDIT.md'];

/* ------------------------------------------------------------ rate limit */
// Token bucket per IP: 20 requests / rolling minute. Swap for Redis in prod.
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60_000) { b = { start: now, n: 0 }; buckets.set(ip, b); }
  if (buckets.size > 10_000) buckets.clear();      // crude memory guard
  b.n += 1;
  return b.n > 20;
}

/* ------------------------------------------------------------ helpers */

function json(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/* Discard an unconsumed request body BEFORE replying early (429/413).
   Without this the unread bytes stay in the socket and desynchronise the
   next request on the same keep-alive connection, hanging the client. */
function drain(req) {
  return new Promise((resolve) => {
    req.resume();
    req.on('end', resolve);
    req.on('error', resolve);
    req.on('aborted', resolve);
  });
}

const GZIP_CACHE = new Map();
function maybeGzip(res, buf, type, req) {
  const compressible = /text\/|javascript|json|svg|manifest/.test(type) && buf.length > 1024;
  if (!compressible || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return buf;
  let gz = GZIP_CACHE.get(buf);
  if (!gz) { gz = zlib.gzipSync(buf, { level: 6 }); GZIP_CACHE.set(buf, gz); }
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  return gz;
}

/* ------------------------------------------------------------ static files */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  if (DENY.some((d) => rel === d || rel.startsWith(d))) { res.writeHead(403); return res.end('Forbidden'); }

  const ext = extname(rel).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); return res.end('Not found'); }

  const abs = normalize(join(ROOT, rel));
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) { res.writeHead(403); return res.end('Forbidden'); }

  try {
    const [info, raw] = await Promise.all([stat(abs), readFile(abs)]);
    const type = MIME[ext];

    // Long-lived immutable cache for hashed/static assets; revalidate the shell.
    const immutable = rel.startsWith('/vendor/') || rel.startsWith('/public/');
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable'
                                             : 'no-cache');
    res.setHeader('ETag', `"${info.size}-${info.mtimeMs.toString(36)}"`);
    if (req.headers['if-none-match'] === res.getHeader('ETag')) { res.writeHead(304); return res.end(); }

    const out = maybeGzip(res, raw, type, req);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': out.length });
    res.end(out);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

/* ------------------------------------------------------------ /api/chat */

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleChat(req, res, ip) {
  if (rateLimited(ip)) {
    await drain(req);
    return json(res, 429, { error: 'Too many messages. Please wait a minute.' });
  }

  let raw;
  try { raw = await readBody(req, 1_500_000); }
  catch (e) {
    await drain(req);
    return json(res, e.code === 'TOO_LARGE' ? 413 : 400,
                { error: 'Request body rejected.' },
                e.code === 'TOO_LARGE' ? { Connection: 'close' } : {});
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return json(res, 400, { error: 'Invalid JSON body.' }); }

  // Whitelist the shape. Never forward raw client objects upstream.
  const msgs = (Array.isArray(parsed.messages) ? parsed.messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  if (!msgs.length) return json(res, 400, { error: 'No valid messages supplied.' });

  const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };

  // Reliable client-disconnect signal. NOTE: `req.destroyed` is already `true`
  // once the request body has been fully consumed, so it must NOT be used to
  // detect a departed client mid-stream (it would abort on the first chunk).
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  /* -------- Demo path: no key configured -------- */
  if (!KEY) {
    res.writeHead(200, headers);
    const text = answerFor(msgs);
    // Stream in small chunks so the UI exercises real SSE end to end.
    const chunks = text.match(/[\s\S]{1,28}/g) || [text];
    for (const c of chunks) {
      if (clientGone || res.writableEnded) return;
      sseWrite(res, { choices: [{ delta: { content: c } }] });
      await new Promise((r) => setTimeout(r, 14));
    }
    if (!clientGone && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }

  /* -------- Real path: relay DeepSeek SSE verbatim -------- */
  msgs.unshift({ role: 'system', content: SYSTEM_PROMPT });

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages: msgs, stream: true,
                             max_tokens: 1024, temperature: 0.3 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return json(res, 504, { error: 'Could not reach the model provider.', detail: String(err.message) });
  }

  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 300); } catch { /* ignore */ }
    return json(res, 502, { error: `Model provider returned ${upstream.status}.`, detail });
  }

  res.writeHead(200, headers);
  try {
    for await (const chunk of upstream.body) {
      if (clientGone || res.writableEnded) { upstream.body.cancel?.(); return; }
      res.write(chunk);                              // pass SSE through untouched
    }
  } catch { /* client went away mid-stream */ }
  if (!res.writableEnded) res.end();
}

/* ------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';

  // Security headers on every response (M9). style-src keeps 'unsafe-inline'
  // only because KaTeX emits inline styles; script-src stays strict.
  // NOTE: no X-Frame-Options — CSP frame-ancestors governs framing, and a DENY
  // here would block the sandbox live-preview iframe.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; " +
    `base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/config') {
    return json(res, 200, { demo: !KEY, model: KEY ? MODEL : null });
  }
  if (path === '/api/chat' && req.method === 'POST') return handleChat(req, res, ip);
  if (path.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  return serveStatic(req, res, path);
});

server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Electronics Mentor on http://0.0.0.0:${PORT}  (${KEY ? 'DeepSeek: ' + MODEL : 'DEMO MODE — no API key'})`);
});
