#!/usr/bin/env node
// CLI для людей и агентов. Источник данных — локальный клон или GitHub.
//
//   node cli/invest.js summary  <id> --data ../investments_db [--json]
//   node cli/invest.js prices   <id> --data ../investments_db [--write] [--commit]
//   node cli/invest.js summary  <id> --github owner/investments_db     (токен в GITHUB_TOKEN)
//   node cli/invest.js list          --data ../investments_db

import { parseArgs } from 'node:util';
import { analyze, snapshot } from '../src/core/model.js';
import { loadRegistry, loadPortfolio, rowsOf, savePortfolio, setSetting, upsertHistory } from '../src/core/portfolio.js';
import { refreshPrices } from '../src/core/moex.js';
import { GitHubStore } from '../src/core/github.js';
import { FsStore } from './fs-store.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    github: { type: 'string' },
    branch: { type: 'string', default: 'main' },
    json: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
    date: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [cmd, id] = positionals;

const USAGE = `Использование:
  invest list                 --data <путь> | --github owner/repo
  invest summary <id> [--json] --data <путь> | --github owner/repo
  invest prices  <id> [--write] [--commit] [--date YYYY-MM-DD] --data <путь> | --github owner/repo

  --data    локальный клон investments_db
  --github  репозиторий на GitHub, токен берётся из GITHUB_TOKEN
  --write   записать новые цены и снимок в history.csv
  --commit  для --data: сразу сделать git commit (для --github запись всегда коммит)`;

function store() {
  if (opt.data) return new FsStore(opt.data, { gitCommit: opt.commit });
  if (opt.github) {
    const [owner, repo] = opt.github.split('/');
    return new GitHubStore({ owner, repo, branch: opt.branch, token: process.env.GITHUB_TOKEN });
  }
  throw new Error('Укажите --data <путь> или --github owner/repo');
}

const rub = (x) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(x) + ' ₽';
const pct = (x) => (x === null || x === undefined) ? '—' : (x * 100).toFixed(1) + '%';

function printSummary(name, r) {
  const c = r.capital, g = r.goal;
  console.log(`${name} — цены на ${r.settings.prices_date || '—'}`);
  console.log(`  Капитал           ${rub(c.capital)}  (бумаги ${rub(c.securities)}, деньги ${rub(c.cash)})`);
  console.log(`  Чистые вложения   ${rub(c.net)}`);
  console.log(`  Прирост           ${rub(c.growth)}  (${pct(c.growth_pct)})`);
  console.log(`  Купоны в месяц    ${rub(g.income_month)} на руки из ${rub(g.target_monthly_income)} (${pct(g.income_share)})`);
  if (g.target_sum) console.log(`  Нужно капитала    ${rub(g.target_sum)}, пройдено ${pct(g.progress)}`);
  console.log('\n  Бумаги:');
  for (const p of r.positions.filter((x) => x.qty)) {
    console.log(`    ${p.ticker.padEnd(14)} ${String(p.qty).padStart(5)} шт  ${rub(p.value).padStart(16)}  ${pct(p.share).padStart(6)}  результат ${rub(p.result)}`);
  }
  console.log('\n  Ребалансировка (докупить на новые деньги):');
  for (const s of r.issues.filter((x) => x.buy_qty > 0)) {
    console.log(`    ${s.issue.padEnd(26)} ${pct(s.share).padStart(6)} → ${pct(s.target).padStart(6)}  ≈ ${s.buy_qty} шт (${rub(s.to_buy)})`);
  }
  if (r.checks.length) {
    console.log('\n  Что проверить:');
    for (const ch of r.checks) console.log(`    ${ch.kind}: ${ch.item} — ${ch.detail}`);
  }
}

async function main() {
  if (opt.help || !cmd) { console.log(USAGE); return; }
  const s = store();

  if (cmd === 'list') {
    for (const p of await loadRegistry(s)) console.log(`${p.id}\t${p.name}\t${p.broker}\t${p.status}`);
    return;
  }
  if (!id) throw new Error('Укажите id портфеля (см. invest list)');
  const reg = await loadRegistry(s);
  const meta = reg.find((p) => p.id === id);
  if (!meta) throw new Error(`Портфеля «${id}» нет в portfolios.csv`);
  const pf = await loadPortfolio(s, id);

  if (cmd === 'summary') {
    const r = analyze(rowsOf(pf));
    if (opt.json) {
      const { flows, ...rest } = r;
      console.log(JSON.stringify({ id, name: meta.name, ...rest }, null, 2));
    } else printSummary(meta.name, r);
    return;
  }

  if (cmd === 'prices') {
    const { updated, failed } = await refreshPrices(pf.tables.securities.rows);
    for (const u of updated) console.log(`  ${u.ticker.padEnd(14)} ${u.pct}% → ${u.price} ₽, НКД ${u.aci} ₽`);
    for (const f of failed) console.error(`  ! ${f.ticker} (${f.isin}): ${f.error}`);
    if (!updated.length) throw new Error('Ни одной цены не получено');
    const date = opt.date || new Date().toISOString().slice(0, 10);
    setSetting(pf, 'prices_date', date);
    const r = analyze(rowsOf(pf));
    const snap = snapshot(r);
    upsertHistory(pf, snap);
    console.log(`\n  Снимок ${snap.date}: вложено ${rub(snap.net_invested)}, капитал ${rub(snap.capital)}, прирост ${rub(snap.growth)}`);
    if (!opt.write) { console.log('\n  Это предпросмотр. Чтобы записать: --write'); return; }
    await savePortfolio(s, pf, ['securities', 'settings', 'history'], `${id}: актуализация цен на ${date}`);
    console.log(opt.data && !opt.commit ? '  Файлы обновлены, не забудьте закоммитить.' : '  Записано коммитом.');
    return;
  }

  throw new Error(`Неизвестная команда «${cmd}»\n\n${USAGE}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
