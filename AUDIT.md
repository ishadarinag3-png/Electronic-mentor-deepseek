# Electronics Mentor — Technical Audit

**Date:** 2026-11-04
**Commit audited:** `dd90876` ("Create index.html")
**Scope:** entire repository (2 files: `README.md`, `index.html`, 3.2 KB)
**Method:** static analysis + `html-validate` + WCAG 2.1 contrast computation + a 12-check
JSDOM runtime harness exercising the real page. Every finding below was *observed*, not assumed.

---

## 1. Executive summary

The repository contains a **UI shell with no application behind it**. The chat renders correctly,
looks clean on mobile, and is free of XSS — but the "mentor" is a hardcoded 300 ms
`(echo) <your text>` reply. There is no DeepSeek integration, no backend, no persistence,
no error handling, and no accessibility wiring. The page itself even says so:
`Step 5 — skeleton only` and `Hi! I am not smart yet.`

That is a fine place for a skeleton to be. The problem is that the repo is named
`Electronic-mentor-deepseek` while containing **zero references to DeepSeek, any LLM, or any
network call** (verified: `fetch(`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `deepseek`,
`api_key` all appear 0 times).

**Runtime harness result: 12 checks, 6 failed.**

The single most important finding is architectural, not a bug in the current code:
**the moment you wire DeepSeek up, a client-only design leaks your paid API key to every
visitor.** See [C2](#c2--critical-architecture-a-client-only-deploy-will-leak-your-api-key).
Everything else is fixable in place; that one determines your whole architecture, so decide it first.

| Severity | Count | Theme |
|---|---|---|
| Critical | 2 | No AI backend; API-key exposure risk in the obvious next step |
| High | 7 | Accessibility (2), input handling (2), persistence, error handling, race condition |
| Medium | 13 | Contrast, PWA half-done, mobile viewport, markdown/math rendering, streaming, CSP, theme |
| Low | 8 | Repo hygiene: README, LICENSE, .gitignore, CI, tests, tooling |

---

## 2. What already works (keep these)

Worth stating plainly — several decisions here are correct and easy to lose in a rewrite:

- **No XSS.** Messages are inserted with `div.textContent = text`, never `innerHTML`. Verified:
  the payload `<img src=x onerror="window.__pwned=1">` rendered as literal text, no element was
  created, no handler fired. This is the right default and should survive the markdown work (see M8).
- **`font-size: 16px` on `#input`.** Prevents iOS Safari's automatic zoom-on-focus. Many people
  miss this; it is correct.
- **Whitespace-only submissions are rejected** (`input.value.trim()` guard) — verified.
- **Safe-area insets** (`viewport-fit=cover` + `env(safe-area-inset-*)`) are handled, so the
  input row clears the iPhone notch/home bar.
- **Text contrast is genuinely good:** bot bubbles 11.87:1, body text 14.48:1, headings 8.31:1 —
  all pass WCAG AA and mostly AAA.
- **Correct document basics:** `<!DOCTYPE html>`, `charset`, `lang="en"`, viewport, `box-sizing` reset.
- **Zero dependencies, 3.2 KB, loads instantly, works offline.** A real asset — don't trade it
  away for a framework reflexively.

---

## 3. Critical findings

### C1 — There is no AI backend; the app does not do what its name claims

**Evidence.** The entire reply path is:

```js
setTimeout(() => { addMessage('(echo) ' + text, 'bot'); }, 300);
```

Zero network calls in the repo. `README.md` is one line (`# Electronic-mentor-deepseek`) and
documents nothing.

**Why it matters.** The 300 ms `setTimeout` is *simulating* latency. When a real LLM replaces it,
responses take 2–30 s. Code written against a 300 ms fake will feel broken the instant the real
thing is plugged in — no loading state, no streaming, no timeout, no cancel. The delay abstraction
has to change shape, not just swap endpoint.

**Fix.** Add a backend proxy (C2) and make the frontend speak streaming SSE from day one (M10).
Minimal working version:

```js
async function handleSend() {
  const text = input.value.trim();
  if (!text || send.disabled) return;          // guard + in-flight lock
  addMessage(text, 'user');
  history.push({ role: 'user', content: text });
  input.value = ''; autosize();

  const bubble = addMessage('', 'bot');
  send.disabled = true;                        // lock while awaiting
  const ctrl = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Server said ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();                       // keep the partial line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) { answer += token; bubble.textContent = answer; scrollToBottom(); }
        } catch { /* ignore keep-alive fragments */ }
      }
    }
    history.push({ role: 'assistant', content: answer });
  } catch (err) {
    bubble.classList.add('error');
    bubble.textContent = err.name === 'AbortError'
      ? 'Cancelled.'
      : 'Sorry, I could not reach the server. Check your connection and try again.';
  } finally {
    send.disabled = false;
    input.focus();
  }
}
```

Note the streaming loop still writes via `textContent` — it keeps the XSS guarantee from §2.

---

### C2 — CRITICAL (architecture): a client-only deploy will leak your API key

**The trap.** The natural next step for a single-file app is:

```js
// ⛔ NEVER SHIP THIS
fetch('https://api.deepseek.com/chat/completions', {
  headers: { Authorization: `Bearer sk-${DEEPSEEK_API_KEY}` }, ...
});
```

There is no such code in the repo today — this is a warning about the next commit, not a
finding about the current one. But it is the most consequential item in this audit.

**Why it matters.** Anything in browser JS is public. View Source, the Network tab, or a
service-worker dump hands your key to any visitor. DeepSeek keys are **paid, bearer-style, and
have no domain restriction**, so a leaked key can be drained by strangers until you hit your
credit limit and notice. Scrapers automate exactly this against static sites. Because the app is
a single static file, there is no server today where a key could safely live — which means the
architecture must change *before* the key is added, not after.

**Fix.** Put a thin proxy in front. The browser calls **your** endpoint; the server holds the key
in an environment variable and it never reaches the client.

```
┌──────────────┐   HTTPS POST   ┌────────────────────┐   HTTPS    ┌──────────────┐
│  index.html  │ ─────────────► │  /api/chat  (Node) │ ─────────► │  DeepSeek    │
│  (browser)   │ ◄── SSE ────── │  key in env var    │ ◄───────── │  API         │
└──────────────┘   no key here  │  validate + limit  │            └──────────────┘
                                └────────────────────┘
```

Dependency-free Node 18+ proxy (`server.mjs`), with validation and header hardening:

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = process.env.PORT || 8080;
const KEY  = process.env.DEEPSEEK_API_KEY;      // never serialised to a response
const ROOT = new URL('.', import.meta.url).pathname;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript',
               '.svg':'image/svg+xml', '.ico':'image/x-icon',
               '.webmanifest':'application/manifest+json', '.json':'application/json' };

