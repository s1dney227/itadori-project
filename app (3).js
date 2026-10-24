/**
 * Админский бот (admin-bot.js)
 * — принимает заявки на вывод от игрового бота (HTTP) и шлёт админу кнопки
 * — по кнопке вызывает игровой бот (/internal/withdraw-result) для списания/возврата
 * — админ-панель: депозиторы, поиск, вкладки истории, ТОП-10 по депозитам и выводам
 *
 * Переменные окружения (только через Render Environment Variables, никаких .env):
 *   ADMIN_BOT_TOKEN  — токен админского бота
 *   ADMIN_ID         — telegram_id администратора (кому шлём уведомления)
 *   GAME_API_URL     — URL игрового бота, напр. https://yyy.onrender.com
 *   ADMIN_SECRET     — тот же секрет, что у игрового бота
 *   PORT             — порт (Render задаёт сам)
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const store = require('./store');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const GAME_API_URL = (process.env.GAME_API_URL || '').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
const PORT = process.env.PORT || 3001;

if (!ADMIN_BOT_TOKEN || !ADMIN_ID) {
  console.error('❌ ADMIN_BOT_TOKEN или ADMIN_ID не заданы!');
  process.exit(1);
}

const adminBot = new Telegraf(ADMIN_BOT_TOKEN);
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (req.header('x-internal-secret') !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const fmtUser = (u) =>
  `${u.username ? '@' + u.username : u.firstName} (id: <code>${u.id}</code>)`;

/* ============================================================
   1. Приём заявки на вывод от игрового бота
   ============================================================ */
app.post('/internal/withdraw-request', auth, async (req, res) => {
  const r = req.body;
  const text =
    `💸 <b>Новая заявка на вывод #${r.id}</b>\n\n` +
    `Пользователь: ${r.username ? '@' + r.username : r.firstName}\n` +
    `ID: <code>${r.userId}</code>\n` +
    `Сумма: <b>${r.amount}★</b>\n` +
    `Дата: ${new Date(r.date).toLocaleString('ru-RU')}`;

  try {
    await adminBot.telegram.sendMessage(ADMIN_ID, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Выплатить', `wdoc:${r.id}:paid`),
          Markup.button.callback('❌ Отклонить', `wdoc:${r.id}:rejected`)
        ]
      ])
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('send to admin error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   2. Кнопки Выплатить / Отклонить → обратный запрос игровому боту
   ============================================================ */
adminBot.action(/^wdoc:(\d+):(paid|rejected)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = Number(ctx.match[1]);
  const status = ctx.match[2];
  const reqData = store.getWithdrawal(requestId);

  if (!reqData) {
    return ctx.editMessageText(`⚠️ Заявка #${requestId} не найдена (возможно, боты перезапускались).`);
  }
  if (reqData.status !== 'pending') {
    return ctx.editMessageText(
      `⚠️ Заявка #${requestId} уже обработана (статус: ${reqData.status}).`
    );
  }

  let ok = false;
  let err = '';
  if (GAME_API_URL) {
    try {
      const resp = await fetch(`${GAME_API_URL}/internal/withdraw-result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': ADMIN_SECRET },
        body: JSON.stringify({ requestId, status })
      });
      ok = resp.ok;
      if (!ok) err = `HTTP ${resp.status}`;
    } catch (e) {
      err = e.message;
    }
  } else {
    err = 'GAME_API_URL не задан';
  }

  if (ok) {
    // фиксируем статус и у себя, чтобы панель была консистентной
    store.setWithdrawalStatus(requestId, status);
    await ctx.editMessageText(
      (status === 'paid' ? '✅ Выплата по заявке #' : '❌ Заявка #') +
        `${requestId} — ${reqData.amount}★ — обработана.\nПользователь уведомлён.`
    );
  } else {
    await ctx.editMessageText(`⚠️ Не удалось обработать заявку #${requestId}: ${err}`);
  }
});

/* ============================================================
   3. Админ-панель
   ============================================================ */
adminBot.start(async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.reply('⛔ Доступ только для администратора.');
  }
  await ctx.reply('🛠 <b>Админ-панель itadori strz</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('👥 Депозиторы', 'panel:depositors')],
      [Markup.button.callback('🔍 Поиск', 'panel:search')],
      [Markup.button.callback('🏆 ТОП-10 депозиты', 'panel:topdep')],
      [Markup.button.callback('💸 ТОП-10 выводы', 'panel:topwd')],
      [Markup.button.callback('📊 Общая статистика', 'panel:stats')]
    ])
  });
});

