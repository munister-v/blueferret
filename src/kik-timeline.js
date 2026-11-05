// The stage list on a project's own page (Підготовка / Збір коштів /
// Виробництво) is prerendered: the highlighted row is frozen into the HTML and
// into the RSC flight data hydration replays, and it does not read the
// catalog's `status` at runtime. Changing the status in the admin therefore
// moved the catalog card but left the page on "Підготовка". This rebuilds the
// block, DOM and flight together (they must agree or hydration fails with
// #418) from the project's status. Idempotent.
//
//   preparing -> Підготовка is current
//   active    -> Підготовка done, Збір коштів current
//   complete  -> Підготовка, Збір коштів done, Виробництво current
const STAGES = ['Підготовка', 'Збір коштів', 'Виробництво'];
const CURRENT_STAGE = { preparing: 0, active: 1, complete: 2 };

const ROW = 'flex items-center justify-between rounded-xl border px-4 py-3';
const CLS = {
  done: 'border-emerald-200 bg-emerald-50/70 text-emerald-700',
  current: 'border-[var(--kik-accent)]/30 bg-[var(--kik-accent)]/10 text-[var(--kik-accent)]',
  todo: 'border-slate-200 bg-slate-50 text-slate-500',
};
// slot in the flight children: [label, done icon, current icon, todo icon]
const SLOT = { done: 0, current: 1, todo: 2 };
const ICONS = {
  done: { name: 'shield-check', paths: [['oel41y', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }], ['dzmm74', { d: 'm9 12 2 2 4-4' }]] },
  current: { name: 'timer-reset', paths: [['n1abiw', { d: 'M10 2h4' }], ['1evpnu', { d: 'M12 14v-4' }], ['1ts96g', { d: 'M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6' }], ['8t5av', { d: 'M9 17H4v5' }]] },
  todo: { name: 'calendar-days', paths: [['1cmpym', { d: 'M8 2v4' }], ['4m81vk', { d: 'M16 2v4' }], ['1hopcy', { width: '18', height: '18', x: '3', y: '4', rx: '2' }, 'rect'], ['8toen8', { d: 'M3 10h18' }], ['6423bh', { d: 'M8 14h.01' }], ['1etili', { d: 'M12 14h.01' }], ['1gbofw', { d: 'M16 14h.01' }], ['lrp35t', { d: 'M8 18h.01' }], ['mhygvu', { d: 'M12 18h.01' }], ['kzsmim', { d: 'M16 18h.01' }]] },
};

function stateOf(i, status) {
  const cur = CURRENT_STAGE[status];
  return i < cur ? 'done' : i === cur ? 'current' : 'todo';
}

function domIcon(state) {
  const ic = ICONS[state];
  const inner = ic.paths.map(([, attrs, tag]) => {
    const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${tag || 'path'}${a}></${tag || 'path'}>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${ic.name} w-4 h-4" aria-hidden="true">${inner}</svg>`;
}

function domRow(label, id, state) {
  return `<div class="${ROW} ${CLS[state]}"><span class="font-medium" data-bf-id="${id}">${label}</span>${domIcon(state)}</div>`;
}

function flightIcon(state) {
  const ic = ICONS[state];
  const children = ic.paths.map(([key, attrs, tag]) => ['$', tag || 'path', key, attrs]);
  children.push('$undefined');
  return ['$', 'svg', null, {
    ref: '$undefined', xmlns: 'http://www.w3.org/2000/svg', width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    className: `lucide lucide-${ic.name} w-4 h-4`, 'aria-hidden': 'true', children,
  }];
}

function flightBlock(status) {
  const rows = STAGES.map((label, i) => {
    const state = stateOf(i, status);
    const slots = [false, false, false];
    slots[SLOT[state]] = flightIcon(state);
    return ['$', 'div', label, {
      className: `${ROW} ${CLS[state]}`,
      children: [['$', 'span', null, { className: 'font-medium', children: label }], ...slots],
    }];
  });
  const json = JSON.stringify(['$', 'div', null, { className: 'space-y-3 mb-7', children: rows }]);
  // inside a JS string literal: quotes escaped, non-ASCII stays as it is
  return json.replace(/"/g, '\\"');
}

// html: a project's detail page. Returns the new html (same string when the
// page has no stage block, the status is unknown, or nothing changes).
function syncTimeline(html, status) {
  if (!(status in CURRENT_STAGE) || typeof html !== 'string') return html;
  let out = html;

  // DOM
  const domRe = new RegExp(
    `<div class="${ROW} [^"]*"><span class="font-medium" data-bf-id="(bf_\\w+)">(${STAGES.join('|')})</span><svg[\\s\\S]*?</svg></div>`, 'g');
  const seen = [];
  out = out.replace(domRe, (_m, id, label) => {
    const i = STAGES.indexOf(label);
    seen.push(i);
    return domRow(label, id, stateOf(i, status));
  });
  if (seen.length !== STAGES.length) return html; // not the markup we know: leave the page alone

  // flight
  const head = '[\\"$\\",\\"div\\",null,{\\"className\\":\\"space-y-3 mb-7\\",\\"children\\":[';
  const s = out.indexOf(head);
  if (s < 0) return html;
  const end = out.indexOf('\\n"])</script>', s);
  if (end < 0) return html;
  // the block ends with its own closing "]}]" right before the line break
  if (!out.slice(s, end).endsWith(']}]')) return html;
  out = out.slice(0, s) + flightBlock(status) + out.slice(end);
  return out;
}

module.exports = { syncTimeline, STAGES, CURRENT_STAGE };
