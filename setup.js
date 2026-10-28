#!/usr/bin/env node
// Interactive setup for TGClaudeBridge: bot token, chat id, idle threshold -> env vars, test message, plugin install.
// Run via setup.cmd (Windows) or setup.sh (macOS / Linux).

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

require('dns').setDefaultResultOrder('ipv4first');

const MARK = '# TGClaudeBridge';
const MARKETPLACE_GITHUB = 'Red-Cat-Fat/TGClaudeBridge';
const PLUGIN = 'telegram-bridge@tg-claude-bridge';
const IS_WIN = process.platform === 'win32';

// Replaces the marked export block in a shell rc file, or appends it once.
function upsertEnvBlock(text, vars) {
  const quote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const block = [MARK, ...Object.entries(vars).map(([k, v]) => `export ${k}=${quote(v)}`), `${MARK} end`].join('\n');
  const re = new RegExp(`${MARK}\\n[\\s\\S]*?${MARK} end\\n?`);
  if (re.test(text)) return text.replace(re, `${block}\n`);
  return text ? `${text.replace(/\n*$/, '\n')}\n${block}\n` : `${block}\n`;
}

async function api(token, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.description || 'Telegram API error');
  return json.result;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN });
  return r.status === 0;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.log('Нужен Node.js 18 или новее: https://nodejs.org');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(def !== undefined ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || (def !== undefined ? String(def) : '');
  };
  const yes = async (q, def = true) => {
    const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
    return a ? /^(y|д)/.test(a) : def;
  };

  console.log('\n=== Настройка TGClaudeBridge ===');
  console.log('Пока вы не за компьютером, вопросы Claude Code будут приходить в Telegram с кнопками ответа.\n');
  console.log('1. Создайте бота: откройте https://t.me/BotFather, отправьте /newbot и скопируйте токен.');
  console.log('   Нужен отдельный бот — не тот, которым уже пользуется другая программа.\n');

  let token;
  let bot;
  for (;;) {
    token = await ask('Токен бота');
    try {
      bot = await api(token, 'getMe');
      break;
    } catch (e) {
      console.log(`   ✗ Telegram не принял токен (${e.message}). Попробуйте ещё раз.`);
    }
  }
  console.log(`   ✓ Бот @${bot.username}`);

  const hook = await api(token, 'getWebhookInfo').catch(() => ({}));
  if (hook.url) {
    console.log(`   ⚠ У бота настроен webhook (${hook.url}) — с ним мост не получит ваши ответы.`);
    if (await yes('   Отключить webhook?', false)) await api(token, 'deleteWebhook');
  }

  console.log(`\n2. Откройте https://t.me/${bot.username}, нажмите «Start» или отправьте боту любое сообщение.`);
  let chatId = '';
  for (let i = 0; i < 3 && !chatId; i++) {
    await ask('   Нажмите Enter, когда отправите');
    let updates = [];
    try {
      updates = await api(token, 'getUpdates', { timeout: 0 });
    } catch (e) {
      console.log(`   ✗ Не удалось прочитать сообщения: ${e.message}`);
      break;
    }
    if (updates.length) await api(token, 'getUpdates', { offset: updates[updates.length - 1].update_id + 1, timeout: 0 }).catch(() => {});
    const msg = updates.map((u) => u.message).filter((m) => m && m.chat && m.chat.type === 'private').pop();
    if (!msg) {
      console.log('   Сообщений пока нет.');
      continue;
    }
    const who = [msg.from.first_name, msg.from.last_name, msg.from.username && `@${msg.from.username}`].filter(Boolean).join(' ');
    if (await yes(`   Нашёл чат: ${who} (id ${msg.chat.id}). Это вы?`)) chatId = String(msg.chat.id);
  }
  if (!chatId) chatId = await ask('   Введите chat id вручную (его присылает https://t.me/userinfobot)');

  console.log('\n3. Когда считать, что вы отошли от компьютера?');
  let idle;
  for (;;) {
    idle = await ask('   Минут без мыши и клавиатуры (дробные можно: 0.5 = 30 секунд)', 1);
    if (Number.isFinite(Number(idle)) && Number(idle) >= 0) break;
    console.log('   Нужно число, например 1 или 0.5.');
  }

  try {
    await api(token, 'sendMessage', {
      chat_id: chatId,
      text: '✅ TGClaudeBridge подключён. Сюда будут приходить вопросы и ответы Claude Code, пока вы не за компьютером.',
    });
    console.log('   ✓ Тестовое сообщение отправлено — проверьте Telegram.');
  } catch (e) {
    console.log(`   ✗ Не удалось написать в чат ${chatId}: ${e.message}. Проверьте chat id и запустите настройку снова.`);
    rl.close();
    process.exit(1);
  }

  const vars = { CLAUDE_TG_BOT_TOKEN: token, CLAUDE_TG_CHAT_ID: chatId, CLAUDE_TG_IDLE_MIN: idle };
  console.log('\n4. Сохраняю настройки в переменные окружения…');
  if (IS_WIN) {
    for (const [k, v] of Object.entries(vars)) {
      const r = spawnSync('setx', [k, v], { stdio: 'ignore' });
      console.log(r.status === 0 ? `   ✓ ${k}` : `   ✗ ${k}: setx не сработал`);
    }
  } else {
    const rc = path.join(os.homedir(), /zsh/.test(process.env.SHELL || '') ? '.zshrc' : '.bashrc');
    const old = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    fs.writeFileSync(rc, upsertEnvBlock(old, vars));
    console.log(`   ✓ Записано в ${rc}`);
    if (process.platform === 'darwin') {
      for (const [k, v] of Object.entries(vars)) spawnSync('launchctl', ['setenv', k, v], { stdio: 'ignore' });
      console.log('   ✓ Для приложений macOS (launchctl) — до перезагрузки. После перезагрузки запустите настройку снова');
      console.log('     или открывайте Claude Code из терминала.');
    }
  }

  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(settings) && fs.readFileSync(settings, 'utf8').includes('telegram-bridge.js')) {
    console.log(`\n   ⚠ В ${settings} уже есть хуки telegram-bridge.js, добавленные вручную.`);
    console.log('     Удалите их после установки плагина, иначе будут работать две копии моста.');
  }

  console.log('\n5. Плагин Claude Code');
  const hasClaude = spawnSync('claude', ['--version'], { stdio: 'ignore', shell: IS_WIN }).status === 0;
  if (hasClaude && await yes('   Установить плагин сейчас?')) {
    const added = run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_GITHUB])
      || run('claude', ['plugin', 'marketplace', 'add', __dirname]);
    if (added && run('claude', ['plugin', 'install', PLUGIN])) console.log('   ✓ Плагин установлен');
    else console.log('   ✗ Установка не удалась — команды для ручной установки ниже.');
  }
  if (!hasClaude) console.log('   Команда claude не найдена. Установите плагин из Claude Code:');
  console.log(`     /plugin marketplace add ${MARKETPLACE_GITHUB}`);
  console.log(`     /plugin install ${PLUGIN}`);

  console.log('\nГотово. Перезапустите Claude Code (приложение или терминал), чтобы он увидел новые настройки.');
  console.log('Проверка: попросите Claude «задай мне тестовый вопрос через AskUserQuestion» и отойдите от компьютера.');
  rl.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Ошибка: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { upsertEnvBlock };
