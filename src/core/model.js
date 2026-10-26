// Расчёты портфеля. Чистые функции: на вход строки CSV (значения — текст), на выход числа.
// Формулы перенесены из прежнего Excel/дашборда, чтобы цифры совпадали.

export const FILES = {
  settings: 'settings.csv',
  operations: 'operations.csv',
  securities: 'securities.csv',
  target_classes: 'target_classes.csv',
  target_issues: 'target_issues.csv',
  history: 'history.csv',
};

export const OP_TYPES = [
  'Пополнение', 'Вывод', 'Покупка', 'Продажа', 'Погашение', 'Амортизация',
  'Купон', 'Купон на карту', 'Реинвест с карты', 'Дивиденд', 'Дивиденд на карту',
  'Прочий доход', 'Возврат налога', 'Налог', 'Комиссия',
];

const n = (x) => Number(x) || 0;
const SALES = ['Продажа', 'Погашение', 'Амортизация'];

export function settingsMap(settings) {
  return Object.fromEntries(settings.map((s) => [s.key, s.value]));
}

// Денежный поток по счёту, изменение количества, доход, ушедший на карту.
export function flows(ops) {
  return ops.map((o, i) => {
    const t = o.type, F = n(o.amount), G = n(o.aci), H = n(o.fee), I = n(o.tax);
    let flow = 0;
    if (t === 'Пополнение' || t === 'Реинвест с карты') flow = F;
    else if (t === 'Вывод') flow = -F;
    else if (t === 'Покупка') flow = -(F + G + H);
    else if (SALES.includes(t)) flow = F + G - H - I;
    else if (['Купон', 'Дивиденд', 'Прочий доход', 'Возврат налога'].includes(t)) flow = F - H - I;
    else if (t === 'Комиссия') flow = -(F + H);
    else if (t === 'Налог') flow = -(F + I);
    const dqty = t === 'Покупка' ? n(o.qty) : (t === 'Продажа' || t === 'Погашение') ? -n(o.qty) : 0;
    const to_card = (t === 'Купон на карту' || t === 'Дивиденд на карту') ? F - H - I : 0;
    return {
      n: i + 1, date: o.date, type: t, ticker: o.ticker, name: o.name,
      qty: o.qty === '' ? null : n(o.qty), amount: F, aci: G, fee: H, tax: I,
      price_per: n(o.qty) > 0 && F > 0 ? F / n(o.qty) : null,
      flow, dqty, to_card,
      cost_sold: o.cost_sold === '' ? null : n(o.cost_sold), comment: o.comment,
    };
  });
}

// Позиции: количество, стоимость, вложено, получено, купоны, результат, доля.
export function positions(fl, securities) {
  const cash = fl.reduce((a, r) => a + r.flow, 0);
  const rows = securities.map((s) => {
    const mine = fl.filter((r) => r.ticker === s.ticker);
    const of = (types, key) => mine.filter((r) => types.includes(r.type)).reduce((a, r) => a + r[key], 0);
    const qty = mine.reduce((a, r) => a + r.dqty, 0);
    const value = qty * (n(s.price) + n(s.aci));
    const invested = -of(['Покупка'], 'flow');
    const received = of(SALES, 'flow');
    const income = of(['Купон', 'Дивиденд'], 'flow') + mine.reduce((a, r) => a + r.to_card, 0);
    const result = value + mine.reduce((a, r) => a + r.flow + r.to_card, 0);
    return {
      ticker: s.ticker, name: s.name, class: s.class, isin: s.isin,
      qty, price: n(s.price), aci: n(s.aci), value, invested, received, income,
      result, result_pct: invested === 0 ? 0 : result / invested, coupon_year: n(s.coupon_year),
    };
  });
  const capital = cash + rows.reduce((a, r) => a + r.value, 0);
  return rows.map((r) => ({ ...r, share: capital === 0 ? 0 : r.value / capital }));
}

