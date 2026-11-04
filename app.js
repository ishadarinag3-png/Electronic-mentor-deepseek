/* ==========================================================================
   Electronics Mentor — app.js
   Frontend: streaming chat, sanitised markdown + lazy KaTeX, persistence,
   accessibility, offline handling, theming.

   Security note (AUDIT.md §2 / M8): LLM output is *untrusted input*. It is
   parsed by `marked`, passed through DOMPurify, and only then inserted into
   the DOM. KaTeX runs AFTER sanitisation, on the trusted live tree, so its
   own safe markup is never stripped.
   ========================================================================== */

import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { MARKED_OPTIONS, PURIFY_CFG, SAFE_HREF } from './lib/sanitize-config.mjs';

/* ------------------------------------------------------------------ config */

const STORE_KEY = 'em.history.v2';
const THEME_KEY = 'em.theme.v1';
const MAX_SAVED = 100;     // localStorage cap (H5)
const MAX_INPUT = 8000;    // mirrors maxlength + server-side cap

marked.setOptions(MARKED_OPTIONS);

const ROLE_CLASS = { user: 'msg--user', assistant: 'msg--bot', system: 'msg--system' };

const ICON = {
  copy:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  redo:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6"/></svg>',
};

/* ------------------------------------------------------------------ dom */

const $ = (s) => document.querySelector(s);
const messages    = $('#messages');
const form        = $('#composer');
const input       = $('#input');
const sendBtn     = $('#send');
const stopBtn     = $('#stop');
const offlineB    = $('#offline-banner');
const demoB       = $('#demo-banner');
const engineLabel = $('#engine-label');
const themeBtn    = $('#theme-toggle');

/* ------------------------------------------------------------------ state */

/** @type {{role:'user'|'assistant', content:string, ts:number}[]} */
let history   = loadHistory();
let abortCtrl = null;          // non-null while streaming (H7)
const handles = new WeakMap(); // message object -> bubble handle (for action refresh)

/* ------------------------------------------------------------------ utils */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && ['user', 'assistant'].includes(m.role)
                  && typeof m.content === 'string' && typeof m.ts === 'number')
      .slice(-MAX_SAVED);
  } catch { return []; }      // corrupt / private mode: start clean, never throw
}

function saveHistory() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-MAX_SAVED))); }
  catch { /* quota or private mode: degrade silently, never break the chat (H5) */ }
}

