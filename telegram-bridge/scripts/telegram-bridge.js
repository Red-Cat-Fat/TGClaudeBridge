#!/usr/bin/env node
// Claude Code hooks: Telegram bridge for when the user is away from the computer.
//   node telegram-bridge.js ask     PreToolUse(AskUserQuestion): question + inline buttons, answer goes back to Claude
//   node telegram-bridge.js notify  Notification(permission_prompt): plain message
//   node telegram-bridge.js stop    Stop: "done" + the last answer; a text reply continues the session
//
// Env: CLAUDE_TG_BOT_TOKEN, CLAUDE_TG_CHAT_ID (required; TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID also accepted),
//      CLAUDE_TG_IDLE_MIN (default 3, fractions allowed: 0.5 = 30 s; 0 = test mode, always Telegram).
// "Away" = no keyboard/mouse input for CLAUDE_TG_IDLE_MIN minutes (Windows: GetLastInputInfo, macOS: ioreg,
// Linux/X11: xprintidle). If idle time can't be measured, the user counts as present and nothing is sent.
// Never blocks Claude: every failure path exits 0 with no output, and the question shows in the app as usual.
// Parallel sessions: each waiting session gets its own messages; a reply is routed by the message it answers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// On some networks api.telegram.org over IPv6 hangs on connect while IPv4 is fine.
require('dns').setDefaultResultOrder('ipv4first');

const TOKEN = process.env.CLAUDE_TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = String(process.env.CLAUDE_TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '');
const IDLE_MS = Number(process.env.CLAUDE_TG_IDLE_MIN || 3) * 60000;
const RETURN_MS = 20000;
const IDLE_CHECK_MS = 2000;
const ASK_DEADLINE_MS = 55 * 60000;
const WARN_BEFORE_MS = 5 * 60000;
const STATE_DIR = path.join(os.homedir(), '.claude', 'telegram-bridge');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');

function log(msg) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${String(msg).split(TOKEN || '\0').join('***')}\n`);
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Claude's markdown -> Telegram HTML: code fences, `code`, **bold**. Truncate before calling, never after,
// so a cut can't leave an unclosed tag (an unpaired ** just stays literal).
function mdToHtml(s) {
  return escapeHtml(s)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

function truncate(s, max) {
  const chars = Array.from(String(s).trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

function tail(s, max) {
  const chars = Array.from(String(s).trim());
  return chars.length <= max ? chars.join('') : '…' + chars.slice(chars.length - max + 1).join('');
}

// Last open `start` from PipelineTiming.jsonl, ignoring ones older than 12h (forgotten stops).
function pickOpenStage(jsonlText, now = Date.now()) {
  const open = new Map();
  for (const line of jsonlText.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const key = `${r.topic}|${r.stage}`;
    if (r.event === 'start') { open.delete(key); open.set(key, r); }
    else if (r.event === 'stop') open.delete(key);
  }
  const last = [...open.values()].pop();
  if (!last || now - Date.parse(last.ts) > 12 * 3600000) return null;
  return `${last.topic} · стадия ${last.stage} · ${last.name || ''}`.trim();
}

// Text of the last assistant message that has text blocks, from a transcript JSONL.
function extractLastAssistantText(jsonlText) {
  const lines = jsonlText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
    const text = r.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

// First real user prompt of the session (slash command + args, or plain text) — tells parallel sessions apart.
function extractSessionTopic(jsonlText) {
  for (const line of jsonlText.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' || r.isMeta || !r.message) continue;
    let c = r.message.content;
    if (Array.isArray(c)) c = c.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
    if (typeof c !== 'string') continue;
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(c);
    const args = /<command-args>([^<]*)<\/command-args>/.exec(c);
    const text = cmd ? `${cmd[1]} ${args ? args[1] : ''}` : c.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, ' ');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) return clean;
  }
  return '';
}

function readHead(file, bytes = 256 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

function readTail(file, bytes = 512 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : '';
}

function contextHeader(input) {
  const cwd = input.cwd || process.cwd();
  const root = git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const lines = [`📁 <b>${escapeHtml(path.basename(root))}</b>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`];
  const topic = extractSessionTopic(readHead(input.transcript_path || ''));
  if (topic) lines.push(`🗂 ${escapeHtml(truncate(topic, 80))}`);
  // Optional: a stage-timer JSONL log ({ts, event: start|stop, topic, stage, name}) relative to the repo root.
  const stageLog = process.env.CLAUDE_TG_STAGE_LOG;
  const stage = stageLog && pickOpenStage(readTail(path.join(root, stageLog), 64 * 1024));
  if (stage) lines.push(`🧭 ${escapeHtml(stage)}`);
  return lines.join('\n');
}

function lastAssistantText(input) {
  return input.last_assistant_message || extractLastAssistantText(readTail(input.transcript_path || ''));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return String(r.stdout || '');
}

const WIN_IDLE_TYPE = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class TgIdle {
  [StructLayout(LayoutKind.Sequential)] struct L { public uint cb; public uint t; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);
  public static long Ms() { L l = new L(); l.cb = 8; if (!GetLastInputInfo(ref l)) return 0; return unchecked((uint)Environment.TickCount - l.t); }
}
'@`;

