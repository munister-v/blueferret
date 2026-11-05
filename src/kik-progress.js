// The collection figures on a project's own page (raised / goal, the progress
// bar, the percent on the cover, "Поточний прогрес", "Оновлення · date") are
// prerendered into the HTML and into the RSC flight data. The old way of
// keeping them current swapped "previous value" for "new value", which
// silently stops working the first time the page and the catalog disagree
// (and money moves through it on every confirmed payment). This enforces the
// catalog's values instead: whatever the page held, it ends up with them.
// DOM and flight are both rewritten, or neither is (a half-updated page fails
// hydration with #418). Idempotent.
const nbsp = ' ';
const money = n => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(n) + ' ₴';
const moneyDom = n => money(n).split(nbsp).join('&nbsp;');
const pctExact = p => String(p.goal > 0 ? Math.min(100, p.raised / p.goal * 100) : 0);
const pctRound = p => String(p.goal > 0 ? Math.round(Math.min(100, p.raised / p.goal * 100)) : 0);
const dateUa = iso => { const [y, m, d] = String(iso).split('-'); return `${d}.${m}.${y}`; };

const F = '\\\\"'; // an escaped quote as it appears inside the flight JS string: \"

function rules(p) {
  const pr = pctRound(p), pe = pctExact(p);
  return [
    // DOM
    ['dom raised/goal', /(<span class="text-\[var\(--kik-accent\)\] font-extrabold text-lg"[^>]*>)[^<]*(<!-- --> \/ <!-- -->)[^<]*(<\/span>)/g, (_m, a, b, c) => a + moneyDom(p.raised) + b + moneyDom(p.goal) + c],
    ['dom bar', /(transition-all duration-700" style="width:)[\d.]+(%")/g, (_m, a, c) => a + pe + c],
    ['dom progress', /(Поточний прогрес<!-- -->: <!-- -->)\d+(<!-- -->%)/g, (_m, a, c) => a + pr + c],
    ['dom cover %', /(<\/svg>)\d+(<!-- -->%<\/span><\/div><div class="p-5 sm:p-6">)/g, (_m, a, c) => a + pr + c],
    ['dom date', /(Оновлення<!-- --> · <!-- -->)\d{2}\.\d{2}\.\d{4}(<\/p>)/g, (_m, a, c) => a + dateUa(p.lastUpdate) + c],
    // flight
    ['flight raised/goal', new RegExp(`(${F}className${F}:${F}text-\\[var\\(--kik-accent\\)\\] font-extrabold text-lg${F},${F}children${F}:\\[${F})[^"\\\\]*(${F},${F} / ${F},${F})[^"\\\\]*(${F}\\])`, 'g'), (_m, a, b, c) => a + money(p.raised) + b + money(p.goal) + c],
    ['flight bar', new RegExp(`(transition-all duration-700${F},${F}style${F}:\\{${F}width${F}:${F})[\\d.]+(%${F}\\})`, 'g'), (_m, a, c) => a + pe + c],
    ['flight progress', new RegExp(`(${F}Поточний прогрес${F},${F}: ${F},)\\d+(,${F}%${F})`, 'g'), (_m, a, c) => a + pr + c],
    ['flight cover %', new RegExp(`(${F}\\$undefined${F}\\]\\}\\],)\\d+(,${F}%${F}\\]\\}\\]\\]\\}\\],\\[${F}\\$${F},${F}div${F},null,\\{${F}className${F}:${F}p-5 sm:p-6)`, 'g'), (_m, a, c) => a + pr + c],
    ['flight date', new RegExp(`(${F}Оновлення${F},${F} · ${F},${F})\\d{2}\\.\\d{2}\\.\\d{4}(${F})`, 'g'), (_m, a, c) => a + dateUa(p.lastUpdate) + c],
  ];
}

// p: { raised, goal, lastUpdate } of the catalog. Returns the new html, or the
// same string when the page does not have the markup we know (left alone).
function syncProgress(html, p) {
  if (typeof html !== 'string' || !p) return html;
  const raised = Number(p.raised), goal = Number(p.goal);
  if (!Number.isFinite(raised) || !Number.isFinite(goal) || raised < 0 || goal <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.lastUpdate))) return html;
  let out = html;
  for (const [, re, fn] of rules({ raised, goal, lastUpdate: p.lastUpdate })) {
    re.lastIndex = 0;
    if (!re.test(out)) return html; // one piece missing: touch nothing
    re.lastIndex = 0;
    out = out.replace(re, fn);
  }
  return out;
}

module.exports = { syncProgress, money, dateUa, pctRound, pctExact };
