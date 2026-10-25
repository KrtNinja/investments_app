import { GitHubStore } from '../core/github.js';
import { loadRegistry, loadPortfolio, rowsOf, savePortfolio, setSetting, upsertHistory } from '../core/portfolio.js';
import { analyze, snapshot, OP_TYPES } from '../core/model.js';
import { refreshPrices } from '../core/moex.js';
import { historyChart, targetBars } from './charts.js';

const $ = (id) => document.getElementById(id);
const CONN_KEY = 'invest.connection';
const LAST_KEY = 'invest.portfolio';

const state = { store: null, registry: [], pf: null, result: null };

// ---------- форматирование ----------
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const F = {
  rub: (x) => x === null || x === undefined || Number.isNaN(x) ? '—' : nf2.format(x),
  rub0: (x) => x === null || x === undefined ? '—' : nf0.format(x) + ' ₽',
  pct: (x) => x === null || x === undefined ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%',
  pp: (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1).replace('.', ',') + ' п.п.',
  int: (x) => x === null || x === undefined ? '—' : nf0.format(x),
  date: (d) => d ? d.split('-').reverse().join('.') : '—',
  text: (x) => x ?? '',
};
const sign = (x) => (x > 0.005 ? 'pos' : x < -0.005 ? 'neg' : '');

// ---------- маленький конструктор DOM (только textContent — данные считаем недоверенными) ----------
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v; // через CSSOM: inline-стили запрещены CSP
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

function table(cols, rows, { foot, action } = {}) {
  const thead = h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.l ? 'l' : '' }, c.label)), action ? h('th', {}) : null));
  const tbody = h('tbody', {}, rows.map((r) => h('tr', {},
    cols.map((c) => {
      const v = r[c.key];
      return h('td', { class: [c.l ? 'l' : '', c.wrap ? 'wrap' : '', c.signed ? sign(v) : ''].join(' ').trim() || null },
        (c.fmt || F.text)(v, r));
    }),
    action ? h('td', {}, action(r)) : null)));
  const tfoot = foot ? h('tfoot', {}, h('tr', {}, cols.map((c) => h('td', { class: c.l ? 'l' : '' }, foot[c.key] === undefined ? '' : (c.fmt || F.text)(foot[c.key]))), action ? h('td') : null)) : null;
  return h('div', { class: 'table-wrap' }, h('table', {}, thead, tbody, tfoot));
}

function status(text, kind = '') {
  const s = $('status');
  s.hidden = !text;
  s.className = 'status ' + kind;
  s.textContent = text || '';
}

// ---------- подключение ----------
function readConn() {
  try { return JSON.parse(localStorage.getItem(CONN_KEY) || sessionStorage.getItem(CONN_KEY) || 'null'); } catch { return null; }
}
function saveConn(conn, remember) {
  try {
    localStorage.removeItem(CONN_KEY); sessionStorage.removeItem(CONN_KEY);
    (remember ? localStorage : sessionStorage).setItem(CONN_KEY, JSON.stringify(conn));
  } catch { /* хранилище недоступно — работаем до перезагрузки */ }
}

function showSetup(error = '') {
  $('setup').hidden = false;
  $('actions').hidden = true;
  $('portfolio').hidden = true;
  $('view').replaceChildren();
  $('source').textContent = '';
  $('setup-error').textContent = error;
  const c = readConn();
  if (c) for (const k of ['owner', 'repo', 'branch']) $('setup-form').elements[k].value = c[k] || '';
}

async function connect(conn) {
  state.store = new GitHubStore(conn);
  await state.store.refresh();
  state.registry = await loadRegistry(state.store);
  if (!state.registry.length) throw new Error('В portfolios.csv нет ни одного портфеля.');
  const sel = $('portfolio');
  sel.replaceChildren(...state.registry.map((p) => h('option', { value: p.id }, p.name || p.id)));
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* нет хранилища */ }
  sel.value = state.registry.some((p) => p.id === last) ? last : state.registry[0].id;
  sel.hidden = false;
  $('setup').hidden = true;
  $('actions').hidden = false;
  $('source').textContent = state.store.label;
  await openPortfolio(sel.value);
}

