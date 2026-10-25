// RFC 4180 CSV: запятая, кавычки, переводы строк внутри кавычек.
// Работает и в браузере, и в Node.

export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  return {
    columns: header,
    rows: body.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? '']))),
  };
}

function cell(v) {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export function stringifyCsv(columns, rows) {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
