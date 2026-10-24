/**
 * Игровой бот (user-bot.js)
 * — принимает оплату Telegram Stars (invoice + successful_payment)
 * — HTTP API для Mini App: /api/user, /api/spin, /api/invoice, /api/withdraw, /api/history
 * — пересылает заявки на вывод админ-боту по HTTP
 *
 * Переменные окружения (Render Environment Variables, не .env):
 *   BOT_TOKEN           — токен игрового бота
 *   MINIAPP_URL         — URL Mini App на Vercel (для кнопки в /start)
 *   ADMIN_NOTIFY_URL    — URL админ-бота, напр. https://xxx.onrender.com
 *   ADMIN_SECRET        — общий секрет для внутренней связи между ботами
 *   ADMIN_FALLBACK_ID   — (необязательно) telegram_id админа для fallback-уведомлений
 *   PORT                — порт (Render задаёт сам)
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const store = require('./store');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINIAPP_URL = process.env.MINIAPP_URL || 'https://example.vercel.app';
const ADMIN_NOTIFY_URL = (process.env.ADMIN_NOTIFY_URL || '').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
const ADMIN_FALLBACK_ID = process.env.ADMIN_FALLBACK_ID || null;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан! Укажи переменную окружения.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const tgUser = (ctx) => ({
  username: ctx.from.username || '',
  first_name: ctx.from.first_name || ''
});

/* ---------- /start ---------- */
bot.start(async (ctx) => {
  store.getUser(ctx.from.id, tgUser(ctx));
  await ctx.reply(
    `🎰 <b>itadori strz</b>\n\n` +
      `Добро пожаловать! Открывай кейсы и выигрывай Stars.\n` +
      `Максимальный множитель — <b>x15</b> 🔥`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🎁 Открыть кейсы', MINIAPP_URL)],
        [Markup.button.callback('💰 Профиль', 'profile')]
      ])
    }
  );
});

/* ---------- Профиль в чате ---------- */
bot.action('profile', async (ctx) => {
  const u = store.getUser(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.reply(
    `👤 <b>Профиль</b>\n` +
      `Баланс: <b>${u.balance}★</b>\n` +
      `Пополнено: ${u.totalDeposit}★ · Выведено: ${u.totalWithdraw}★`,
    { parse_mode: 'HTML' }
  );
});

/* ---------- Оплата Stars из чата (кнопки) ---------- */
bot.action(/^buy_stars:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await sendInvoice(ctx.chat.id, amount);
});

async function sendInvoice(chatId, amount) {
  await bot.telegram.sendInvoice(chatId, {
    title: `Пополнение на ${amount} Stars`,
    description: `Зачисление ${amount}★ на баланс в itadori strz`,
    payload: `dep_${amount}_${chatId}`,
    currency: 'XTR',
    prices: [{ label: 'Пополнение', amount }],
    provider_token: '' // для XTR обязателен пустой provider_token
  });
}

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const p = ctx.message.successful_payment;
  const amount = p.total_amount;
  store.deposit(ctx.from.id, tgUser(ctx), amount, p.telegram_payment_charge_id);
  store.addFeed(`💳 @${ctx.from.username || ctx.from.first_name} пополнил <b>${amount}★</b>`);
  await ctx.reply(`✅ Зачислено <b>${amount}★</b>! Удачи в кейсах 🍀`, { parse_mode: 'HTML' });
});

/* ============================================================
   HTTP API для Mini App
   ============================================================ */
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/user', (req, res) => {
  const { id, username, firstName } = req.body;
  if (!id) return res.status(400).json({ error: 'no id' });
  const u = store.getUser(id, { username, first_name: firstName });
  res.json({ user: store.publicUser(u), feed: store.getFeed() });
});