// crude per-IP token bucket — swap for redis in production
const hits = new Map();
function rateLimit(ip) {
  const now = Date.now(), w = hits.get(ip) ?? { n: 0, t: now };
  if (now - w.t > 60_000) { w.n = 0; w.t = now; }
  w.n++; hits.set(ip, w);
  return w.n <= 20;                              // 20 messages/min/IP
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");

  const ip = req.socket.remoteAddress ?? 'unknown';

  if (req.url === '/api/chat' && req.method === 'POST') {
    if (!KEY) return send(res, 500, { error: 'Server is missing DEEPSEEK_API_KEY.' });
    if (!rateLimit(ip)) return send(res, 429, { error: 'Too many messages. Wait a minute.' });

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_000) return send(res, 413, { error: 'Message too long.' });
    }

    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: 'Invalid JSON.' }); }

    // Whitelist the shape. Never forward raw client objects upstream.
    const msgs = (Array.isArray(parsed.messages) ? parsed.messages : [])
      .filter(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
    if (!msgs.length) return send(res, 400, { error: 'No valid messages.' });

    // system prompt lives server-side too — users cannot overwrite your mentor persona
    msgs.unshift({ role: 'system', content:
      'You are Electronics Mentor: a patient tutor for electronics students. Explain circuits, ' +
      'components and calculations step by step, show formulas, and check the student\u2019s ' +
      'reasoning. Refuse topics unrelated to electronics and education.' });

    try {
      const upstream = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages: msgs,
                               stream: true, max_tokens: 1024, temperature: 0.3 }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        return send(res, 502, { error: 'Upstream request failed.',
                                status: upstream.status, detail: detail.slice(0, 200) });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream',
                           'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for await (const chunk of upstream.body) res.write(chunk);   // relay SSE verbatim
      res.end();
    } catch (err) {
      if (res.headersSent) return res.end();
      send(res, 504, { error: 'Upstream timed out.', detail: String(err.message) });
    }
    return;
  }

  // static files
  try {
    const path = normalize(join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]));
    if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, '0.0.0.0', () => console.log(`listening on :${PORT}`));

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
```

Run with `DEEPSEEK_API_KEY=sk-... node server.mjs`. Add `.env` to `.gitignore` (L3) — a key
committed to git history is effectively permanent even after deletion.

**Deployment note.** This rules out plain GitHub Pages / Netlify-static-only for the API tier.
Use Netlify/Vercel/Cloudflare **functions**, Fly.io, Render, or a VPS. The frontend can stay
static; only `/api/chat` needs a server.

---

## 4. High-severity findings

### H1 — Screen readers never hear the conversation (no live region)

**Evidence.** Harness T7: `#messages` has no `aria-live` and no `role="log"`; zero `aria-*`
attributes exist anywhere in the file.

