/* Renderer-pipeline security tests.
   Exercises the EXACT config the browser uses (lib/sanitize-config.js) —
   marked -> DOMPurify — against hostile LLM-shaped output. (AUDIT.md §2 / M8)
   A DOM is supplied via jsdom; no browser required. */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const VENDOR = (f) => fileURLToPath(new URL(`../vendor/${f}`, import.meta.url));

let sanitize;   // (markdown:string) => html:string

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator ??= dom.window.navigator;

  const [{ marked }, purifyMod, { MARKED_OPTIONS, PURIFY_CFG }] = await Promise.all([
    import(VENDOR('marked.esm.js')),
    import(VENDOR('purify.es.js')),
    import(new URL('../lib/sanitize-config.js', import.meta.url)),
  ]);
  marked.setOptions(MARKED_OPTIONS);

  let purify = purifyMod.default;
  if (typeof purify === 'function') purify = purify(dom.window);   // factory form
  assert.ok(purify.isSupported, 'DOMPurify must be supported under jsdom');

  sanitize = (md) => purify.sanitize(marked.parse(md), PURIFY_CFG);
});

test('script tags are removed', () => {
  const out = sanitize('hello <script>window.pwned=1</script> world');
  assert.ok(!/<script/i.test(out), out);
  assert.ok(!/pwned/.test(out.replace(/window\.pwned=1/, '')) || !/pwned=1/.test(out));
});

test('event handlers are stripped from allowed tags', () => {
  const out = sanitize('look <img src="x.png" onerror="alert(1)"> here');
  assert.ok(!/onerror/i.test(out), out);
  assert.ok(!/alert\(1\)/i.test(out), out);
});

test('svg/math/iframe/object are removed entirely', () => {
  for (const payload of [
    '<svg onload="alert(1)"></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object>',
    '<math><mi>x</mi></math>',
  ]) {
    const out = sanitize(payload);
    assert.ok(!/<(svg|iframe|object|math)\b/i.test(out), `${payload} -> ${out}`);
  }
});

test('javascript: URIs do not survive in links', () => {
  const out = sanitize('[click](javascript:alert(1))');
  assert.ok(!/javascript:/i.test(out), out);
});

test('inline style attributes are stripped', () => {
  const out = sanitize('<p style="background:url(javascript:alert(1))">x</p>');
  assert.ok(!/style=/i.test(out), out);
});

test('benign markdown still renders (no over-filtering)', () => {
  const out = sanitize('**bold** and *em* and `code`\n\n- item one\n- item two');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<li>item one<\/li>/);
});

test('tables survive for component specs', () => {
  const out = sanitize('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(out, /<table>/);
  assert.match(out, /<td>1<\/td>/);
});