adminBot.action(/^(panel|wview|whist|dep):(.+)$/, async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.answerCbQuery('⛔');
  await ctx.answerCbQuery();
  const [section, arg] = [ctx.match[1], ctx.match[2]];

  if (section === 'panel') {
    switch (arg) {
      case 'depositors': {
        const list = store.depositors();
        if (!list.length) return ctx.editMessageText('Пока никто не пополнял.');
        const rows = list
          .slice(0, 30)
          .map((u, i) => `${i + 1}. ${fmtUser(u)} — деп <b>${u.totalDeposit}★</b> / выв <b>${u.totalWithdraw}★</b> / баланс <b>${u.balance}★</b>`)
          .join('\n');
        return ctx.editMessageText(
          `👥 <b>Пользователи с депозитом &gt; 0</b>\n\n${rows}\n\n🔍 Для деталей: /user @username`,
          { parse_mode: 'HTML' }
        );
      }
      case 'search':
        return ctx.editMessageText('🔍 Отправь: <code>/user @username</code> или <code>/user 123456789</code>', { parse_mode: 'HTML' });
      case 'topdep': {
        const list = store.topBy('totalDeposit');
        if (!list.length) return ctx.editMessageText('Нет данных.');
        const rows = list.map((u, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${fmtUser(u)} — <b>${u.totalDeposit}★</b>`).join('\n');
        return ctx.editMessageText(`🏆 <b>ТОП-10 по депозитам</b>\n\n${rows}`, { parse_mode: 'HTML' });
      }
      case 'topwd': {
        const list = store.topBy('totalWithdraw');
        if (!list.length) return ctx.editMessageText('Нет данных.');
        const rows = list.map((u, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${fmtUser(u)} — <b>${u.totalWithdraw}★</b>`).join('\n');
        return ctx.editMessageText(`💸 <b>ТОП-10 по выводам</b>\n\n${rows}`, { parse_mode: 'HTML' });
      }
      case 'stats': {
        const all = [...store.users.values()];
        const totalDep = all.reduce((s, u) => s + u.totalDeposit, 0);
        const totalWd = all.reduce((s, u) => s + u.totalWithdraw, 0);
        const balances = all.reduce((s, u) => s + u.balance, 0);
        const pending = [...store.withdrawals.values()].filter((r) => r.status === 'pending').length;
        return ctx.editMessageText(
          `📊 <b>Статистика</b>\n\n` +
            `Пользователей: ${all.length}\n` +
            `Всего пополнено: ${totalDep}★\n` +
            `Всего выведено: ${totalWd}★\n` +
            `Балансов на счетах: ${balances}★\n` +
            `Заявок в ожидании: ${pending}`
        );
      }
    }
  }

  if (section === 'wview' || section === 'whist' || section === 'dep') {
    const u = store.users.get(Number(arg));
    if (!u) return ctx.editMessageText('Пользователь не найден.');
    if (section === 'wview') return renderUser(ctx, u);
    if (section === 'whist') {
      const rows = u.withdrawals.slice(-15).reverse()
        .map((r) => `#${r.id} — <b>${r.amount}★</b> — ${r.status} — ${new Date(r.date).toLocaleDateString('ru-RU')}`)
        .join('\n') || '—';
      return ctx.editMessageText(`💸 <b>История выводов</b> ${fmtUser(u)}\n\n${rows}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К профилю', `wview:${u.id}`)]])
      });
    }
    if (section === 'dep') {
      const rows = u.deposits.slice(-15).reverse()
        .map((d) => `<b>${d.amount}★</b> — ${new Date(d.date).toLocaleDateString('ru-RU')}`)
        .join('\n') || '—';
      return ctx.editMessageText(`💳 <b>История пополнений</b> ${fmtUser(u)}\n\n${rows}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К профилю', `wview:${u.id}`)]])
      });
    }
  }
});

function renderUser(ctx, u) {
  const p = store.publicUser(u);
  const lastSpins = p.spins.slice(0, 5)
    .map((s) => `• ${s.bet}★ → x${s.multiplier} (${s.win}★)`)
    .join('\n') || '—';
  return ctx.editMessageText(
    `👤 ${fmtUser(u)}\n\n` +
      `Баланс: <b>${p.balance}★</b>\n` +
      `Пополнено: <b>${p.totalDeposit}★</b>\n` +
      `Выведено: <b>${p.totalWithdraw}★</b>\n\n` +
      `<b>Последние спины:</b>\n${lastSpins}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Пополнения', `dep:${u.id}`), Markup.button.callback('💸 Выводы', `whist:${u.id}`)]
      ])
    }
  );
}

adminBot.command('user', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return;
  const q = ctx.message.text.split(' ').slice(1).join(' ');
  const u = store.findUser(q);
  if (!u) return ctx.reply('❌ Пользователь не найден. Учитывай: после рестарта Map очищается.');
  await renderUser(ctx, u);
});

/* ---------- Команда вручную отметить заявку оплаченной (если HTTP не дошёл) ---------- */
adminBot.command('paid', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  const reqData = store.getWithdrawal(id);
  if (!reqData) return ctx.reply('❌ Заявка не найдена.');
  store.setWithdrawalStatus(id, 'paid');
  ctx.reply(`✅ Заявка #${id} помечена как оплаченная (${reqData.amount}★).`);
});

/* ---------- Запуск ---------- */
adminBot.catch((err) => console.error('Admin bot error:', err));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🛠 Admin bot API listening on :${PORT}`);
  adminBot.launch().then(() => console.log('🛠 Admin bot started'));
});

process.once('SIGINT', () => adminBot.stop('SIGINT'));
process.once('SIGTERM', () => adminBot.stop('SIGTERM'));