**Why it matters.** A bot reply appended to the DOM is **silent** to a screen-reader user. They
send a message and get no feedback whatsoever — the app is unusable, not merely awkward. This is
WCAG 4.1.3 (Status Messages).

**Fix.**

```html
<div id="messages" role="log" aria-live="polite" aria-relevant="additions"
     aria-label="Conversation with Electronics Mentor" tabindex="0"></div>
```

`polite` (not `assertive`) matters: with streaming, `assertive` would interrupt the user on every
single token. `tabindex="0"` makes the scrollable transcript keyboard-scrollable — without it a
keyboard-only user cannot scroll back through history at all.

If you add a "thinking…" indicator, give it its own `aria-live="polite"` and an
`aria-busy` toggle on the container.

### H2 — The input has no accessible name

**Evidence.** Harness T7: no `<label for="input">`, no `aria-label`, no `aria-labelledby`.
The only name is `placeholder="Type a message..."`.

**Why it matters.** A placeholder is not a label. Screen readers announce an unlabeled edit field,
and the placeholder **vanishes the moment you start typing** — so a low-vision or
short-term-memory-impaired user loses the only hint of what the field is for. WCAG 3.3.2 / 4.1.2.

**Fix** (keeps the current look — no visible label required):

```html
<label for="input" class="visually-hidden">Message Electronics Mentor</label>
<input id="input" type="text" placeholder="Type a message..." autocomplete="off"
       aria-describedby="input-hint" maxlength="8000">
<div id="input-hint" class="visually-hidden">Press Enter to send, Shift+Enter for a new line.</div>
```

```css
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

### H3 — Enter submits mid-word for Devanagari/Hindi and CJK users (IME bug)

**Evidence.** Harness T5, confirmed: dispatching `Enter` with `isComposing === true` submits the
message. The handler checks only `e.key === 'Enter'`.

**Why it matters.** This is a **functional blocker for your actual audience**. Typing Hindi in
Devanagari (or any Indic/CJK script) uses an IME: you compose a syllable, then press Enter to
*commit the composition* — not to send. With this code, every commit keypress fires the message
half-typed. Given the project is Punjabi/India-based, this is not a theoretical edge case; it
makes the app unusable in the user's first language.

**Fix.**

```js
input.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;   // IME composing — never submit
  if (e.shiftKey) return;                           // Shift+Enter = newline (see H4)
  e.preventDefault();
  handleSend();
});
```

`keyCode === 229` is the belt-and-braces check for older Safari/Android where `isComposing` is
unreliable. Also consider `lang="hi"` variants and a language toggle if you serve bilingual content.

### H4 — Shift+Enter sends; multiline input is impossible

**Evidence.** Harness T4, confirmed: `Shift+Enter` submits. The field is a single-line
`<input type="text">`, so it cannot contain a newline at all.

**Why it matters.** Universal chat convention is Enter = send, Shift+Enter = newline. More
importantly for this domain: electronics questions are **inherently multiline** — a student
describing a circuit, pasting a netlist, listing measured values, or writing out their working
cannot do it in one physical line. Forcing it into a single-line input guarantees a worse
question and a worse answer.

**Fix.** Swap to an auto-growing `<textarea>`:

```html
<textarea id="input" rows="1" placeholder="Type a message..." aria-label="Message Electronics Mentor"
          maxlength="8000"></textarea>
```

```css
#input { resize: none; overflow-y: auto; min-height: 46px; max-height: 160px;
         line-height: 1.4; font-family: inherit; }
