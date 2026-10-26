'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReasoning, reasoningLabel, reasoningUsage } = require('../../src/core/reasoning.cjs');

test('native Work tiers normalize consistently and remain unavailable to Chat or local mode', () => {
  assert.equal(normalizeReasoning(' 4 ', 'work'), 'tier-4');
  assert.equal(normalizeReasoning('tier-6', 'work'), 'tier-6');
  for (const value of ['0', '10', 'tier-0', 'tier-10', '2 extra']) assert.throws(() => normalizeReasoning(value, 'work'), /用法/);
  for (const mode of ['chat', 'local']) assert.throws(() => normalizeReasoning('3', mode), /用法/);
  assert.equal(normalizeReasoning('高'), 'high');
});

test('Work labels describe native tiers and endpoint shortcuts while Chat labels retain their meaning', () => {
  assert.equal(reasoningLabel('tier-4', 'work'), '第 4 档');
  assert.equal(reasoningLabel('instant', 'work'), '网页最低档');
  assert.equal(reasoningLabel('pro', 'work'), '网页最高档');
  assert.equal(reasoningLabel('instant'), '即时');
  assert.equal(reasoningLabel('pro'), 'Pro');
  assert.match(reasoningUsage('work'), /1–9/);
});