// Milliseconds since the last keyboard/mouse input; 0 when unknown, so failures count as "user is here".
function idleMs() {
  if (process.platform === 'darwin') {
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']));
    return m ? Math.floor(Number(m[1]) / 1e6) : 0;
  }
  if (process.platform !== 'win32') {
    const ms = Number(run('xprintidle', []).trim());
    return Number.isFinite(ms) ? ms : 0;
  }
  const ps = `${WIN_IDLE_TYPE}
[TgIdle]::Ms()`;
  const ms = Number(run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]).trim());
  return Number.isFinite(ms) ? ms : 0;
}

// Windows: one long-lived PowerShell reports idle time every second, so "back at the PC" is noticed in ~2 s
// without paying ~1 s of PowerShell startup on every check.
let idleWatch = null;

function startIdleWatcher() {
  if (process.platform !== 'win32' || idleWatch) return;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `${WIN_IDLE_TYPE}
while ($true) { [TgIdle]::Ms(); Start-Sleep -Milliseconds 1000 }`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  idleWatch = { ms: null, at: 0 };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    const lines = (buf + d).split(/\r?\n/);
    buf = lines.pop();
    const v = Number(lines.filter((l) => l.trim()).pop());
    if (Number.isFinite(v)) { idleWatch.ms = v; idleWatch.at = Date.now(); }
  });
  child.on('error', () => {});
  child.unref();
  process.on('exit', () => { try { child.kill(); } catch {} });
}

function currentIdleMs() {
  return idleWatch && idleWatch.ms !== null && Date.now() - idleWatch.at < 3000 ? idleWatch.ms : idleMs();
}

async function tg(method, body, timeoutMs = 15000, retries = 1) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (retries <= 0) throw e;
    log(`${method}: ${e.message} ${(e.cause && e.cause.code) || ''}, retry`);
    return tg(method, body, timeoutMs, retries - 1);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

// Text parts are length-limited before markup; if Telegram still rejects the HTML, resend as plain text.
async function send(text, extra = {}) {
  try {
    return await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML', ...extra });
  } catch (e) {
    if (!/parse entities|too long/i.test(e.message)) throw e;
    log(e.message);
    const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return tg('sendMessage', { chat_id: CHAT_ID, text: truncate(plain, 4000), ...extra });
  }
}

// ---------- ask: pure question state ----------

function newState(questions) {
  return questions.map(() => ({ selected: new Set(), answer: null }));
}