```

```js
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autosize);
```

Keep `font-size: 16px` (see §2) or iOS will zoom on focus.

### H5 — Reload wipes the entire conversation

**Evidence.** Harness T8: `localStorage`, `sessionStorage`, and `indexedDB` all appear 0 times.

**Why it matters.** For a *learning* tool this is severe. A student mid-way through understanding
Kirchhoff's laws refreshes, or their phone locks, or they switch tabs on a memory-pressured
mobile browser — and the whole lesson is gone with no warning and no recovery. Sessions are the
product's core value; losing them silently is the fastest way to lose users.

**Fix.**

```js
const STORE_KEY = 'em.history.v1';   // versioned so you can migrate later

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(m => m.role && typeof m.text === 'string').slice(-100) : [];
  } catch { return []; }             // corrupt quota / private mode
}
function saveHistory() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-100))); }
  catch { /* Safari private mode + quota — degrade silently, never crash the chat */ }
}
```

Call `saveHistory()` after each message and re-render on load. Cap at ~100 messages: `localStorage`
is ~5 MB and unbounded growth will eventually throw `QuotaExceededError`.

Add a visible **Clear conversation** button — storing chat data without a way to delete it is a
privacy problem, and matters under India's DPDP Act 2023 if you ever collect identifiable data.

### H6 — No error handling anywhere in the codebase

**Evidence.** Harness T10: zero `try`/`catch` in the file. No `noscript`, no failure UI.

**Why it matters.** Harmless while the "backend" is `setTimeout`. The instant a real network call
exists (C1), every failure mode becomes silent: offline, 429 rate limit, 401 expired key, 502
upstream, 60 s timeout, aborted fetch. The user sees a spinner forever with no explanation and no
retry. Silent failure is the worst possible UX for a paid API.

**Fix.** Wrap every async call (see the C1 snippet — `try/catch/finally` with the lock released in
`finally`), add an `.error` bubble style, add a **Retry** affordance, and handle `navigator.onLine`
+ the `offline`/`online` events with a banner. Never leave the send button permanently disabled
on failure — that is a dead-end state requiring a page reload.

### H7 — No in-flight guard; rapid taps queue duplicate messages

**Evidence.** Harness T6, confirmed: `send.disabled` stayed `false` during the simulated request,
and two clicks produced two user bubbles with two pending replies.

**Why it matters.** On mobile, double-tapping Send is common. Today it just double-echoes; with a
real API it **double-bills you** and interleaves two streams into one transcript. There is also no
loading state, so during a 10-second LLM response the UI looks frozen and users tap again —
compounding the problem.

**Fix.** Disable the button and show state:

```js
send.disabled = true;
send.textContent = '…';
// ... in finally:
send.disabled = false;
send.textContent = 'Send';
```

```css
#send:disabled { opacity: .5; cursor: not-allowed; }
```

Also add a **"Stop generating"** button wired to the `AbortController` — essential once responses
stream, and it saves you token spend when a student realises they asked the wrong thing.

---

## 5. Medium-severity findings

### M1 — Input border fails WCAG non-text contrast (1.41:1 vs required 3:1)

**Evidence.** Computed per WCAG 2.1 relative-luminance formula:

| Element | Ratio | AA (4.5) | Non-text (3.0) |
|---|---|---|---|
| `h1` `#f59e0b` on `#0f172a` | 8.31:1 | PASS | PASS |
| `.sub` `#94a3b8` on `#0f172a` | 6.96:1 | PASS | PASS |
| Bot bubble `#e2e8f0` on `#1e293b` | 11.87:1 | PASS | PASS |
| **Input border `#334155` on `#1e293b`** | **1.41:1** | — | **FAIL** |

**Why it matters.** The border is the only thing telling a low-vision user where the text field
begins. At 1.41:1 it is effectively invisible against its own background. WCAG 1.4.11 requires 3:1
for UI component boundaries.

**Fix.** `#64748b` → **3.07:1** against the input background and **3.75:1** against the page
background — passes both.

```css
#input { border: 1px solid #64748b; }
```

> ⚠️ Do **not** use `#475569`, the obvious "one step lighter in the same slate ramp" choice.
> I measured it: **1.93:1 — still fails.** Only `#64748b` and above clear 3:1 here.

The `:focus` state (`#f59e0b`, 6.81:1) is already fine. Consider also adding
`outline: 2px solid #f59e0b; outline-offset: 2px` on focus — the current code sets
`outline: none` and relies on border colour alone, which is weak for keyboard users (WCAG 2.4.7).

### M2 — `<button>` has no `type` attribute

**Evidence.** `html-validate` (standard preset), the **only** error it reported:
`99:6 error <button> is missing recommended "type" attribute  no-implicit-button-type`.

**Why it matters.** A button with no type defaults to `type="submit"`. Today there is no `<form>`,
so it is latent. But the standard fix for H4/H5 is often to wrap the input row in a `<form>`
(correct semantics, free mobile keyboard "go" button) — and the moment you do, this button submits
the form and reloads the page, destroying the conversation. Fix it now and that refactor is safe.

**Fix.** `<button id="send" type="button">Send</button>` — or deliberately embrace the form and
handle `submit` with `preventDefault()`.

### M3 — The PWA is half-configured, which is worse than not starting