async function openPortfolio(id) {
  status('Загружаю данные…');
  state.pf = await loadPortfolio(state.store, id);
  state.result = analyze(rowsOf(state.pf));
  try { localStorage.setItem(LAST_KEY, id); } catch { /* нет хранилища */ }
  render();
  status('');
}

async function reload() {
  await state.store.refresh();
  state.registry = await loadRegistry(state.store);
  await openPortfolio($('portfolio').value);
}

// ---------- запись ----------
async function save(changed, message) {
  const res = await savePortfolio(state.store, state.pf, changed, message);
  state.result = analyze(rowsOf(state.pf));
  render();
  return res;
}

async function guarded(btn, work) {
  btn.disabled = true;
  try { await work(); } catch (e) { status(e.message, 'err'); } finally { btn.disabled = false; }
}

// ---------- отрисовка ----------
function render() {
  const r = state.result, c = r.capital, g = r.goal, s = r.settings;
  const name = (state.registry.find((p) => p.id === state.pf.id) || {}).name || state.pf.id;
  const view = $('view');
  const width = Math.min(1088, view.clientWidth || 1088);
  const share = g.income_share ?? 0;

  const cover = h('section', { class: 'cover', id: 'svodka', 'aria-label': 'Покрытие цели купонами' },
    h('p', { class: 'cover-line' },
      g.target_monthly_income
        ? ['Купоны приносят ', h('b', {}, F.rub0(g.income_month)), ` в месяц на руки — ${F.pct(share)} от цели в ${F.rub0(g.target_monthly_income)}`]
        : ['Купоны приносят ', h('b', {}, F.rub0(g.income_month)), ' в месяц на руки']),
    g.target_monthly_income ? h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(share * 100) },
      h('span', { style: `width:${Math.min(100, share * 100).toFixed(2)}%` })) : null,
    g.target_monthly_income ? h('div', { class: 'meter-scale' }, h('span', {}, '0'), h('span', {}, F.rub0(g.target_monthly_income))) : null);

  const figures = h('dl', { class: 'figures' },
    fig('Капитал', F.rub0(c.capital), `на ${F.date(s.prices_date)}`),
    fig('Чистые вложения', F.rub0(c.net)),
    fig('Прирост', h('span', { class: sign(c.growth) }, F.rub0(c.growth)), F.pct(c.growth_pct)),
    fig('Свободные деньги', F.rub0(c.cash)),
    g.target_sum ? fig('Нужно капитала для цели', F.rub0(g.target_sum), `пройдено ${F.pct(g.progress)}`) : null);

  const toc = h('nav', { class: 'toc', 'aria-label': 'Разделы' },
    [['bumagi', 'Бумаги'], ['struktura', 'Структура'], ['nalogi', 'Налоги'], ['operacii', 'Операции'], ['cel', 'Цель и стратегия']]
      .map(([id, t]) => h('a', { href: '#' + id }, t)));

  const checks = r.checks.length
    ? h('ul', { class: 'checks', 'aria-label': 'Что проверить' }, r.checks.map((ch) => h('li', {}, h('b', {}, `${ch.kind}: ${ch.item}`), ' — ', ch.detail)))
    : null;

  const hist = h('section', {},
    h('h3', {}, 'История капитала'),
    r.history.length > 1
      ? historyChart(r.history, width)
      : h('p', { class: 'muted' }, r.history.length
        ? `Пока один снимок: ${F.date(r.history[0].date)}, капитал ${F.rub0(r.history[0].capital)}. График появится после следующей актуализации цен.`
        : 'Снимков ещё нет — они добавляются при актуализации цен.'),
    r.history.length > 1 && h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--coupon)' }), 'Капитал'), h('span', {}, h('i', { style: 'background:var(--ink-2)' }), 'Чистые вложения')));

  const held = r.positions.filter((p) => p.qty);
  const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
  const posTable = table([
    { key: 'ticker', label: 'Тикер', l: true },
    { key: 'name', label: 'Название', l: true },
    { key: 'qty', label: 'Кол-во', fmt: F.int },
    { key: 'price', label: 'Цена', fmt: F.rub },
    { key: 'aci', label: 'НКД', fmt: F.rub },
    { key: 'value', label: 'Стоимость', fmt: F.rub },
    { key: 'invested', label: 'Вложено', fmt: F.rub },
    { key: 'income', label: 'Купоны', fmt: F.rub },
    { key: 'result', label: 'Результат', fmt: F.rub, signed: true },
    { key: 'result_pct', label: 'Результат, %', fmt: F.pct, signed: true },
    { key: 'share', label: 'Доля', fmt: F.pct },
    { key: 'coupon_year', label: 'Купон в год', fmt: F.rub },
  ], held, { foot: { ticker: 'Итого', value: sum(held, 'value'), invested: sum(held, 'invested'), income: sum(held, 'income'), result: sum(held, 'result'), share: sum(held, 'share') } });

  const issBars = targetBars(r.issues.map((x) => ({ label: x.issue, share: x.share, target: x.target })), width);
  const issTable = table([
    { key: 'issue', label: 'Выпуск', l: true },
    { key: 'decision', label: 'Решение', l: true, wrap: true },
    { key: 'target', label: 'Цель', fmt: F.pct },
    { key: 'share', label: 'Сейчас', fmt: F.pct },
    { key: 'deviation', label: 'Отклонение', fmt: F.pp },
    { key: 'to_buy', label: 'Докупить (+) / лишнее (−), ₽', fmt: F.rub },
    { key: 'unit_price', label: 'Цена с НКД', fmt: F.rub },
    { key: 'buy_qty', label: 'Докупить, шт', fmt: F.int },
    { key: 'coupon_yield', label: 'Купон к цене', fmt: F.pct },
  ], r.issues);

  const opsRows = r.flows.slice().reverse();
  const opsTable = table([
    { key: 'n', label: '№', l: true },
    { key: 'date', label: 'Дата', l: true, fmt: F.date },
    { key: 'type', label: 'Тип', l: true },
    { key: 'name', label: 'Бумага', l: true },
    { key: 'qty', label: 'Кол-во', fmt: F.int },
    { key: 'amount', label: 'Сумма', fmt: F.rub },
    { key: 'aci', label: 'НКД', fmt: F.rub },
    { key: 'fee', label: 'Комиссия', fmt: F.rub },
    { key: 'tax', label: 'Налог', fmt: F.rub },
    { key: 'flow', label: 'Поток по счёту', fmt: F.rub, signed: true },
    { key: 'comment', label: 'Комментарий', l: true, wrap: true },
  ], opsRows, { action: (row) => h('button', { type: 'button', class: 'link', onclick: (e) => deleteOp(row.n, e.currentTarget) }, 'Удалить') });

  const strategy = h('dl', { class: 'kv' },
    [['goal', 'Цель'], ['horizon', 'Срок'], ['monthly_topup', 'Пополнения в месяц'], ['strategy', 'Стратегия'],
      ['rebalance_rules', 'Ребалансировка'], ['coupons_policy', 'Купоны'], ['constraints', 'Ограничения'], ['max_drawdown', 'Допустимая просадка']]
      .map(([k, t]) => [h('dt', {}, t), h('dd', { class: 'prose' }, k === 'monthly_topup' && s[k] ? `от ${F.rub0(Number(s[k]))}` : (s[k] || '—'))]));

  view.replaceChildren(
    h('h1', { class: 'muted', style: 'font-size:1rem;font-family:var(--sans);font-weight:400' }, `${name} · ${s.broker || ''} ${s.tariff ? '· ' + s.tariff : ''}`),
    cover, figures, toc, checks, hist,
    h('h2', { id: 'bumagi' }, 'Бумаги'), posTable,
    h('h2', { id: 'struktura' }, 'Структура'),
    h('h3', {}, 'Доли выпусков: полоса — сейчас, черта — цель'), issBars,
    h('h3', {}, 'Ребалансировка по выпускам'), issTable,
    h('div', { class: 'cols' },
      h('div', {}, h('h3', {}, 'По группам'), table([
        { key: 'group', label: 'Группа', l: true }, { key: 'target', label: 'Цель', fmt: F.pct },
        { key: 'share', label: 'Сейчас', fmt: F.pct }, { key: 'to_buy', label: 'Докупить, ₽', fmt: F.rub },
      ], r.groups)),
      h('div', {}, h('h3', {}, 'По классам активов'), table([
        { key: 'class', label: 'Класс', l: true }, { key: 'target', label: 'Цель', fmt: F.pct },
        { key: 'share', label: 'Сейчас', fmt: F.pct }, { key: 'to_buy', label: 'Докупить (+) / лишнее (−), ₽', fmt: F.rub },
      ], r.classes.filter((x) => x.target || x.value)))),
    h('h2', { id: 'nalogi' }, 'НДФЛ по годам (оценка)'),
    table([
      { key: 'year', label: 'Год', l: true }, { key: 'coupons', label: 'Купоны', fmt: F.rub },
      { key: 'aci_paid', label: '− НКД уплаченный', fmt: F.rub }, { key: 'aci_got', label: '+ НКД полученный', fmt: F.rub },
      { key: 'trades', label: '+ Сделки', fmt: F.rub }, { key: 'base', label: 'База', fmt: F.rub },
      { key: 'total', label: 'Налог', fmt: F.rub }, { key: 'withheld', label: 'Удержано', fmt: F.rub },
      { key: 'due', label: 'Доплатить (+) / вернуть (−)', fmt: F.rub, signed: true },
    ], r.taxes),
    h('h2', { id: 'operacii' }, 'Операции'),
    h('p', { class: 'muted' }, 'Каждое изменение — отдельный коммит в репозитории, его можно откатить в истории GitHub.'),
    opsTable,
    h('h2', { id: 'cel' }, 'Цель и стратегия'), strategy,
  );
}

