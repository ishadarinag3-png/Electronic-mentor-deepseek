/* Frontend boot smoke test.
   app.js is an ES module, so JSDOM cannot execute it via runScripts. Instead we
   load the REAL index.html into JSDOM, expose its globals, stub fetch (no
   backend -> static-host path) and then import app.js for real. This is the
   only place the frontend is actually executed, so it catches missing element
   ids, top-level ReferenceErrors and boot-order bugs. */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

before(async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;

  w.Element.prototype.scrollTo = function () {};      // jsdom has no layout/scrolling
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.location = w.location;
  // Some jsdom builds lack matchMedia; provide a minimal MQL polyfill then.
  globalThis.matchMedia = typeof w.matchMedia === 'function'
    ? w.matchMedia.bind(w)
    : (q) => ({ matches: false, media: q, onchange: null,
                addEventListener() {}, removeEventListener() {},
                addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  globalThis.localStorage = w.localStorage;
  globalThis.addEventListener = w.addEventListener.bind(w);
  globalThis.removeEventListener = w.removeEventListener.bind(w);
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });

  // No backend: every /api call 404s, exercising the static-host fallback path.
  globalThis.fetch = async () => ({ ok: false, status: 404,
                                    json: async () => ({}), text: async () => '' });

  await import(new URL('../app.js', import.meta.url));   // executes boot()
  await new Promise((r) => setTimeout(r, 60));            // let boot settle
});

test('app boots without throwing: greeting bubble renders', () => {
  assert.ok(document.querySelector('.msg--bot'), 'greeting bubble missing');
});

test('all starter chips render when the transcript is empty', () => {
  const chips = document.querySelectorAll('.starter');
  assert.equal(chips.length, 12, 'expected the full starter library as chips');
  assert.equal(document.getElementById('starters').hidden, false);
});

test('static-host fallback engages: demo banner + in-browser engine label', () => {
  assert.equal(document.getElementById('demo-banner').hidden, false);
  assert.match(document.getElementById('engine-label').textContent, /Demo/i);
});

test('clicking a starter sends it and hides the chip row', async () => {
  const chip = document.querySelector('.starter');
  const label = chip.textContent;
  chip.click();
  await new Promise((r) => setTimeout(r, 120));

  const user = document.querySelector('.msg--user');
  assert.ok(user, 'a user bubble should appear after clicking a starter');
  assert.ok(user.textContent.length > 5, 'user bubble should carry the prompt text');
  assert.equal(document.getElementById('starters').hidden, true,
               'chips must hide once a conversation starts');
  assert.ok(label.length > 0);
});

test('the composer wires Enter-to-send through the form', () => {
  const input = document.getElementById('input');
  input.value = 'ohms law';
  const ev = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'Enter should be handled, not left to the browser');
});