function questionText(q, st) {
  const lines = [`<b>${escapeHtml(q.header || 'Вопрос')}</b>: ${escapeHtml(q.question)}`];
  (q.options || []).forEach((o, i) => {
    lines.push(`${i + 1}. <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}`);
  });
  if (q.multiSelect && st.answer === null) lines.push('<i>Можно выбрать несколько, затем «Готово».</i>');
  if (st.answer !== null) lines.push(`\n✅ Ответ: <b>${escapeHtml(st.answer)}</b>`);
  return lines.join('\n');
}

function buildKeyboard(qid, qi, q, st) {
  if (st.answer !== null) return { inline_keyboard: [] };
  const rows = (q.options || []).map((o, oi) => [{
    text: `${q.multiSelect && st.selected.has(oi) ? '✅ ' : ''}${oi + 1}. ${truncate(o.label, 60)}`,
    callback_data: `${qid}:${qi}:${oi}`,
  }]);
  const tailRow = [{ text: '✏️ Свой ответ', callback_data: `${qid}:${qi}:o` }];
  if (q.multiSelect) tailRow.unshift({ text: '☑️ Готово', callback_data: `${qid}:${qi}:d` });
  rows.push(tailRow);
  return { inline_keyboard: rows };
}

// Applies a button press. Returns 'answered' | 'toggled' | 'custom' | 'empty' | null (not ours / invalid).
function applyCallback(data, qid, questions, state) {
  const [id, qiRaw, act] = String(data).split(':');
  const qi = Number(qiRaw);
  if (id !== qid || !questions[qi] || state[qi].answer !== null) return null;
  const q = questions[qi];
  const st = state[qi];
  if (act === 'o') return 'custom';
  if (act === 'd') {
    if (!st.selected.size) return 'empty';
    st.answer = [...st.selected].sort((a, b) => a - b).map((i) => q.options[i].label).join(', ');
    return 'answered';
  }
  const oi = Number(act);
  if (!q.options || !q.options[oi]) return null;
  if (q.multiSelect) {
    if (st.selected.has(oi)) st.selected.delete(oi); else st.selected.add(oi);
    return 'toggled';
  }
  st.answer = q.options[oi].label;
  return 'answered';
}

function buildAnswers(questions, state) {
  const answers = {};
  questions.forEach((q, i) => { answers[q.question] = state[i].answer; });
  return answers;
}

// ---------- routing between parallel sessions ----------
// Telegram has one update queue per bot and allows one getUpdates at a time. So one waiting hook process is the
// poller: it reads the queue and drops each update into the inbox of the session it belongs to. Every waiting
// session registers its message ids and button prefix; a reply is routed by the message it replies to.

const WAITERS_DIR = path.join(STATE_DIR, 'waiters');
const INBOX_DIR = path.join(STATE_DIR, 'inbox');
const POLLER_LOCK = path.join(STATE_DIR, 'poller.lock');
const OFFSET_FILE = path.join(STATE_DIR, 'offset');
const STALE_MS = 10 * 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Who gets an update: { pid } of a waiting session, { notice } for the user, or null to drop it silently.
function routeUpdate(u, waiters, now = Date.now()) {
  const cb = u.callback_query;
  if (cb) {
    const w = waiters.find((x) => x.qid && x.qid === String(cb.data || '').split(':')[0]);
    return w ? { pid: w.pid } : { notice: 'Вопрос уже неактуален', callbackId: cb.id };
  }
  const m = u.message;
  if (!m || !m.text) return null;
  const sentAt = m.date * 1000;
  const replyTo = m.reply_to_message && m.reply_to_message.message_id;
  if (replyTo) {
    const w = waiters.find((x) => x.msgIds.includes(replyTo));
    if (w) return { pid: w.pid };
    return now - sentAt < STALE_MS ? { notice: 'Эта сессия уже не ждёт ответа — продолжите на ПК.' } : null;
  }
  const fresh = waiters.filter((x) => sentAt >= x.startedAt - 1000);
  if (fresh.length === 1) return { pid: fresh[0].pid };
  if (now - sentAt >= STALE_MS) return null;
  return {
    notice: fresh.length
      ? 'Ответа ждут несколько сессий — ответьте реплаем на сообщение нужной.'
      : 'Сейчас ни одна сессия не ждёт ответа.',
  };
}

