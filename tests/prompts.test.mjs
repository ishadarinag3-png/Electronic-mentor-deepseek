/* Starter-prompt library tests. Guarantees there are no "dead chips":
   every suggestion a user can tap must produce a real answer, at least in
   demo mode. (Track 3 — product depth.) */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STARTERS } from '../lib/prompts.js';
import { answerFor } from '../lib/demo-mentor.js';

test('starter library is substantial and ids are unique', () => {
  assert.ok(STARTERS.length >= 8, 'expected a useful number of starters');
  const ids = new Set(STARTERS.map((s) => s.id));
  assert.equal(ids.size, STARTERS.length, 'duplicate starter id');
  for (const s of STARTERS) {
    assert.ok(s.label && s.label.length <= 24, `${s.id}: label too long for a chip`);
    assert.ok(s.text && s.text.length > 10, `${s.id}: missing prompt text`);
  }
});

test('every starter yields a real demo-FAQ answer (no dead chips)', () => {
  for (const s of STARTERS) {
    const a = answerFor([{ role: 'user', content: s.text }]);
    assert.ok(!a.includes("couldn't match"), `${s.id}: fell through to the fallback`);
    assert.ok(a.length > 80, `${s.id}: answer suspiciously short`);
  }
});