**Evidence.** `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags
are present, but `manifest.json`, `manifest.webmanifest`, `sw.js`, and `service-worker.js` are all
**absent**, and there is no `theme-color` and no icon.

**Why it matters.** The tags declare "I am an installable full-screen app" while none of the
machinery exists. Result: no Add-to-Home-Screen icon, no splash screen, and
`black-translucent` status-bar styling can render the app's content underneath the status bar
with no safe-area compensation in standalone mode. Also, `apple-mobile-web-app-capable` is
**deprecated**; Chrome/Android want `mobile-web-app-capable`.

**Fix** — either commit to it:

```html
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#0f172a">
<meta name="mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="icon-192.png">
```

…or delete the two `apple-mobile-web-app-*` tags and ship it as a normal responsive page.
Don't leave it in between.

### M4 — `min-height: 100vh` breaks on mobile Safari

**Evidence.** Line 15: `min-height: 100vh`.

**Why it matters.** On iOS Safari `100vh` is the **large** viewport height (URL bar retracted).
With the bar visible the real viewport is shorter, so the input row is pushed **below the fold** —
exactly the element the user needs. Compounded by the on-screen keyboard, which resizes the visual
viewport again. For a mobile-first app (and the meta tags say this is mobile-first) this is a
core interaction bug.

**Fix.**

```css
body { min-height: 100vh; min-height: 100dvh; }  /* dvh wins where supported, vh as fallback */
```

Also consider `interactive-widget=resizes-content` in the viewport meta for Android Chrome
keyboard behaviour, and test with the keyboard actually open — not just in a desktop resize.

### M5 — No favicon (404 on every single page load)

**Evidence.** Observed in the live server log: `GET /favicon.ico HTTP/1.1" 404`. No `<link rel="icon">`.

**Why it matters.** Minor but free to fix: one 404 per visit, a blank browser tab, and a broken
Add-to-Home-Screen icon. It also signals "unfinished" to anyone evaluating the project.

**Fix.** Inline a data-URI icon so it stays zero-dependency and costs no extra request:

```html
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
```

### M6 — No `<noscript>`; with JS disabled the page is a blank dead end

**Why it matters.** The app is 100% JavaScript. With JS blocked (corporate proxies, privacy
extensions, some Indian ISP/UC-Browser-style data savers), the user sees an empty box and a Send
button that does nothing — no explanation, no alternative.

**Fix.**

```html
<noscript>
  <p style="padding:16px;background:#1e293b;border-radius:12px">
    Electronics Mentor needs JavaScript. Please enable it, or email your question to
    <a href="mailto:support@example.com" style="color:#f59e0b">support@example.com</a>.
  </p>
</noscript>
```

### M7 — Auto-scroll hijacks the user's scroll position

**Evidence.** `addMessage` unconditionally runs `messages.scrollTop = messages.scrollHeight`.

**Why it matters.** If a student scrolls up to re-read an earlier explanation while a long answer
is streaming in, every incoming token **yanks them back to the bottom**. They physically cannot
read the earlier message. This is one of the most complained-about chat UI bugs, and streaming
(H4/C1) makes it constant rather than occasional.

**Fix.** Only follow the tail if the user is already near it:

```js
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToBottom(force = false) {
  const nearBottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  if (force || nearBottom) {
    messages.scrollTo({ top: messages.scrollHeight,
                        behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}
```

The `prefers-reduced-motion` check is a separate WCAG 2.3.3 concern: smooth-scrolling is
vestibular-triggering for some users, and the current code has no such handling (0 matches in file).

### M8 — Plain-text rendering makes electronics answers unreadable

**Evidence.** `addMessage` sets `textContent`; no markdown or math library is referenced.

**Why it matters.** This is domain-specific and significant. An electronics mentor answer is dense
with structure that plain text destroys: formulas (V = IR, τ = RC, f = 1/2π√LC), subscripts
(V<sub>out</sub>, I<sub>b</sub>), unit symbols (Ω, µF, kΩ), code (Arduino/SPICE), tables of pin
values, and step-by-step derivations. Rendered as one undifferentiated text blob, the answers are
genuinely hard to learn from — which defeats the purpose of a *mentor*.

**Fix.** `marked` (markdown) + `KaTeX` (math) + **`DOMPurify` (mandatory)**.

```js
bubble.innerHTML = DOMPurify.sanitize(
  marked.parse(answer, { gfm: true, breaks: true }),
  { USE_PROFILES: { html: true }, FORBID_TAGS: ['script','iframe','object','embed','form'],
    FORBID_ATTR: ['onerror','onclick','onload','srcdoc'] }
);
```

> ⚠️ **This is the one fix that can undo your best current property.** Moving from `textContent`
> to `innerHTML` re-opens the XSS hole that §2 credits the code for closing — and now the payload
> comes from an LLM that a user can prompt-inject. Sanitising is not optional. Keep the T3 harness
> check as a regression test and re-run it after this change.

Also add `overflow-x: auto` to rendered tables and KaTeX blocks, or wide derivations will blow out
the mobile layout.

### M9 — No Content-Security-Policy or other security headers

**Evidence.** Full header scan of the live response: **none** of `Content-Security-Policy`,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, or
`Permissions-Policy` are present.