function saveWaiter(w) {
  fs.writeFileSync(path.join(WAITERS_DIR, `${w.pid}.json`), JSON.stringify(w));
}

function loadWaiters() {
  const list = [];
  for (const f of fs.readdirSync(WAITERS_DIR)) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(WAITERS_DIR, f), 'utf8'));
      if (alive(w.pid)) list.push(w); else fs.unlinkSync(path.join(WAITERS_DIR, f));
    } catch {}
  }
  return list;
}

function tryBecomePoller() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(POLLER_LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      const pid = Number(readSafe(POLLER_LOCK));
      if (pid === process.pid) return true;
      if (pid && alive(pid)) return false;
      try { fs.unlinkSync(POLLER_LOCK); } catch {}
    }
  }
  return false;
}

function releaseWaiter(pid) {
  try { fs.unlinkSync(path.join(WAITERS_DIR, `${pid}.json`)); } catch {}
  try { if (Number(readSafe(POLLER_LOCK)) === pid) fs.unlinkSync(POLLER_LOCK); } catch {}
  try {
    for (const f of fs.readdirSync(INBOX_DIR)) if (f.startsWith(`${pid}-`)) fs.unlinkSync(path.join(INBOX_DIR, f));
  } catch {}
}

async function pollOnce() {
  let offset = Number(readSafe(OFFSET_FILE)) || 0;
  const updates = await tg('getUpdates', { offset, timeout: 3, allowed_updates: ['callback_query', 'message'] }, 15000);
  const waiters = loadWaiters();
  for (const u of updates) {
    offset = u.update_id + 1;
    const chat = u.callback_query ? u.callback_query.message && u.callback_query.message.chat : u.message && u.message.chat;
    if (!chat || String(chat.id) !== CHAT_ID) continue;
    const r = routeUpdate(u, waiters);
    if (!r) continue;
    if (r.pid) fs.writeFileSync(path.join(INBOX_DIR, `${r.pid}-${u.update_id}.json`), JSON.stringify(u));
    else if (r.callbackId) await tg('answerCallbackQuery', { callback_query_id: r.callbackId, text: r.notice }).catch((e) => log(e.message));
    else await send(`<i>${escapeHtml(r.notice)}</i>`, { reply_parameters: { message_id: u.message.message_id } }).catch((e) => log(e.message));
  }
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

function takeInbox(pid) {
  const files = fs.readdirSync(INBOX_DIR).filter((f) => f.startsWith(`${pid}-`))
    .sort((a, b) => Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]));
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf8'))); } catch {}
    try { fs.unlinkSync(path.join(INBOX_DIR, f)); } catch {}
  }
  return out;
}

