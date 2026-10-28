// node --test telegram-bridge.test.js
const test = require('node:test');
const assert = require('node:assert');
const b = require('./telegram-bridge.js');

const questions = [
  { question: 'Какой режим?', header: 'Режим', multiSelect: false, options: [{ label: 'Авто', description: 'по простою' }, { label: 'Ручной' }] },
  { question: 'Что слать?', header: 'События', multiSelect: true, options: [{ label: 'Разрешения' }, { label: 'Stop' }, { label: 'Unity' }] },
];

test('callback_data fits 64 bytes and keyboard has extra buttons', () => {
  const st = b.newState(questions);
  const kb = b.buildKeyboard('a1b2c3', 1, questions[1], st[1]);
  const all = kb.inline_keyboard.flat();
  for (const btn of all) assert.ok(Buffer.byteLength(btn.callback_data) <= 64);
  assert.deepStrictEqual(all.slice(-2).map((x) => x.callback_data), ['a1b2c3:1:d', 'a1b2c3:1:o']);
});

test('single, multi and custom answers become the answers map', () => {
  const st = b.newState(questions);
  assert.strictEqual(b.applyCallback('zzzzzz:0:0', 'a1b2c3', questions, st), null);
  assert.strictEqual(b.applyCallback('a1b2c3:0:1', 'a1b2c3', questions, st), 'answered');
  assert.strictEqual(b.applyCallback('a1b2c3:0:0', 'a1b2c3', questions, st), null);
  assert.strictEqual(b.applyCallback('a1b2c3:1:d', 'a1b2c3', questions, st), 'empty');
  b.applyCallback('a1b2c3:1:2', 'a1b2c3', questions, st);
  b.applyCallback('a1b2c3:1:0', 'a1b2c3', questions, st);
  b.applyCallback('a1b2c3:1:2', 'a1b2c3', questions, st);
  b.applyCallback('a1b2c3:1:2', 'a1b2c3', questions, st);
  assert.strictEqual(b.applyCallback('a1b2c3:1:d', 'a1b2c3', questions, st), 'answered');
  assert.deepStrictEqual(b.buildAnswers(questions, st), { 'Какой режим?': 'Ручной', 'Что слать?': 'Разрешения, Unity' });
  assert.strictEqual(b.applyCallback('a1b2c3:1:o', 'a1b2c3', questions, b.newState(questions)), 'custom');
});

test('text helpers escape html and cut by characters, not bytes', () => {
  assert.strictEqual(b.escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.strictEqual(b.truncate('привет мир', 7), 'привет…');
  assert.strictEqual(b.tail('привет мир', 4), '…мир');
});

test('open pipeline stage: last unmatched fresh start wins', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const jsonl = [
    { ts: '2026-10-28T10:00:00Z', event: 'start', topic: 'A', stage: '5', name: 'Реализация' },
    { ts: '2026-10-28T10:30:00Z', event: 'start', topic: 'A', stage: 'wait', name: 'Предстарт' },
    { ts: '2026-10-28T10:31:00Z', event: 'stop', topic: 'A', stage: 'wait' },
  ].map((r) => JSON.stringify(r)).join('\n');
  assert.strictEqual(b.pickOpenStage(jsonl, now), 'A · стадия 5 · Реализация');
  assert.strictEqual(b.pickOpenStage(jsonl, now + 24 * 3600000), null);
});

test('last assistant text comes from the latest assistant entry with text', () => {
  const jsonl = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'старое' }] } },
    { type: 'user', message: { content: 'ok' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Нужен ответ' }, { type: 'tool_use' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  assert.strictEqual(b.extractLastAssistantText(jsonl), 'Нужен ответ');
});

test('markdown becomes Telegram HTML, html in text stays escaped', () => {
  assert.strictEqual(b.mdToHtml('**Да** и `a<b>` & ```js\nx()\n```'), '<b>Да</b> и <code>a&lt;b&gt;</code> &amp; <pre>x()\n</pre>');
  assert.strictEqual(b.mdToHtml('**не закрыт'), '**не закрыт');
});

test('updates are routed to the right parallel session', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const sec = (ms) => Math.floor(ms / 1000);
  const a = { pid: 1, qid: 'aaaaaa', msgIds: [10, 11], startedAt: now - 60000 };
  const s = { pid: 2, qid: null, msgIds: [20], startedAt: now - 30000 };
  const msg = (extra) => ({ message: { message_id: 99, date: sec(now - 1000), text: 'да', ...extra } });
  assert.deepStrictEqual(b.routeUpdate({ callback_query: { id: 'c', data: 'aaaaaa:0:1' } }, [a, s], now), { pid: 1 });
  assert.deepStrictEqual(b.routeUpdate({ callback_query: { id: 'c', data: 'zzzzzz:0:1' } }, [a, s], now).callbackId, 'c');
  assert.deepStrictEqual(b.routeUpdate(msg({ reply_to_message: { message_id: 20 } }), [a, s], now), { pid: 2 });
  assert.deepStrictEqual(b.routeUpdate(msg({ reply_to_message: { message_id: 11 } }), [a, s], now), { pid: 1 });
  assert.ok(b.routeUpdate(msg({ reply_to_message: { message_id: 5 } }), [a, s], now).notice);
  assert.ok(b.routeUpdate(msg({}), [a, s], now).notice, 'plain text with two waiters needs a reply');
  assert.deepStrictEqual(b.routeUpdate(msg({}), [s], now), { pid: 2 });
  assert.strictEqual(b.routeUpdate(msg({ date: sec(now - 3600000) }), [s], now), null, 'old backlog is dropped');
});

test('session topic: first real prompt, slash command with args', () => {
  const line = (content, extra = {}) => JSON.stringify({ type: 'user', message: { content }, ...extra });
  assert.strictEqual(b.extractSessionTopic([
    line('<command-name>/do-plan</command-name><command-message>do-plan</command-message><command-args>FullBagBugs</command-args>'),
  ].join('\n')), '/do-plan FullBagBugs');
  assert.strictEqual(b.extractSessionTopic([
    line('meta', { isMeta: true }),
    line([{ type: 'tool_result' }]),
    line([{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'Изучи PipelineTiming' }]),
  ].join('\n')), 'Изучи PipelineTiming');
});