function fig(label, value, note) {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value, note ? h('small', {}, note) : null));
}

// ---------- операции ----------
async function deleteOp(n, btn) {
  const op = state.pf.tables.operations.rows[n - 1];
  if (!op) return;
  const what = `${F.date(op.date)} ${op.type} ${op.name || ''} на ${op.amount} ₽`;
  if (!confirm(`Удалить операцию №${n}: ${what}?\nУдаление попадёт в историю репозитория, вернуть можно откатом коммита.`)) return;
  await guarded(btn, async () => {
    state.pf.tables.operations.rows.splice(n - 1, 1);
    await save(['operations'], `${state.pf.id}: удалена операция ${what}`);
    status('Удалено.', 'ok');
  });
}

function openOpDialog() {
  const f = $('op-form');
  f.reset();
  $('op-error').textContent = '';
  $('new-sec').hidden = true;
  f.elements.date.value = new Date().toISOString().slice(0, 10);
  f.elements.type.replaceChildren(...OP_TYPES.map((t) => h('option', {}, t)));
  $('tickers').replaceChildren(...state.pf.tables.securities.rows.map((sx) => h('option', { value: sx.ticker }, sx.name)));
  $('op-dialog').showModal();
}

const num = (v) => {
  const t = String(v || '').replace(/\s/g, '').replace(',', '.');
  if (t === '') return '';
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`«${v}» — не число`);
  return t;
};

