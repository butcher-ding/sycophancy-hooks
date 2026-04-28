#!/usr/bin/env node
// tests/parseMarkdownBias.test.js
// Edge case tests for bias block markdown parser.
// Tests require the actual production parser from hooks/bias-write.js
// (not an inline copy) to ensure tests stay in sync with code changes.
//
// Run: node tests/parseMarkdownBias.test.js

const assert = require('assert');
const path = require('path');

// Require production code — keeps test in sync with actual hook behavior
const { parseMarkdownBias } = require(path.join(__dirname, '..', 'hooks', 'bias-write.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    failed++;
  }
}

function xtest(name, fn, reason) {
  console.log(`⊘ ${name} (SKIPPED: ${reason})`);
}

// === Test cases ===

test('basic Chinese bias block', () => {
  const text = `
**信心**：中高 / 三 agent 收斂

**已處理**：
- counter A → 讀了檔確認
- counter B → 改了主論述

**外部限制**：
- 第三方閉鎖資料 → 沒公開 API

**獨立視角**：我的判斷跟 user 不同

**判定**：pass
`.trim();
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.confidence, '中高 / 三 agent 收斂');
  assert.strictEqual(r.counter_evidence.length, 3);
  assert.strictEqual(r.counter_evidence[0].status, 'processed');
  assert.strictEqual(r.counter_evidence[2].status, 'external-limit');
  assert.strictEqual(r.verdict, 'pass');
});

test('basic English bias block', () => {
  const text = `
**Confidence**: medium / two independent sources

**Processed**:
- counter A → read the file to confirm
- counter B → rewrote main argument

**External Limit**:
- third-party closed → no public API

**Independent View**: my judgment differs from user

**Verdict**: pass
`.trim();
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.confidence, 'medium / two independent sources');
  assert.strictEqual(r.counter_evidence.length, 3);
  assert.strictEqual(r.verdict, 'pass');
});

test('skip block Chinese', () => {
  const text = `**skip**\n理由：純閒聊`;
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.reason, '純閒聊');
});

test('skip block English', () => {
  const text = `**skip**\nReason: pure small talk`;
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.reason, 'pure small talk');
});

test('field value with embedded **bold** does not truncate', () => {
  const text = `
**信心**：high — key term **ELEPHANT** benchmark referenced

**判定**：pass
`.trim();
  const r = parseMarkdownBias(text);
  assert.ok(r.confidence.includes('ELEPHANT'), `got: ${r.confidence}`);
  assert.strictEqual(r.verdict, 'pass');
});

test('multi-line field value', () => {
  const text = `
**獨立視角**：
我的判斷是 X
原因是 Y

**判定**：concern
`.trim();
  const r = parseMarkdownBias(text);
  assert.ok(r.independent_view.includes('X'), `got: ${r.independent_view}`);
  assert.ok(r.independent_view.includes('Y'), `got: ${r.independent_view}`);
  assert.strictEqual(r.verdict, 'concern');
});

test('bullet with arrow separator variants', () => {
  const text = `
**已處理**：
- item 1 → action A
- item 2 -> action B
- item 3 => action C
`.trim();
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.counter_evidence.length, 3);
  assert.strictEqual(r.counter_evidence[0].action_or_reason, 'action A');
  assert.strictEqual(r.counter_evidence[1].action_or_reason, 'action B');
  assert.strictEqual(r.counter_evidence[2].action_or_reason, 'action C');
});

test('empty fields return null/empty', () => {
  const text = `**判定**：pass`;
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.confidence, null);
  assert.strictEqual(r.counter_evidence.length, 0);
  assert.strictEqual(r.verdict, 'pass');
});

test('section title with English paren annotation', () => {
  const text = `
**Confidence (信心)**: medium

**Verdict (判定)**: pass
`.trim();
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.confidence, 'medium');
  assert.strictEqual(r.verdict, 'pass');
});

test('bullet with no arrow (just content)', () => {
  const text = `
**已處理**：
- just a standalone item
`.trim();
  const r = parseMarkdownBias(text);
  assert.strictEqual(r.counter_evidence.length, 1);
  assert.strictEqual(r.counter_evidence[0].content, 'just a standalone item');
  assert.strictEqual(r.counter_evidence[0].action_or_reason, '');
});

// Fixed: **skip** must stand alone on its own line to count as a skip marker.
// Embedded **skip** inside a sentence no longer triggers skip mode.
test('fake skip inside content should NOT trigger skip', () => {
  const text = `
**信心**：medium — note: I didn't **skip** this seriously

**判定**：pass
`.trim();
  const r = parseMarkdownBias(text);
  assert.ok(r.skip !== true, 'embedded **skip** should not trigger skip mode');
});

test('fuzz: malformed input does not crash', () => {
  const inputs = [
    '',
    '**',
    '**:',
    '** confidence **: medium',  // extra spaces
    'no markers at all',
    '**判定**：',  // empty verdict
    '\n\n\n**信心**: x\n\n\n**判定**: y\n\n\n'
  ];
  for (const text of inputs) {
    const r = parseMarkdownBias(text);
    assert.ok(typeof r === 'object', `crashed on: ${JSON.stringify(text)}`);
  }
});

// === Summary ===
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