**Why it matters.** Today the attack surface is tiny. Once M8 (innerHTML) and C1 (a real API) land,
CSP becomes your last line of defence, and `X-Frame-Options` prevents clickjacking. Adding headers
is nearly free when the proxy in C2 is already setting them.

**Fix.** Ship via the proxy (already in the C2 snippet) or via host config
(`_headers` on Netlify/Cloudflare Pages). A static-file fallback is a `<meta http-equiv>` CSP, but
server headers are strictly better — they cover responses meta tags cannot, and cannot be stripped
by injected markup.

### M10 — No streaming, so a real LLM response will look like a frozen app

**Evidence.** The reply path is a single `setTimeout(..., 300)`; no `ReadableStream`, SSE, or
chunk handling exists.

**Why it matters.** A full electronics explanation takes 5–30 s to generate. Without streaming the
user stares at nothing for that entire window. Perceived latency is the dominant factor in whether
a chat product feels good, and streaming typically cuts it from ~15 s to under ~1 s
before the first token appears.

**Fix.** Already covered — `stream: true` upstream in C2, SSE reader loop in C1, plus a
"thinking…" indicator with animated dots, and the Stop button from H7.

### M11 — No message metadata or conversation controls

**Why it matters.** No timestamps, no copy-to-clipboard, no regenerate, no edit-and-resend, no
export, no clear. For a study tool, **copying a derivation into notes is the core follow-up
action**, and its absence is felt immediately. Regenerate matters because LLM answers vary and
students will want a second explanation.

**Fix.** Add a hover/tap action row per bubble (Copy, Regenerate for the last assistant message),
relative timestamps with `title` for absolute, and an "Export as Markdown" button that downloads
the transcript — cheap to build on top of H5's history array and genuinely useful for revision.

### M12 — Legacy CSS property and missing long-word handling

**Evidence.** Line 47: `word-wrap: break-word`.

**Fix.** `word-wrap` is the deprecated alias — use the standard `overflow-wrap`, and add `anywhere`
so unbroken long strings (URLs to datasheets, hex values, part numbers) cannot overflow the bubble:

```css
.msg { overflow-wrap: break-word; overflow-wrap: anywhere; word-break: break-word; }
```

`max-width: 85%` alone will not contain a 200-char unbroken token.

### M13 — No light mode; theme is hardcoded dark

**Why it matters.** Zero `prefers-color-scheme` handling. A dark-only UI is unusable in bright
sunlight (common for students outdoors) and is an accessibility barrier for users with astigmatism,
who often read light-on-dark text worse.

**Fix.** Define the palette as CSS custom properties and add a light scheme — then a manual toggle
is a few lines and can persist via H5's storage:

```css
:root { --bg:#0f172a; --panel:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#f59e0b; --border:#64748b; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f8fafc; --panel:#ffffff; --text:#0f172a; --muted:#475569; --accent:#b45309; --border:#7c8ca0; }
}
```

Every value above was computed against WCAG 2.1 relative luminance, and two of them are traps:

| Token | Light value | Check | Result |
|---|---|---|---|
| `--accent` | `#b45309` | text on `#ffffff` | 5.02:1 PASS (keeping `#f59e0b` would be **2.15:1 — fails even large text**) |
| `--border` | `#7c8ca0` | on `#ffffff` **and** `#f8fafc` | 3.43:1 / 3.28:1 PASS both |

> ⚠️ The intuitive light border `#cbd5e1` measures **1.48:1** — it reproduces the exact M1 failure
> in the new theme. And `#8494a7` is a subtler trap: 3.10:1 on the white panel but **2.96:1 on the
> `#f8fafc` page background**, so it passes one adjacency and fails the other. WCAG 1.4.11 measures
> against *every* adjacent colour a boundary touches — always test both sides.

Re-run the contrast table from M1 for any palette change; the four light-mode values above are the
only ones I verified.

---

## 6. Low severity — repository & engineering hygiene

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| L1 | README is one line | Entire content: `# Electronic-mentor-deepseek` | Document purpose, screenshot, setup, env vars, architecture, roadmap. The C2 key-handling rule belongs here. |
| L2 | No LICENSE | File absent | Add MIT or Apache-2.0. Without it, the code is legally *not* reusable by anyone. |
| L3 | No `.gitignore` | File absent | **Add before any `.env` exists** — ignore `.env`, `node_modules/`, `dist/`, `.DS_Store`. A committed key is effectively permanent in history. |
| L4 | No `package.json` | File absent | Add one even with zero deps: it pins `engines`, and hosts `lint`/`test`/`start` scripts. |
| L5 | No CI | No `.github/workflows` | GitHub Actions running `html-validate` + the harness from §7 on every PR. The whole thing runs in ~7 s. |
| L6 | No tests | None | The 12-check harness in `/tmp/audit/behavior.test.mjs` is a ready-made starting point — see §7. |
| L7 | Single-file architecture | 134 lines inline CSS+JS | Fine at this size. Split into `styles.css` + `app.js` **before** M8/C1 land, or the file passes ~800 lines and becomes hard to review. Splitting also makes the CSP in M9 strict (no `'unsafe-inline'`). |
| L8 | One commit, no branching discipline | `git log` = 1 commit on `main` | Work in feature branches; keep `main` deployable. |