// Waits until `handle(update)` returns true. Result: 'done' | 'returned' (user is back at the PC) | 'timeout'.
async function runWait(waiter, handle) {
  fs.mkdirSync(WAITERS_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  saveWaiter(waiter);
  process.on('exit', () => releaseWaiter(waiter.pid));
  const warn = deadlineWarner(waiter.deadline, waiter.msgIds[0]);
  startIdleWatcher();
  let nextIdleCheck = Date.now() + IDLE_CHECK_MS;
  let conflicts = 0;
  try {
    while (Date.now() < waiter.deadline) {
      await warn();
      if (tryBecomePoller()) {
        try {
          await pollOnce();
          conflicts = 0;
        } catch (e) {
          log(e.message);
          // 409 Conflict = something else reads this bot's queue (an old bridge process, a second copy, a server bot):
          // it may swallow replies meant for this session. ~30 s of conflicts -> tell the user once.
          if (/Conflict/.test(e.message) && ++conflicts === 6) {
            await send('⚠️ <i>Этого бота читает ещё одна программа (вторая копия моста или бот на сервере). Ответы могут уйти не в ту сессию — оставьте один экземпляр.</i>').catch((x) => log(x.message));
          }
          await sleep(5000);
        }
      } else {
        await sleep(1000);
      }
      for (const u of takeInbox(waiter.pid)) if (await handle(u)) return 'done';
      // CLAUDE_TG_IDLE_MIN=0 is the test mode: always Telegram, no "back at the PC" handoff.
      if (IDLE_MS > 0 && Date.now() >= nextIdleCheck) {
        if (currentIdleMs() < RETURN_MS) return 'returned';
        nextIdleCheck = Date.now() + IDLE_CHECK_MS;
      }
    }
    return 'timeout';
  } finally {
    releaseWaiter(waiter.pid);
  }
}

// ---------- modes ----------

// Once per wait: "5 minutes left" as a reply to the waiting message.
function deadlineWarner(deadline, replyToId) {
  let warned = false;
  return async () => {
    if (warned || deadline - Date.now() > WARN_BEFORE_MS) return;
    warned = true;
    await send('⏳ <i>Через 5 минут перестану ждать ответа — дальше только на ПК.</i>', {
      reply_parameters: { message_id: replyToId },
    }).catch((e) => log(e.message));
  };
}

async function modeAsk(input) {
  const questions = (input.tool_input && input.tool_input.questions) || [];
  if (!questions.length || idleMs() < IDLE_MS) return;

  const said = lastAssistantText(input);
  const intro = `❓ <b>Claude ждёт ответа</b>\n${contextHeader(input)}${said ? `\n\n💬 ${mdToHtml(tail(said, 3400))}` : ''}`;
  const qid = crypto.randomBytes(3).toString('hex');
  const state = newState(questions);
  const waiter = { pid: process.pid, qid, msgIds: [], startedAt: Date.now(), deadline: Date.now() + ASK_DEADLINE_MS };

  const introMsg = await send(intro);
  const qMsgIds = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const m = await send(questionText(questions[qi], state[qi]), { reply_markup: buildKeyboard(qid, qi, questions[qi], state[qi]) });
    qMsgIds.push(m.message_id);
  }
  waiter.msgIds.push(...qMsgIds, introMsg.message_id);

  const refresh = (qi, note = '') => tg('editMessageText', {
    chat_id: CHAT_ID, message_id: qMsgIds[qi], parse_mode: 'HTML',
    text: `${questionText(questions[qi], state[qi])}${note ? `\n\n${note}` : ''}`,
    reply_markup: note ? { inline_keyboard: [] } : buildKeyboard(qid, qi, questions[qi], state[qi]),
  }).catch((e) => log(e.message));

  const pendingCustom = new Map();
  const result = await runWait(waiter, async (u) => {
    const cb = u.callback_query;
    if (cb) {
      const res = applyCallback(cb.data, qid, questions, state);
      const qi = Number(String(cb.data).split(':')[1]);
      let toast = res ? '' : 'Вопрос уже неактуален';
      if (res === 'empty') toast = 'Сначала выберите вариант';
      if (res === 'custom') {
        const m = await send(`✏️ Ответ на «${escapeHtml(truncate(questions[qi].question, 200))}»:`, {
          reply_markup: { force_reply: true, input_field_placeholder: 'Ваш ответ' },
        });
        pendingCustom.set(m.message_id, qi);
        waiter.msgIds.push(m.message_id);
        saveWaiter(waiter);
      }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: toast }).catch(() => {});
      if (res === 'answered' || res === 'toggled') await refresh(qi);
    } else {
      const replyTo = u.message.reply_to_message && u.message.reply_to_message.message_id;
      const open = state.map((s, i) => (s.answer === null ? i : -1)).filter((i) => i >= 0);
      let qi = pendingCustom.has(replyTo) ? pendingCustom.get(replyTo) : qMsgIds.indexOf(replyTo);
      if (qi < 0 && pendingCustom.size === 1) qi = [...pendingCustom.values()][0];
      if (qi < 0 && open.length === 1) qi = open[0];
      if (qi < 0 || state[qi].answer !== null) {
        await send('<i>Не понял, к какому вопросу ответ — ответьте реплаем на сам вопрос.</i>', {
          reply_parameters: { message_id: u.message.message_id },
        }).catch((e) => log(e.message));
        return false;
      }
      state[qi].answer = u.message.text.trim();
      for (const [k, v] of pendingCustom) if (v === qi) pendingCustom.delete(k);
      await refresh(qi);
    }
    return state.every((s) => s.answer !== null);
  });

  if (result === 'done') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Ответ получен в Telegram',
        updatedInput: { ...input.tool_input, answers: buildAnswers(questions, state) },
      },
    }));
    return;
  }
  const note = result === 'returned'
    ? '↩️ <i>Вы вернулись к ПК — отвечайте там.</i>'
    : '⌛ <i>Время ожидания вышло — вопрос ждёт на ПК.</i>';
  for (let qi = 0; qi < questions.length; qi++) if (state[qi].answer === null) await refresh(qi, note);
}