/** M7: only follow the tail when the reader is already near the bottom. */
function scrollToBottom(force = false) {
  const near = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140;
  if (!force && !near) return;
  messages.scrollTo({ top: messages.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------- markdown + sanitisation */

function renderMarkdown(text) {
  const clean = DOMPurify.sanitize(marked.parse(text), PURIFY_CFG);
  const holder = document.createElement('div');
  holder.className = 'md';
  holder.innerHTML = clean;
  holder.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!SAFE_HREF.test(href)) { a.removeAttribute('href'); return; }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  return holder;
}

/* Lazy KaTeX (M8): ~600 KB + fonts, fetched only when a message has maths. */
let katexLoader = null;
const HAS_MATH = /\$\$[^$\n]|\$[^$\n]+\$|\\\[[\s\S]|\\\(/;

async function typesetMath(root) {
  if (!HAS_MATH.test(root.textContent || '')) return;
  try {
    katexLoader ??= (async () => {
      if (!document.querySelector('link[href="vendor/katex/katex.min.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'vendor/katex/katex.min.css';
        document.head.appendChild(link);
      }
      const [{ default: renderMathInElement }] = await Promise.all([
        import('./vendor/katex/contrib/auto-render.mjs'),  // imports katex.mjs itself
      ]);
      return renderMathInElement;
    })();
    const renderMathInElement = await katexLoader;
    renderMathInElement(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$',  right: '$',  display: false },
      ],
      throwOnError: false,
      errorColor: '#f87171',
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch { /* maths is a progressive enhancement; never break the answer */ }
}

/* ------------------------------------------------------------------ bubbles */

function setContent(bubble, text, { rich = true } = {}) {
  let body = bubble.querySelector('.body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'body';
    bubble.prepend(body);
  }
  body.classList.toggle('plain', !rich);
  body.replaceChildren();
  if (rich) body.appendChild(renderMarkdown(text));
  else body.textContent = text;
  return body;
}

/**
 * Append a message bubble to the transcript.
 * @param {{role:string, content:string, ts?:number, variant?:string}} m
 * @returns bubble handle {el, body(), setContent(), setActions()}
 */
function addBubble(m) {
  const { role, content, ts = Date.now(), variant } = m;
  const el = document.createElement('article');
  el.className = ['msg', ROLE_CLASS[role] || 'msg--bot', variant || ''].filter(Boolean).join(' ');

  setContent(el, content);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const when = document.createElement('time');
  when.dateTime = new Date(ts).toISOString();
  when.textContent = fmtTime(ts);
  meta.appendChild(when);
  el.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  el.appendChild(actions);

  messages.appendChild(el);

  const handle = {
    el,
    body: () => el.querySelector('.body'),
    setContent: (t, o) => setContent(el, t, o),
    setActions(defs) {
      actions.replaceChildren();
      for (const d of defs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'action-btn';
        if (d.icon) b.insertAdjacentHTML('afterbegin', d.icon);
        b.appendChild(document.createTextNode(d.label));
        b.addEventListener('click', () => d.onClick(b));
        actions.appendChild(b);
      }
    },
  };
  return handle;
}

function thinkingNode() {
  const el = document.createElement('div');
  el.className = 'thinking';
  el.setAttribute('role', 'status');
  el.innerHTML = '<i></i><i></i><i></i>';
  const sr = document.createElement('span');
  sr.className = 'visually-hidden';
  sr.textContent = 'Electronics Mentor is thinking…';
  el.appendChild(sr);
  return el;
}

/* ------------------------------------------------------------------ actions */

function copyAction(msg) {
  return {
    label: 'Copy', icon: ICON.copy,
    onClick: async (btn) => {
      try {
        await navigator.clipboard.writeText(msg.content);
        btn.classList.add('is-done');
        const label = btn.lastChild;
        const old = label.textContent;
        label.textContent = 'Copied';
        setTimeout(() => { btn.classList.remove('is-done'); label.textContent = old; }, 1400);
      } catch { /* clipboard unavailable (insecure context) */ }
    },
  };
}

/** Attach Copy (+ Regenerate when this is the newest assistant turn). */
function attachActions(handle, msg) {
  handles.set(msg, handle);
  const isLast = msg.role === 'assistant' && history[history.length - 1] === msg;
  const defs = [copyAction(msg)];
  if (isLast) defs.push({ label: 'Regenerate', icon: ICON.redo, onClick: () => regenerate() });
  handle.setActions(defs);
}

/** When a new assistant turn lands, demote the previous one (drop Regenerate). */
function demotePreviousAssistant() {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      const h = handles.get(history[i]);
      if (h) h.setActions([copyAction(history[i])]);
      break;
    }
  }
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  messages.replaceChildren();
  for (const m of history) attachActions(addBubble(m), m);
  scrollToBottom(true);
}

/* ------------------------------------------------------------------ streaming */

/** POST the conversation; stream the reply as SSE. Throws on failure (H6). */
async function streamReply(payload, onToken, signal) {
  const res = await fetch('api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* non-JSON error body */ }
    throw new Error(detail || `The server answered ${res.status}. Please try again.`);
  }
  if (!res.body) throw new Error('The server sent no response stream.');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';                 // keep the trailing partial line

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof token === 'string' && token) { answer += token; onToken(answer); }
      } catch { /* keep-alive / partial JSON — skip */ }
    }
  }
  return answer;
}

/* ------------------------------------------------------------------ send */

function setBusy(busy) {
  sendBtn.disabled = busy;                       // H7 in-flight lock
  stopBtn.hidden = !busy;
  messages.setAttribute('aria-busy', String(busy));
}

async function sendUserText(text) {
  text = (text || '').trim().slice(0, MAX_INPUT);
  if (!text || abortCtrl) return;                // empty, or already generating

  if (!navigator.onLine) { offlineB.hidden = false; return; }

  const userMsg = { role: 'user', content: text, ts: Date.now() };
  history.push(userMsg);
  saveHistory();
  addBubble(userMsg).setActions([]);
  scrollToBottom(true);

  const botHandle = addBubble({ role: 'assistant', content: '' });
  botHandle.body().replaceChildren(thinkingNode());
  scrollToBottom(true);

  abortCtrl = new AbortController();
  setBusy(true);

  const payload = { messages: history.filter((m) => m.role !== 'system') };
  let answer = '';
  let lastPaint = 0;

  try {
    answer = await streamReply(payload, (acc) => {
      // Plain text while streaming (fast, no per-token sanitise cost);
      // the rich markdown + maths render happens once, on completion.
      const now = performance.now();
      if (now - lastPaint < 60) return;
      lastPaint = now;
      botHandle.setContent(acc, { rich: false });
      scrollToBottom();
    }, abortCtrl.signal);

    const assistantMsg = { role: 'assistant',
                           content: answer || '(The model returned an empty reply.)',
                           ts: Date.now() };
    demotePreviousAssistant();          // before push, so it targets the OLD last turn
    history.push(assistantMsg);
    saveHistory();

    botHandle.setContent(assistantMsg.content, { rich: true });
    await typesetMath(botHandle.body());
    attachActions(botHandle, assistantMsg);
    scrollToBottom(true);
  } catch (err) {
    botHandle.el.remove();
    if (err?.name === 'AbortError') {
      if (answer) {                              // keep whatever streamed (H7 Stop)
        const partial = { role: 'assistant', content: answer + '\n\n_(stopped)_', ts: Date.now() };
        demotePreviousAssistant();               // before push, so it targets the OLD last turn
        history.push(partial); saveHistory();
        const h = addBubble(partial);
        await typesetMath(h.body());
        attachActions(h, partial);
      } else {
        addSystemNote('Generation stopped.');
      }
    } else {
      showError(err, text);                      // user message stays; Retry re-asks
    }
  } finally {
    abortCtrl = null;
    setBusy(false);
    input.focus();
  }
}