// Ключевые цифры: вложения, деньги на счёте, капитал, прирост.
export function capital(fl, pos) {
  const byType = (...types) => fl.filter((r) => types.includes(r.type)).reduce((a, r) => a + r.amount, 0);
  const deposits = byType('Пополнение');
  const withdrawals = byType('Вывод');
  const net = deposits - withdrawals;
  const cash = fl.reduce((a, r) => a + r.flow, 0);
  const securities = pos.reduce((a, r) => a + r.value, 0);
  const cap = cash + securities;
  const card_income = fl.reduce((a, r) => a + r.to_card, 0);
  const reinvest = byType('Реинвест с карты');
  const growth = cap + card_income - reinvest - net;
  return {
    deposits, withdrawals, net, cash, securities, capital: cap, card_income, reinvest,
    growth, growth_pct: net === 0 ? 0 : growth / net,
    coupons: byType('Купон', 'Купон на карту'),
    dividends: byType('Дивиденд', 'Дивиденд на карту'),
    taxes: fl.reduce((a, r) => a + r.tax, 0) + byType('Налог') - byType('Возврат налога'),
    fees: fl.reduce((a, r) => a + r.fee, 0) + byType('Комиссия'),
  };
}

// Структура по классам активов.
export function byClass(pos, cap, classes) {
  return classes.map((c) => {
    const target = n(c.target);
    const value = c.class === 'Деньги' ? cap.cash
      : pos.filter((p) => p.class === c.class).reduce((a, p) => a + p.value, 0);
    const share = cap.capital === 0 ? 0 : value / cap.capital;
    return { class: c.class, target, value, share, deviation: share - target, to_buy: target * cap.capital - value };
  });
}

// Структура по выпускам: база = капитал × целевая доля облигаций.
export function byIssue(pos, cap, classes, issues, settings) {
  const fee = n(settings.fee_rate);
  const bonds = n((classes.find((c) => c.class === 'Облигации') || {}).target);
  const base = cap.capital * bonds;
  const find = (t) => pos.find((p) => p.ticker === t);
  return issues.map((s) => {
    const p = find(s.ticker), p2 = s.ticker2 ? find(s.ticker2) : null;
    const target = n(s.target);
    const goal = target * base;
    const value = (p ? p.value : 0) + (p2 ? p2.value : 0);
    const share = base === 0 ? 0 : value / base;
    const to_buy = goal - value;
    const unit = p ? p.price + p.aci : 0;
    return {
      issue: s.issue, ticker: s.ticker, group: s.group, decision: s.decision, target, goal, value, share,
      deviation: share - target, to_buy, unit_price: unit,
      buy_qty: unit === 0 || to_buy <= 0 ? 0 : Math.floor(to_buy / (unit * (1 + fee))),
      coupon_year: p ? p.coupon_year : 0,
      coupon_yield: p && p.price ? p.coupon_year / p.price : 0,
    };
  });
}

// Структура по группам выпусков (ОФЗ / AAA).
export function byGroup(iss, cap, classes) {
  const bonds = n((classes.find((c) => c.class === 'Облигации') || {}).target);
  const base = cap.capital * bonds;
  return [...new Set(iss.map((r) => r.group))].map((g) => {
    const rs = iss.filter((r) => r.group === g);
    const s = (k) => rs.reduce((a, r) => a + r[k], 0);
    const share = base === 0 ? 0 : s('value') / base;
    return { group: g, target: s('target'), goal: s('goal'), value: s('value'), share, deviation: share - s('target'), to_buy: s('goal') - s('value') };
  });
}

// Цель: какая сумма нужна для целевого дохода, прогресс, купоны в месяц на руки.
export function goal(pos, cap, iss, settings) {
  const tax = n(settings.tax_rate);
  const monthly = n(settings.target_monthly_income);
  const yld = iss.reduce((a, r) => a + r.target * r.coupon_yield, 0);
  const target_sum = yld === 0 ? null : monthly * 12 / (1 - tax) / yld;
  const income_year = pos.reduce((a, p) => a + p.qty * p.coupon_year, 0);
  const income_month = income_year * (1 - tax) / 12;
  // Текущая купонная доходность: купоны в год / стоимость бумаг без НКД (только бумаги с ценой и остатком).
  const priced = pos.filter((p) => p.qty > 0 && p.price > 0);
  const cost = priced.reduce((a, p) => a + p.qty * p.price, 0);
  const current_yield = cost === 0 ? null : priced.reduce((a, p) => a + p.qty * p.coupon_year, 0) / cost;
  return {
    target_monthly_income: monthly, target_yield: yld, target_sum,
    progress: target_sum ? cap.capital / target_sum : null,
    income_year, income_month, income_share: monthly === 0 ? null : income_month / monthly,
    current_yield, current_yield_net: current_yield === null ? null : current_yield * (1 - tax),
  };
}

