// Тесты на выдуманных данных: реальных данных в этом репозитории нет и быть не должно.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, stringifyCsv } from '../src/core/csv.js';
import { analyze, snapshot } from '../src/core/model.js';
import { GitHubStore } from '../src/core/github.js';
import { upsertHistory } from '../src/core/portfolio.js';

const csv = (t) => parseCsv(t).rows;

const data = {
  settings: csv('key,value\nprices_date,2030-01-10\ntax_rate,0.13\nfee_rate,0.001\ntarget_monthly_income,1000\n'),
  operations: csv(
    'date,type,ticker,name,qty,amount,aci,fee,tax,cost_sold,comment\n' +
    '2030-01-01,Пополнение,,,,10000,,,,,\n' +
    '2030-01-02,Покупка,AAA,Бумага А,5,4900,50,4.9,,,"5 × 980, тест"\n' +
    '2030-01-05,Купон на карту,AAA,Бумага А,5,250,,,,,\n' +
    '2030-01-06,Реинвест с карты,,,,250,,,,,\n',
  ),
  securities: csv('ticker,name,class,isin,nominal,price,aci,coupon_year\nAAA,Бумага А,Облигации,XS0,1000,990,2,120\n'),
  target_classes: csv('class,target,comment\nОблигации,1,\nДеньги,0,\n'),
  target_issues: csv(
    'issue,ticker,ticker2,isin,group,term,target,decision,coupon_pct,payments_per_year,maturity,comment\n' +
    'Бумага А,AAA,,XS0,ОФЗ,,1,Держать,12,2,2035-01-01,\n',
  ),
  history: [],
};

test('CSV: кавычки, запятые и обратное преобразование', () => {
  const t = parseCsv('a,b\n"x, y","он сказал ""да"""\n');
  assert.deepEqual(t.rows, [{ a: 'x, y', b: 'он сказал "да"' }]);
  assert.equal(stringifyCsv(t.columns, t.rows), 'a,b\n"x, y","он сказал ""да"""\n');
});

test('капитал, вложения и прирост', () => {
  const r = analyze(data);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  // деньги: 10000 − (4900+50+4.9) + 250 реинвест = 5295.1
  close(r.capital.cash, 5295.1);
  // бумаги: 5 × (990 + 2) = 4960
  close(r.capital.securities, 4960);
  close(r.capital.capital, 10255.1);
  close(r.capital.net, 10000);
  // прирост = капитал + на карту − реинвест − вложено = 10255.1 + 250 − 250 − 10000
  close(r.capital.growth, 255.1);
  close(r.goal.income_month, 5 * 120 * 0.87 / 12);
  assert.deepEqual(snapshot(r), { date: '2030-01-10', net_invested: 10000, capital: 10255.1, growth: 255.1 });
});

test('снимок истории на ту же дату заменяется', () => {
  const pf = { tables: { history: { rows: [{ date: '2030-01-10', net_invested: '1', capital: '1', growth: '0' }] } } };
  upsertHistory(pf, { date: '2030-01-10', net_invested: 2, capital: 3, growth: 1 });
  upsertHistory(pf, { date: '2030-01-09', net_invested: 1, capital: 1, growth: 0 });
  assert.deepEqual(pf.tables.history.rows.map((r) => r.date), ['2030-01-09', '2030-01-10']);
  assert.equal(pf.tables.history.rows[1].capital, '3');
});

test('GitHub: запись одним коммитом от прочитанного коммита', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push([init.method || 'GET', url.replace('https://api.github.com/repos/o/r', '')]);
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.includes('/git/ref/heads/main')) return json({ object: { sha: 'HEAD1' } });
    if (url.includes('/contents/')) return { ok: true, status: 200, text: async () => 'a\n1\n' };
    if (url.endsWith('/git/commits/HEAD1')) return json({ tree: { sha: 'TREE1' } });
    if (url.endsWith('/git/trees')) {
      assert.equal(JSON.parse(init.body).base_tree, 'TREE1');
      return json({ sha: 'TREE2' });
    }
    if (url.endsWith('/git/commits')) {
      assert.deepEqual(JSON.parse(init.body).parents, ['HEAD1']);
      return json({ sha: 'C2' });
    }
    if (url.includes('/git/refs/heads/main')) {
      assert.equal(JSON.parse(init.body).force, false);
      return json({});
    }
    throw new Error('неожиданный запрос ' + url);
  };
  const s = new GitHubStore({ owner: 'o', repo: 'r', token: 't' });
  assert.equal(await s.read('x.csv'), 'a\n1\n');
  await s.commit({ 'x.csv': 'a\n2\n' }, 'msg');
  assert.equal(s.head, 'C2');
  assert.deepEqual(calls.map((c) => c[0]), ['GET', 'GET', 'GET', 'POST', 'POST', 'PATCH']);
});

test('GitHub: конфликт, если ветку обновили после чтения', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.includes('/git/ref/heads/main')) return json({ object: { sha: 'HEAD1' } });
    if (url.endsWith('/git/commits/HEAD1')) return json({ tree: { sha: 'T' } });
    if (url.endsWith('/git/trees') || url.endsWith('/git/commits')) return json({ sha: 'X' });
    if (url.includes('/git/refs/heads/main')) return { ok: false, status: 422, json: async () => ({ message: 'Update is not a fast forward' }) };
    throw new Error(url + init.method);
  };
  const s = new GitHubStore({ owner: 'o', repo: 'r', token: 't' });
  await assert.rejects(() => s.commit({ 'x.csv': '' }, 'm'), (e) => e.status === 409);
});
