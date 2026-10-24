/**
 * Временное хранилище данных (Map) — бесплатная альтернатива базе данных.
 * ВАЖНО: данные живут в оперативной памяти и сбрасываются при рестарте сервиса.
 * Если позже захочешь постоянство — замени этот модуль на Supabase/SQLite,
 * интерфейс (названия методов) менять не придётся.
 */
class Store {
  constructor() {
    this.users = new Map();        // telegram_id -> объект пользователя
    this.withdrawals = new Map();  // id заявки -> заявка на вывод
    this.feed = [];                // лента последних операций для тикера
    this.requestSeq = 1;           // счётчик id заявок на вывод
  }

  /** Получить пользователя (создать при первом обращении) */
  getUser(id, info = {}) {
    let u = this.users.get(Number(id));
    if (!u) {
      u = {
        id: Number(id),
        username: '',
        firstName: 'Игрок',
        balance: 0,
        totalDeposit: 0,   // всего пополнено
        totalWithdraw: 0,  // всего выведено (одобрено)
        deposits: [],      // { amount, chargeId, date }
        withdrawals: [],   // { id, amount, status: pending|paid|rejected, date }
        spins: []          // { bet, multiplier, win, date }
      };
      this.users.set(u.id, u);
    }
    if (info.username) u.username = info.username;
    if (info.first_name) u.firstName = info.first_name;
    return u;
  }

  /** Пополнение (успешный платёж Stars) */
  deposit(id, info, amount, chargeId) {
    const u = this.getUser(id, info);
    u.balance += amount;
    u.totalDeposit += amount;
    u.deposits.push({ amount, chargeId: chargeId || null, date: Date.now() });
    return u;
  }

  /** Спин: списываем ставку, начисляем выигрыш */
  spin(id, info, bet, multiplier, win) {
    const u = this.getUser(id, info);
    u.balance -= bet;
    u.balance += win;
    u.spins.push({ bet, multiplier, win, date: Date.now() });
    if (u.spins.length > 100) u.spins.shift();
    return u;
  }

  /** Создать заявку на вывод. Баланс списывается сразу (холд),
   *  при отклонении заявки возвращается обратно. */
  createWithdrawal(id, amount) {
    const u = this.getUser(id);
    const reqId = this.requestSeq++;
    u.balance -= amount;
    const req = {
      id: reqId,
      userId: u.id,
      username: u.username,
      firstName: u.firstName,
      amount,
      status: 'pending',
      date: Date.now()
    };
    u.withdrawals.push(req);
    this.withdrawals.set(reqId, req);
    return req;
  }

  getWithdrawal(id) {
    return this.withdrawals.get(Number(id));
  }

  /** Смена статуса заявки: paid — зачисляем в totalWithdraw, rejected — возврат баланса */
  setWithdrawalStatus(id, status) {
    const req = this.withdrawals.get(Number(id));
    if (!req) return null;
    if (req.status !== 'pending') return req; // уже обработана
    req.status = status;
    const u = this.users.get(req.userId);
    if (u) {
      if (status === 'paid') u.totalWithdraw += req.amount;
      if (status === 'rejected') u.balance += req.amount;
    }
    return req;
  }

  /** Последний charge_id пополнения — нужен для refundStarPayment */
  lastChargeId(userId) {
    const u = this.users.get(Number(userId));
    if (!u) return null;
    for (let i = u.deposits.length - 1; i >= 0; i--) {
      if (u.deposits[i].chargeId) return u.deposits[i].chargeId;
    }
    return null;
  }

  /** Добавить запись в тикер Mini App */
  addFeed(text) {
    this.feed.unshift(text);
    if (this.feed.length > 20) this.feed.pop();
  }

  getFeed() {
    return this.feed.slice(0, 10);
  }

  /** ТОП-10 по полю (totalDeposit / totalWithdraw) */
  topBy(field) {
    return [...this.users.values()]
      .filter((u) => u[field] > 0)
      .sort((a, b) => b[field] - a[field])
      .slice(0, 10);
  }

  /** Все пользователи с депозитом > 0 (для админ-панели) */
  depositors() {
    return [...this.users.values()]
      .filter((u) => u.totalDeposit > 0)
      .sort((a, b) => b.totalDeposit - a.totalDeposit);
  }

  /** Поиск по @username или telegram_id */
  findUser(query) {
    const q = String(query).trim().replace('@', '').toLowerCase();
    if (!q) return null;
    if (/^\d+$/.test(q)) return this.users.get(Number(q)) || null;
    for (const u of this.users.values()) {
      if (u.username && u.username.toLowerCase() === q) return u;
    }
    return null;
  }

  /** Публичное представление пользователя для API/админки */
  publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      firstName: u.firstName,
      balance: u.balance,
      totalDeposit: u.totalDeposit,
      totalWithdraw: u.totalWithdraw,
      deposits: u.deposits.slice(-20).reverse(),
      withdrawals: u.withdrawals.slice(-20).reverse(),
      spins: u.spins.slice(-10).reverse()
    };
  }
}

module.exports = new Store();