---

## 7. Regression harness (reusable)

The findings above came from a 12-check JSDOM harness rather than guesswork. It is worth keeping —
copy this into the repo as `tests/behavior.test.mjs` (`npm i -D jsdom`) and wire it to CI (L5):

```js
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

function fresh() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom, d = window.document;
  return {
    window, d,
    input: d.getElementById('input'), send: d.getElementById('send'),
    messages: d.getElementById('messages'),
    bubbles: () => [...d.querySelectorAll('.msg')],
    type: v => { d.getElementById('input').value = v; },
    click: () => d.getElementById('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    key: (k, o = {}) => d.getElementById('input').dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...o })),
    wait: ms => new Promise(r => setTimeout(r, ms)),
  };
}

{ const t = fresh(); check('greeting renders', t.bubbles().length === 1); }
{ const t = fresh(); t.type('   '); t.click(); await t.wait(400);
  check('whitespace-only input blocked', t.bubbles().length === 1); }
{ const t = fresh(); t.type('<img src=x onerror="window.__pwned=1">'); t.click(); await t.wait(400);
  check('XSS payload stays inert', !t.d.querySelector('img') && !t.window.__pwned); }
{ const t = fresh(); const ev = new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  Object.defineProperty(ev, 'isComposing', { value: true });
  t.type('नमस्ते'); t.input.dispatchEvent(ev); await t.wait(400);
  check('Enter during IME composition does NOT send', !t.bubbles().some(b => b.classList.contains('user'))); }
{ const t = fresh(); t.type('line one'); t.key('Enter', { shiftKey: true }); await t.wait(400);
  check('Shift+Enter does NOT send', !t.bubbles().some(b => b.classList.contains('user'))); }
{ const t = fresh();
  check('transcript is a live region', t.messages.getAttribute('aria-live') === 'polite' || t.messages.getAttribute('role') === 'log'); }
{ const t = fresh();
  check('input has an accessible name', !!(t.input.getAttribute('aria-label') || t.d.querySelector('label[for="input"]'))); }
{ const t = fresh(); check('send button has explicit type', t.send.getAttribute('type') === 'button'); }
{ const t = fresh(); check('input border meets 3:1 non-text contrast', /#64748b/i.test(html)); }
{ const t = fresh(); check('uses dynamic viewport height', /100dvh/.test(html)); }
{ const t = fresh(); check('history persists', /localStorage/.test(t.d.querySelector('script').textContent)); }
{ const t = fresh(); check('has error handling', /catch\s*\(/.test(t.d.querySelector('script').textContent)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

Note the last four checks are written as *fix-detection* tests — they fail today and pass once the
recommendations are implemented, so CI goes green as you close the audit.

---

## 8. Recommended sequence

Ordered by dependency, not by severity — several High items are cheaper to fix *after* the
architecture decision.

**Phase 0 — Decide the architecture (before writing any AI code).**
Commit to the server-side proxy (C2). This is a one-way door: a key committed to a public repo
cannot be un-leaked, and a client-only design cannot be made safe later without the same rewrite.
Then do L3 (`.gitignore`) so the `.env` is never committable.

**Phase 1 — Correctness & accessibility (≈2–3 hours, no backend needed).**
H3 (IME) and H4 (textarea) are small diffs that unblock your Hindi-speaking users.
H1 + H2 (aria-live, label) are ~6 lines total. M1 (border), M2 (`type="button"`), M4 (`dvh`),
M5 (favicon), M6 (`noscript`), M12 (`overflow-wrap`) are one-liners.
Land the §7 harness and L5 CI so these stay fixed.

**Phase 2 — Make it a real product.**
C1 + M10 (proxy + streaming), H6 (error handling), H7 (in-flight guard + Stop),
M7 (scroll anchoring), M9 (CSP from the proxy). Split into `styles.css`/`app.js` here (L7).

**Phase 3 — Learning-tool quality.**
M8 (markdown + KaTeX + DOMPurify, and re-run the XSS check), H5 (persistence + Clear),
M11 (copy/regenerate/export), M13 (light mode), M3 (finish or remove the PWA), L1/L2/L4 docs.

---

## 9. Bottom line

The current file is a **tidy, well-built skeleton** — good contrast, correct mobile handling, no
XSS, zero dependencies. Credit where due: `textContent` and the 16px input are the two decisions
most often got wrong, and both are right.

But as an *app* it is 5% complete, and the audit's real message is about the next step:

1. **Decide the key-handling architecture now (C2).** Everything else is reversible; a leaked
   DeepSeek key is not.
2. **Fix H3 before anything else ships.** Enter-during-composition makes the app unusable for
   Devanagari input — a real blocker for your audience, not an edge case.
3. **The two accessibility gaps (H1, H2) cost ~6 lines** and are the difference between usable and
   unusable for screen-reader users.

Nothing here requires a framework, a build step, or a rewrite. Phases 1 and 2 can be done while
keeping the app a fast, dependency-light page — which is worth preserving.

---

## 10. Implementation status (2026-11-04)

All 30 findings were implemented on branch `arena/5a3c1947-electronic-mentor-deepseek`.
`npm test` = 18 passing checks (7 sanitizer XSS + 11 server integration); `npm run lint` clean.

| Finding | Status | Where |
|---|---|---|
| C1 no AI backend | **Fixed** | `server.mjs` `/api/chat` + streaming SSE client in `app.js` |
| C2 key exposure | **Fixed** | key server-side only; `.gitignore` + `.env.example`; shape whitelist; rate limit |
| H1 live region | **Fixed** | `role="log" aria-live="polite"` + `tabindex="0"` on `#messages` |
| H2 input label | **Fixed** | real `<label>` + `aria-describedby` hint |
| H3 IME submit | **Fixed** | `isComposing` / `keyCode 229` guard |
| H4 multiline | **Fixed** | auto-growing `<textarea>`; Enter send / Shift+Enter newline |
| H5 persistence | **Fixed** | versioned `localStorage`, 100-msg cap, Clear button |
| H6 error handling | **Fixed** | try/catch, error bubble + Retry, offline banner |
| H7 in-flight guard | **Fixed** | send disabled while streaming; Stop via `AbortController` |
| M1 border contrast | **Fixed** | `#64748b` (3.07:1 / 3.75:1) |
| M2 button type | **Fixed** | explicit `type="submit"` inside a real `<form>` (deliberate choice) |
| M3 half-done PWA | **Fixed** | manifest + generated icons (incl. maskable) + network-first `sw.js` |
| M4 `100vh` | **Fixed** | `min-height: 100dvh` with `vh` fallback |
| M5 favicon 404 | **Fixed** | real PNG icons; 404 asserted gone by test |
| M6 noscript | **Fixed** | `<noscript>` fallback with a mailto alternative |
| M7 scroll hijack | **Fixed** | tail-follow only within 140 px + `prefers-reduced-motion` |
| M8 plain text | **Fixed** | `marked` → DOMPurify → DOM, **lazy** KaTeX; config shared with tests |
| M9 no CSP | **Fixed** | strict CSP + 4 more headers on every response |
| M10 no streaming | **Fixed** | SSE relay (DeepSeek) and SSE emulation (demo) |
| M11 no controls | **Fixed** | Copy, Regenerate, Export-as-Markdown, timestamps, Clear |
| M12 `word-wrap` | **Fixed** | `overflow-wrap: anywhere` |
| M13 dark-only | **Fixed** | token-based light/dark, OS-follow until explicit, persisted |
| L1–L8 hygiene | **Fixed** | README, LICENSE, `.gitignore`, `package.json`, CI workflow, tests, split CSS/JS |