/* Создание Stars-инвойса из Mini App */
app.post('/api/invoice', async (req, res) => {
  const { id, amount } = req.body;
  const amt = Number(amount);
  if (![50, 100, 250, 500, 1000].includes(amt)) {
    return res.status(400).json({ error: 'invalid amount' });
  }
  if (!id) return res.status(400).json({ error: 'no id' });
  try {
    // createInvoiceLink возвращает url, который открывается через tg.openInvoice
    const link = await bot.telegram.createInvoiceLink({
      title: `Пополнение на ${amt} Stars`,
      description: `Зачисление ${amt}★ на баланс в itadori strz`,
      payload: `dep_${amt}_${id}`,
      currency: 'XTR',
      prices: [{ label: 'Пополнение', amount: amt }],
      provider_token: ''
    });
    res.json({ invoiceLink: link });
  } catch (e) {
    console.error('invoice error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Спин: единая математика для всех кейсов ---------- */
const ODDS = [
  { m: 0.1, p: 50 }, // 50% → выигрыш = ceil(bet*0.1), для 10★ это 1★ (округление вверх!)
  { m: 0.5, p: 30 }, // 30%
  { m: 1,   p: 19 }, // 19%
  { m: 15,  p: 1  }  // 1% джекпот
];

function rollMultiplier() {
  const roll = Math.random() * 100;
  let acc = 0;
  for (const c of ODDS) {
    acc += c.p;
    if (roll < acc) return c.m;
  }
  return ODDS[ODDS.length - 1].m;
}

app.post('/api/spin', (req, res) => {
  const { id, username, firstName, bet, forced } = req.body;
  const betNum = Number(bet);
  if (![10, 25, 50, 100, 250].includes(betNum)) {
    return res.status(400).json({ error: 'invalid bet' });
  }
  const u = store.getUser(id, { username, first_name: firstName });
  if (u.balance < betNum) {
    return res.status(400).json({ error: 'insufficient', balance: u.balance });
  }

  const m = Number.isFinite(Number(forced)) && forced !== undefined && forced !== null
    ? Number(forced)
    : rollMultiplier();
  const win = Math.ceil(betNum * m); // округление вверх: 0.1x от 10★ = 1★
  const updated = store.spin(id, { username, first_name: firstName }, betNum, m, win);
  const label = m === 15 ? 'JACKPOT x15' : `x${m}`;
  store.addFeed(`🎰 @${updated.username || updated.firstName} — <b>${label}</b> → ${win}★`);

  res.json({ multiplier: m, win, balance: updated.balance, feed: store.getFeed() });
});

/* ---------- Заявка на вывод ---------- */
app.post('/api/withdraw', async (req, res) => {
  const { id, username, firstName, amount } = req.body;
  const amt = Math.ceil(Number(amount) / 100) * 100; // авто-округление вверх до 100★
  if (!Number.isFinite(amt) || amt < 100) {
    return res.status(400).json({ error: 'min 100, кратно 100' });
  }
  const u = store.getUser(id, { username, first_name: firstName });
  if (u.balance < amt) {
    return res.status(400).json({ error: 'insufficient', balance: u.balance });
  }
  const reqData = store.createWithdrawal(id, amt);

  let notified = false;
  if (ADMIN_NOTIFY_URL) {
    try {
      const r = await fetch(`${ADMIN_NOTIFY_URL}/internal/withdraw-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': ADMIN_SECRET },
        body: JSON.stringify(reqData)
      });
      notified = r.ok;
    } catch (e) {
      console.error('notify error:', e.message);
    }
  }
  if (!notified && ADMIN_FALLBACK_ID) {
    try {
      await bot.telegram.sendMessage(
        ADMIN_FALLBACK_ID,
        `💸 Новая заявка #${reqData.id}\n@${reqData.username || reqData.userId} — ${reqData.amount}★`
      );
      notified = true;
    } catch (e) {
      console.error('fallback notify error:', e.message);
    }
  }

  res.json({ request: reqData, balance: store.getUser(id).balance, notified });
});

app.get('/api/history/:id', (req, res) => {
  const u = store.users.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({ user: store.publicUser(u) });
});

/* ---------- Админ-бот сообщает результат по заявке ---------- */
app.post('/internal/withdraw-result', (req, res) => {
  const secret = req.header('x-internal-secret');
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const { requestId, status } = req.body; // 'paid' | 'rejected'
  const done = store.setWithdrawalStatus(requestId, status);
  if (!done) return res.status(404).json({ error: 'request not found' });

  if (status === 'paid') {
    bot.telegram
      .sendMessage(
        done.userId,
        `✅ Заявка #${done.id} на <b>${done.amount}★</b> выполнена! Проверь подарок в Telegram.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    store.addFeed(`💸 @${done.username || done.firstName} вывел <b>${done.amount}★</b>`);
  } else {
    bot.telegram
      .sendMessage(
        done.userId,
        `❌ Заявка #${done.id} отклонена. ${done.amount}★ возвращены на баланс.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
  res.json({ ok: true, status: done.status });
});

/* ---------- Запуск ---------- */
bot.catch((err) => console.error('Bot error:', err));

bot.telegram.setMyCommands([{ command: 'start', description: 'Открыть игру' }]);

app.listen(PORT, () => {
  console.log(`🎮 Game bot API listening on :${PORT}`);
  bot.launch().then(() => console.log('🎮 Bot started'));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