function addSystemNote(text) {
  addBubble({ role: 'system', content: text }).setActions([]);
  scrollToBottom();
}

function showError(err, retryText) {
  const h = addBubble({
    role: 'assistant', variant: 'msg--error', ts: Date.now(),
    content: `Sorry — I couldn't get an answer.\n\n**Reason:** ${String(err?.message || err)}`,
  });
  h.setActions([{
    label: 'Retry', icon: ICON.retry,
    onClick: () => { h.el.remove(); sendUserText(retryText); },
  }]);
  scrollToBottom(true);
}

async function regenerate() {
  if (abortCtrl) return;
  while (history.length && history[history.length - 1].role === 'assistant') history.pop();
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) { saveHistory(); renderAll(); return; }
  history.pop();                                  // drop it; sendUserText re-adds it
  saveHistory();
  renderAll();
  await sendUserText(lastUser.content);
}

/* ------------------------------------------------------------------ export */

function exportMarkdown() {
  if (!history.length) return;
  const lines = ['# Electronics Mentor — conversation', '',
                 `Exported ${new Date().toLocaleString()}`, ''];
  for (const m of history) {
    lines.push(m.role === 'user' ? '## You' : '## Mentor', '', m.content, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `electronics-mentor-${new Date().toISOString().slice(0, 10)}.md`,
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ theming */

const currentTheme = () =>
  document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  themeBtn.setAttribute('aria-pressed', String(theme === 'light'));
  themeBtn.setAttribute('aria-label',
    theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  const hex = theme === 'light' ? '#f8fafc' : '#0f172a';
  document.querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', hex));
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ } }
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  applyTheme(stored === 'light' || stored === 'dark' ? stored
             : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'), false);
  if (!stored) {   // follow the OS until the user chooses explicitly
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      let s = null; try { s = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
      if (!s) applyTheme(e.matches ? 'light' : 'dark', false);
    });
  }
}

/* ------------------------------------------------------------------ wiring */

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 168) + 'px';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();                              // M2: never really submit
  const text = input.value;
  if (!text.trim() || abortCtrl) return;           // whitespace guard + in-flight guard
  input.value = '';
  autosize();
  sendUserText(text);
});

/* H3 + H4: Enter sends, Shift+Enter newlines, never submit mid-IME-composition. */
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;  // Devanagari / CJK composition commit
  if (e.shiftKey) return;                          // newline
  e.preventDefault();
  form.requestSubmit();
});

input.addEventListener('input', autosize);
stopBtn.addEventListener('click', () => abortCtrl?.abort());
$('#export').addEventListener('click', exportMarkdown);

$('#clear').addEventListener('click', () => {
  if (!history.length) return;
  if (!confirm('Clear the whole conversation? This cannot be undone.')) return;
  history = [];
  saveHistory();
  renderAll();
  input.focus();
});

themeBtn.addEventListener('click', () =>
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true));

addEventListener('online',  () => { offlineB.hidden = true; });
addEventListener('offline', () => { offlineB.hidden = false; });

/* ------------------------------------------------------------------ boot */

async function boot() {
  initTheme();
  if (!navigator.onLine) offlineB.hidden = false;

  if (history.length) renderAll();
  else {
    addBubble({
      role: 'assistant',
      content: 'Hi! I\u2019m your **Electronics Mentor**.\n\n'
             + 'Ask me anything about circuits, components or calculations \u2014 for example:\n\n'
             + '- *What resistor do I need for a 3\u2009V LED on a 9\u2009V supply?*\n'
             + '- *Explain the RC time constant with a formula.*\n'
             + '- *How do I read a 4-band resistor colour code?*',
    }).setActions([]);
  }

  try {
    const res = await fetch('api/config');
    if (res.ok) {
      const cfg = await res.json();
      demoB.hidden = !cfg.demo;
      engineLabel.textContent = cfg.demo ? 'Demo FAQ \u00b7 no API key'
                                         : `${cfg.model || 'DeepSeek'} \u00b7 connected`;
    } else engineLabel.textContent = 'Server unreachable';
  } catch { engineLabel.textContent = 'Server unreachable'; }

  autosize();
  input.focus();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  }
}

boot();
