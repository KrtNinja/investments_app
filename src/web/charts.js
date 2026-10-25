// Графики на чистом SVG, без библиотек. Цвета берутся из CSS-переменных.
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    // var(--…) в атрибутах SVG поддерживается не везде — цвета ставим через style
    if (typeof v === 'string' && v.startsWith('var(')) e.style.setProperty(k, v);
    else e.setAttribute(k, v);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}

const rub = (x) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x) + ' ₽';
const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + '%';
const short = (x) => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(x);

// Капитал и чистые вложения по снимкам истории.
export function historyChart(history, width) {
  const W = Math.max(300, width), H = 220, L = 76, R = 12, T = 12, B = 28;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'chart', role: 'img',
    'aria-label': 'Капитал и чистые вложения по датам' });
  if (!history.length) return svg;
  const vals = history.flatMap((h) => [h.capital, h.net_invested]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || hi * 0.02 || 1;
  lo -= pad; hi += pad;
  const x = (i) => history.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (history.length - 1);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);

  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * k / 3;
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'axis' }));
    svg.append(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, short(v)));
  }
  const step = Math.max(1, Math.ceil(history.length / 6));
  history.forEach((h, i) => {
    if (i % step === 0 || i === history.length - 1) {
      svg.append(el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, h.date.split('-').reverse().slice(0, 2).join('.')));
    }
  });
  const series = [
    ['net_invested', 'var(--ink-2)', '4 3'],
    ['capital', 'var(--coupon)', ''],
  ];
  for (const [key, color, dash] of series) {
    const pts = history.map((h, i) => `${x(i)},${y(h[key])}`).join(' ');
    if (history.length > 1) svg.append(el('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': dash }));
    history.forEach((h, i) => {
      const c = el('circle', { cx: x(i), cy: y(h[key]), r: 3.5, fill: color });
      c.append(el('title', {}, `${h.date.split('-').reverse().join('.')}\nЧистые вложения: ${rub(h.net_invested)}\nКапитал: ${rub(h.capital)}\nПрирост: ${rub(h.growth)}`));
      svg.append(c);
    });
  }
  return svg;
}

// Доли выпусков: полоса — сейчас, вертикальная черта — цель.
export function targetBars(rows, width) {
  const W = Math.max(300, width), rowH = 30, L = Math.min(210, W * 0.42), R = 48, T = 4;
  const H = T + rows.length * rowH + 6;
  const max = Math.max(0.05, ...rows.flatMap((r) => [r.share, r.target])) * 1.1;
  const x = (v) => L + v / max * (W - L - R);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'chart', role: 'img',
    'aria-label': 'Текущая и целевая доля каждого выпуска' });
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2;
    const g = el('g');
    svg.append(g);
    if (r.value !== undefined) {
      g.append(el('title', {}, `${r.label}\nСейчас: ${pct(r.share)} (${rub(r.value)})\nЦель: ${pct(r.target)} (${rub(r.goal)})\nДокупить: ${rub(r.to_buy)}`));
      g.append(el('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: 'transparent' }));
    }
    // подпись не шире левого поля (~6,5 px на символ при 12px), полное название — в подсказке
    const maxCh = Math.max(6, Math.floor((L - 12) / 6.5));
    const label = r.label.length > maxCh ? r.label.slice(0, maxCh - 1) + '…' : r.label;
    g.append(el('text', { x: L - 8, y: cy + 4, 'text-anchor': 'end' }, label));
    g.append(el('rect', { x: L, y: cy - 7, width: Math.max(0, x(r.share) - L), height: 14, rx: 3,
      fill: r.share > r.target + 0.005 ? 'var(--loss)' : 'var(--coupon)', opacity: 0.85 }));
    g.append(el('line', { x1: x(r.target), x2: x(r.target), y1: cy - 11, y2: cy + 11, stroke: 'var(--target)', 'stroke-width': 2.5 }));
    g.append(el('text', { x: Math.max(x(r.share), x(r.target)) + 6, y: cy + 4 }, `${(r.share * 100).toFixed(1).replace('.', ',')}%`));
  });
  return svg;
}
