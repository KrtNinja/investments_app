// Загрузка и сохранение портфеля из любого хранилища с методами read(path) и commit(files, message).
import { parseCsv, stringifyCsv } from './csv.js';
import { FILES } from './model.js';

export async function loadRegistry(store) {
  return parseCsv(await store.read('portfolios.csv')).rows;
}

// Возвращает { id, tables: { operations: {columns, rows}, ... } }.
export async function loadPortfolio(store, id) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`Некорректный id портфеля «${id}»`);
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, file]) => [key, parseCsv(await store.read(`portfolios/${id}/${file}`))]),
  );
  return { id, tables: Object.fromEntries(entries) };
}

// Строки всех таблиц — вход для analyze().
export function rowsOf(portfolio) {
  return Object.fromEntries(Object.entries(portfolio.tables).map(([k, t]) => [k, t.rows]));
}

// changed: ['operations', 'history'] — какие таблицы записать.
export async function savePortfolio(store, portfolio, changed, message) {
  const files = {};
  for (const key of changed) {
    const t = portfolio.tables[key];
    files[`portfolios/${portfolio.id}/${FILES[key]}`] = stringifyCsv(t.columns, t.rows);
  }
  return store.commit(files, message);
}

export function setSetting(portfolio, key, value) {
  const rows = portfolio.tables.settings.rows;
  const row = rows.find((r) => r.key === key);
  if (row) row.value = String(value);
  else rows.push({ key, value: String(value) });
}

// Добавляет снимок в history.csv; снимок на ту же дату заменяется.
export function upsertHistory(portfolio, snap) {
  const rows = portfolio.tables.history.rows;
  const i = rows.findIndex((r) => r.date === snap.date);
  const row = Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, String(v)]));
  if (i >= 0) rows[i] = row; else rows.push(row);
  rows.sort((a, b) => a.date.localeCompare(b.date));
}