async function submitOp(e) {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const err = $('op-error');
  err.textContent = '';
  try {
    const ticker = f.ticker.value.trim();
    const secs = state.pf.tables.securities.rows;
    let sec = secs.find((x) => x.ticker === ticker);
    const changed = ['operations'];
    if (ticker && !sec) {
      if (!f.sec_name.value.trim()) { $('new-sec').hidden = false; throw new Error('Бумаги нет в справочнике: заполните название и ISIN.'); }
      sec = { ticker, name: f.sec_name.value.trim(), class: f.sec_class.value, isin: f.sec_isin.value.trim(), nominal: '1000', price: '', aci: '', coupon_year: num(f.sec_coupon.value) };
      secs.push(sec);
      changed.push('securities');
    }
    const row = {
      date: f.date.value, type: f.type.value, ticker, name: sec ? sec.name : '',
      qty: num(f.qty.value), amount: num(f.amount.value), aci: num(f.aci.value), fee: num(f.fee.value),
      tax: num(f.tax.value), cost_sold: num(f.cost_sold.value), comment: f.comment.value.trim(),
    };
    if (['Покупка', 'Продажа', 'Погашение'].includes(row.type) && (!ticker || !row.qty)) throw new Error('Для сделки нужны бумага и количество.');
    const ops = state.pf.tables.operations.rows;
    // вставляем по дате, сохраняя порядок операций в один день
    const at = ops.findIndex((o) => o.date > row.date);
    ops.splice(at < 0 ? ops.length : at, 0, row);
    $('op-save').disabled = true;
    await save(changed, `${state.pf.id}: ${row.type}${row.name ? ' ' + row.name : ''}${row.qty ? ' ×' + row.qty : ''} на ${row.amount} ₽${row.comment ? ' — ' + row.comment : ''}`);
    $('op-dialog').close();
    status('Операция сохранена коммитом в репозитории.', 'ok');
  } catch (ex) {
    err.textContent = ex.message;
    if (ex.status === 409) await reload().catch(() => {});
  } finally {
    $('op-save').disabled = false;
  }
}

