# Electronics Mentor

A patient AI tutor for circuits, components and electronics calculations.
Ask it anything from *"what resistor for a 2 V LED on a 9 V supply?"* to op-amp
design, and get a step-by-step answer with real formulas, tables and worked numbers.

Built as a fast, dependency-light progressive web app in front of a
**zero-dependency Node proxy** that keeps the model API key on the server,
where it belongs.

---

## Quick start

Requires **Node 18+**. No build step.

```bash
npm install          # dev-only deps (jsdom + html-validate, for tests/lint)

# With the real model:
DEEPSEEK_API_KEY=sk-... npm start

# …or with no key at all — the app runs in clearly-labelled DEMO mode,
# answering from a small built-in electronics FAQ so you can try the UI:
npm start
```

Then open <http://localhost:8080>.

`npm run dev` restarts on file changes. See `.env.example` for all knobs
(`DEEPSEEK_MODEL`, `DEEPSEEK_URL`, `PORT`).

> **Never commit a real key.** `.env` is git-ignored; a key committed to git
> history is effectively permanent even after you delete it.

---

## Architecture

```
┌──────────────┐  HTTPS POST   ┌─────────────────────┐  HTTPS   ┌────────────
│  index.html  │ ────────────► │  /api/chat          │ ───────► │  DeepSeek  │
│  app.js      │ ◄── SSE ──── │  server.mjs         │ ◄─────── │  API       │
│  (browser)   │   streamed    │  • key lives HERE   │          └────────────┘
└──────────────┘               │  • validates shape  │
      no key, ever             │  • rate-limits      │
                               │  • streams verbatim │
                               └─────────────────────┘
```

The browser **never** sees `DEEPSEEK_API_KEY`. It posts the conversation to
`/api/chat`; the server whitelists the message shape, prepends a server-side
system prompt, rate-limits per IP, and relays DeepSeek's server-sent-events
stream back untouched. If no key is configured the same SSE contract is served
by `lib/demo-mentor.js` so the UI is fully exercisable without a paid key.

### Project layout

```
index.html            semantic, accessible shell (split out of the old monolith)
styles.css            design tokens, dark+light themes, contrast-verified
app.js                frontend: streaming, sanitised markdown, lazy KaTeX, a11y
server.mjs            zero-dep Node proxy + static host + security headers
lib/demo-mentor.js    offline FAQ used when no API key is set
lib/sanitize-config.js  the ONE markdown/DOMPurify config, shared with tests
lib/prompts.js        curated starter questions, shared with the tests
sw.js                 network-first service worker (offline shell)
manifest.webmanifest  installable-PWA manifest
public/               generated app icons (192 / 512 / maskable / apple-touch)
vendor/               self-hosted marked + DOMPurify + KaTeX (woff2 only)
tests/                node:test suites (server integration + sanitizer XSS)
AUDIT.md              the technical audit this codebase implements
```

Frontend libraries are **vendored and self-hosted** (no CDN at runtime), which
keeps the CSP strict, works on flaky networks, and lets the service worker
cache the whole shell. KaTeX (~600 KB + fonts) is loaded **lazily**, only when
a message actually contains maths, so the common path stays light.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | run the server (demo mode without a key) |
| `npm run dev` | same, with `--watch` |
| `npm test` | server integration + sanitizer XSS suites (`node --test`) |
| `npm run lint` | `html-validate` on `index.html` |

CI (`.github/workflows/ci.yml`) runs lint + tests on every push and PR.

---

## Security model

- **Key isolation** — the API key exists only in the server process environment.
- **Input is untrusted** — model output goes `marked` → **DOMPurify** → DOM.
  KaTeX typesets *after* sanitisation on the trusted live tree.
  `tests/sanitize.test.mjs` asserts scripts, event handlers, `javascript:` URIs,
  inline styles and `<svg>/<iframe>/<object>/<math>` never survive.
- **Shape whitelisting** — only `user`/`assistant` roles with string content are
  forwarded; a client-supplied `system` message is dropped, so the mentor
  persona can't be overwritten from the browser.
- **Headers** — every response carries a strict CSP (`script-src 'self'`),
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy`.
- **Abuse controls** — per-IP token bucket (20 msg/min), body-size cap,
  message-count and per-message length caps before anything reaches the model.
- **Anonymous history, no accounts** — `GET/PUT/DELETE /api/history` bind a
  conversation to an HMAC-signed random device token in an `HttpOnly; SameSite=Lax`
  cookie (keyed server-side by its sha256). No passwords, emails or PII are stored;
  the store is a single atomic-written JSON file under `.data/` (git-ignored),
  signed by `EM_HISTORY_SECRET` (auto-generated if unset). Per-token write rate
  limits and the same shape-whitelisting as `/api/chat` apply.
- **No path traversal** — static serving is confined to the project root and
  refuses to expose `server.mjs`, `.data/`, `.env`, lockfiles and dotfiles.
  (`lib/` *is* served: it holds the isomorphic modules the browser imports.)

---

## Accessibility & UX highlights

- Transcript is a polite live region (`role="log"`, `aria-live="polite"`) and
  keyboard-scrollable; the input has a real `<label>`, not just a placeholder.
- `Enter` sends, `Shift+Enter` newlines, and Enter **during IME composition**
  (Devanagari, CJK) never submits mid-word.
- Scroll only follows the tail when you're already at the bottom, so reading
  back up is never hijacked; honours `prefers-reduced-motion`.
- Both themes are contrast-verified against WCAG 2.1 (see `AUDIT.md` §5);
  theme follows the OS until you choose, then persists.
- Streaming replies with a Stop button, in-flight lock, offline banner,
  per-message Copy / Regenerate, conversation Export and Clear.
- History persists across reloads (capped at 100 messages) and, when a server
  exists, syncs to it anonymously — newest-wins reconciliation, localStorage
  fallback offline.
- Starter-question chips (curriculum-aligned, test-verified to always answer)
  appear whenever the transcript is empty; **Save as PDF** uses the print
  stylesheet with a branded header — no PDF library needed.

---

## Status & roadmap

The current code implements the findings in [`AUDIT.md`](AUDIT.md) —
see its §10 for a per-finding implementation table.

Done since the audit: starter prompt library, Save-as-PDF export, and anonymous
server-side history (track 3 of the roadmap).

Open ideas, in rough order:

- Hindi / Punjabi UI strings and a language toggle (the IME fix already makes
  Devanagari *input* work).
- Swap the in-memory rate-limit bucket (and the `.data/` JSON store) for Redis /
  Postgres when running multiple replicas.
- Opt-in named accounts on top of the device-token identity, if cross-device
  sync is ever requested (a privacy decision, not a default).
- PNG icon variants per platform if a store listing is ever needed.

---

## License

MIT — see [LICENSE](LICENSE). Vendored libraries keep their own licenses in
`vendor/LICENSE-*.txt`.