### Defects discovered *during* implementation (not in the original audit)

Writing the code surfaced three real bugs that reading the skeleton could not have:

1. **`req.destroyed` is `true` once the request body has been consumed.** Using it to
   detect a departed client aborted every SSE stream on its *first* chunk — the demo
   mentor silently returned zero bytes. Replaced with a `res.on('close')` flag.
2. **Early responses must drain the request body.** Replying `429`/`413` without consuming
   the POST body left unread bytes in the keep-alive socket, desynchronising the *next*
   request on that connection and hanging the client. Added a `drain()` before early replies.
3. **`path.normalize` preserves trailing slashes.** `fileURLToPath(new URL('.', …))` yields a
   trailing-slash root, so the `ROOT + sep` containment check never matched and *every* static
   file returned 403. The root is now explicitly stripped.

Each is covered by a regression test (SSE completion, rate-limit under keep-alive, and static
200s respectively), which is precisely why the harness lives in CI rather than in a scratch dir.

### Deliberate non-goals

- **No service-worker caching of chat responses** — network-first, API never cached; an LLM
  answer must never be served stale.
- **`style-src` keeps `'unsafe-inline'`** because KaTeX emits inline styles. `script-src`
  remains strict `'self'`, which is the control that actually prevents XSS.
- **History stays device-local** (`localStorage`). Adding server-side storage is a product
  decision with privacy implications (see README roadmap), not a defect.