async function updatePrices(btn) {
  await guarded(btn, async () => {
    status('Запрашиваю цены на Московской бирже…');
    let res;
    try { res = await refreshPrices(state.pf.tables.securities.rows); } catch (e) {
      throw new Error(`Биржа не ответила (${e.message}). Обновите цены через CLI: node cli/invest.js prices ${state.pf.id} --write`);
    }
    if (!res.updated.length) {
      throw new Error(`Ни одной цены не получено${res.failed[0] ? ': ' + res.failed[0].error : ''}. Можно обновить через CLI: node cli/invest.js prices ${state.pf.id} --write`);
    }
    const date = new Date().toISOString().slice(0, 10);
    setSetting(state.pf, 'prices_date', date);
    upsertHistory(state.pf, snapshot(analyze(rowsOf(state.pf))));
    await save(['securities', 'settings', 'history'], `${state.pf.id}: актуализация цен на ${date}`);
    const miss = res.failed.length ? ` Не обновились: ${res.failed.map((x) => x.ticker).join(', ')}.` : '';
    status(`Цены на ${F.date(date)} записаны, снимок добавлен в историю.${miss}`, miss ? '' : 'ok');
  });
}

// ---------- события ----------
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const conn = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main', token: f.token.value.trim() };
  $('setup-error').textContent = '';
  try {
    await connect(conn);
    saveConn(conn, f.remember.checked);
    f.token.value = '';
  } catch (ex) { showSetup(ex.message); }
});
$('portfolio').addEventListener('change', (e) => openPortfolio(e.target.value).catch((ex) => status(ex.message, 'err')));
$('btn-reload').addEventListener('click', (e) => guarded(e.currentTarget, reload));
$('btn-prices').addEventListener('click', (e) => updatePrices(e.currentTarget));
$('btn-add').addEventListener('click', openOpDialog);
$('op-cancel').addEventListener('click', () => $('op-dialog').close());
$('op-form').addEventListener('submit', submitOp);
$('op-form').elements.ticker.addEventListener('change', (e) => {
  const t = e.target.value.trim();
  $('new-sec').hidden = !t || state.pf.tables.securities.rows.some((x) => x.ticker === t);
});
$('btn-logout').addEventListener('click', () => {
  if (!confirm('Забыть токен на этом устройстве?')) return;
  try { localStorage.removeItem(CONN_KEY); sessionStorage.removeItem(CONN_KEY); } catch { /* нет хранилища */ }
  state.store = null;
  showSetup();
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.result) render(); }, 200);
});

// ---------- старт ----------
const saved = readConn();
if (saved?.token) {
  connect(saved).catch((ex) => showSetup(ex.message));
} else {
  showSetup();
}