// НДФЛ по годам (оценка).
export function taxes(fl, settings) {
  const rate = n(settings.tax_rate) || 0.13;
  const years = fl.map((r) => Number(String(r.date).slice(0, 4))).filter(Boolean);
  if (!years.length) return [];
  const now = Number(String(settings.prices_date || '').slice(0, 4)) || Math.max(...years);
  const from = Math.min(...years, now), to = Math.max(...years, now);
  const out = [];
  for (let y = from; y <= to; y++) {
    const rs = fl.filter((r) => String(r.date).startsWith(String(y)));
    const s = (types, k) => rs.filter((r) => types.includes(r.type)).reduce((a, r) => a + (r[k] || 0), 0);
    const coupons = s(['Купон', 'Купон на карту'], 'amount');
    const aci_paid = s(['Покупка'], 'aci');
    const aci_got = s(SALES, 'aci');
    const trades = s(SALES, 'amount') - s(SALES, 'fee') - s(SALES, 'cost_sold');
    const base = coupons - aci_paid + aci_got + trades;
    const tax_main = base <= 0 ? 0 : Math.min(base, 2400000) * rate + Math.max(0, base - 2400000) * 0.15;
    const dividends = s(['Дивиденд', 'Дивиденд на карту'], 'amount');
    const tax_div = dividends * 0.13;
    const withheld = rs.reduce((a, r) => a + r.tax, 0) + s(['Налог'], 'amount') - s(['Возврат налога'], 'amount');
    out.push({
      year: String(y), coupons, aci_paid: -aci_paid, aci_got, trades, base, tax_main,
      dividends, tax_div, total: tax_main + tax_div, withheld, due: tax_main + tax_div - withheld,
    });
  }
  return out;
}

// Что проверить: НКД обнулился без внесённого купона, суммы целевых долей.
export function checks(fl, pos, classes, issues) {
  const out = [];
  for (const p of pos.filter((x) => x.qty > 0)) {
    const buys = fl.filter((r) => r.ticker === p.ticker && r.type === 'Покупка');
    if (!buys.length) continue;
    const last = buys[buys.length - 1];
    const coupon = fl.some((r) => r.ticker === p.ticker && /Купон/.test(r.type) && r.date >= last.date);
    const aciBuy = last.qty ? last.aci / last.qty : 0;
    if (!coupon && p.aci < aciBuy - 0.005) {
      out.push({
        kind: 'Ждём купон', item: p.name,
        detail: `НКД ${p.aci.toFixed(2).replace('.', ',')} ₽ против ${aciBuy.toFixed(2).replace('.', ',')} ₽ при покупке ${last.date.split('-').reverse().join('.')} — купон выплачен или скоро придёт, внести, когда поступит`,
      });
    }
  }
  const c = classes.reduce((a, r) => a + n(r.target), 0);
  if (Math.abs(c - 1) > 1e-9) out.push({ kind: 'Цель', item: 'Доли классов', detail: `сумма ${(c * 100).toFixed(1)}%, нужно 100%` });
  const i = issues.reduce((a, r) => a + n(r.target), 0);
  if (Math.abs(i - 1) > 1e-9) out.push({ kind: 'Цель', item: 'Доли выпусков', detail: `сумма ${(i * 100).toFixed(1)}%, нужно 100%` });
  for (const r of fl) {
    if (!OP_TYPES.includes(r.type)) out.push({ kind: 'Данные', item: `Операция №${r.n}`, detail: `неизвестный тип «${r.type}»` });
  }
  return out;
}

// Всё сразу: data — { settings, operations, securities, target_classes, target_issues, history } (массивы строк CSV).
export function analyze(data) {
  const settings = settingsMap(data.settings);
  const fl = flows(data.operations);
  const pos = positions(fl, data.securities);
  const cap = capital(fl, pos);
  const iss = byIssue(pos, cap, data.target_classes, data.target_issues, settings);
  return {
    settings,
    flows: fl,
    positions: pos,
    capital: cap,
    classes: byClass(pos, cap, data.target_classes),
    issues: iss,
    groups: byGroup(iss, cap, data.target_classes),
    goal: goal(pos, cap, iss, settings),
    taxes: taxes(fl, settings),
    checks: checks(fl, pos, data.target_classes, data.target_issues),
    history: data.history.map((h) => ({ date: h.date, net_invested: n(h.net_invested), capital: n(h.capital), growth: n(h.growth) })),
  };
}

// Строка для history.csv на дату цен.
export function snapshot(result) {
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    date: result.settings.prices_date,
    net_invested: r2(result.capital.net),
    capital: r2(result.capital.capital),
    growth: r2(result.capital.growth),
  };
}
