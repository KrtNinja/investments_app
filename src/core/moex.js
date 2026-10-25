// Цены облигаций с Московской биржи (ISS API, открытый, без ключа).
// Цена на бирже — в % от номинала; переводим в рубли за 1 шт. НКД ISS отдаёт в рублях.

const ISS = 'https://iss.moex.com/iss';

function table(block) {
  return (block?.data || []).map((row) => Object.fromEntries(block.columns.map((c, i) => [c, row[i]])));
}

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`MOEX ${res.status}: ${url}`);
  return res.json();
}

export async function lookupByIsin(isin) {
  const j = await get(`${ISS}/securities.json?q=${encodeURIComponent(isin)}&iss.meta=off`);
  const rows = table(j.securities).filter((r) => r.isin === isin);
  const hit = rows.find((r) => r.is_traded === 1) || rows[0];
  if (!hit) throw new Error(`На MOEX не найден ISIN ${isin}`);
  return { secid: hit.secid, board: hit.primary_boardid };
}

export async function bondQuote(isin) {
  const { secid, board } = await lookupByIsin(isin);
  const j = await get(
    `${ISS}/engines/stock/markets/bonds/boards/${board}/securities/${secid}.json` +
    '?iss.meta=off&iss.only=securities,marketdata',
  );
  const s = table(j.securities)[0];
  const m = table(j.marketdata)[0] || {};
  if (!s) throw new Error(`MOEX не вернул данные по ${isin} (${secid}, ${board})`);
  const pct = [m.LAST, m.LCURRENTPRICE, m.MARKETPRICE, s.PREVPRICE].find((x) => typeof x === 'number' && x > 0);
  if (!pct) throw new Error(`Нет цены по ${isin}`);
  const face = s.FACEVALUE || 1000;
  return {
    isin, secid, board,
    price: Math.round(pct * face) / 100,
    aci: s.ACCRUEDINT ?? 0,
    pct, face,
  };
}

// Обновляет price и aci в строках securities. Возвращает { updated: [...], failed: [...] }.
export async function refreshPrices(securities) {
  const updated = [], failed = [];
  for (const row of securities) {
    const isin = (row.isin || '').trim();
    if (!isin) continue;
    try {
      const q = await bondQuote(isin);
      row.price = String(q.price);
      row.aci = String(q.aci);
      updated.push({ ticker: row.ticker, ...q });
    } catch (e) {
      failed.push({ ticker: row.ticker, isin, error: e.message });
    }
  }
  return { updated, failed };
}