async function modeNotify(input) {
  // AskUserQuestion also raises permission_prompt; the `ask` mode already sent it with buttons.
  if (/AskUserQuestion/.test(input.message || '') || idleMs() < IDLE_MS) return;
  await send(`🔐 <b>Claude нужно разрешение</b>\n${contextHeader(input)}\n\n${escapeHtml(input.message || '')}`);
}

// "Done" message, then wait for a text reply; a reply continues the session via Stop `decision: block`.
// stop_hook_active is not a skip here: it means the previous turn came from a Telegram reply, so keep the chat going.
async function modeStop(input) {
  if (idleMs() < IDLE_MS) return;
  const said = lastAssistantText(input);
  const text = `✅ <b>Claude закончил</b>\n${contextHeader(input)}${said ? `\n\n${mdToHtml(truncate(said, 3300))}` : ''}`;
  const waiter = { pid: process.pid, qid: null, msgIds: [], startedAt: Date.now(), deadline: Date.now() + ASK_DEADLINE_MS };
  const sent = await send(`${text}\n\n<i>↩️ Ответьте на это сообщение, чтобы продолжить.</i>`);
  waiter.msgIds.push(sent.message_id);
  const close = (note) => tg('editMessageText', {
    chat_id: CHAT_ID, message_id: sent.message_id, parse_mode: 'HTML', text: `${text}\n\n${note}`,
  }).catch((e) => log(e.message));

  let reply = null;
  const result = await runWait(waiter, async (u) => {
    if (!u.message || !u.message.text) return false;
    reply = u.message.text.trim();
    return true;
  });
  if (result === 'returned') await close('↩️ <i>Вы вернулись к ПК — продолжайте там.</i>');
  if (result === 'timeout') await close('⌛ <i>Сессия больше не ждёт ответа — продолжайте на ПК.</i>');
  if (result !== 'done') return;
  await close(`📨 <i>Передано в сессию:</i> ${escapeHtml(truncate(reply, 300))}`);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Пользователь не за ПК и ответил из Telegram: ${reply}`,
  }));
}

async function main() {
  if (!TOKEN || !CHAT_ID) return;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const mode = process.argv[2];
  if (mode === 'ask') await modeAsk(input);
  else if (mode === 'notify') await modeNotify(input);
  else if (mode === 'stop') await modeStop(input);
}

if (require.main === module) {
  main().catch((e) => log(e && e.message)).finally(() => process.exit(0));
}

module.exports = {
  escapeHtml, mdToHtml, truncate, tail, pickOpenStage, extractLastAssistantText, extractSessionTopic,
  newState, questionText, buildKeyboard, applyCallback, buildAnswers, routeUpdate, idleMs, startIdleWatcher, currentIdleMs,
};
