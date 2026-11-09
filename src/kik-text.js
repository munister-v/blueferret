// Text swaps inside a prerendered Next page. A text lives in two encodings:
// HTML (DOM text, <meta>, <title>) and the RSC flight payload (JSON inside a JS
// string literal inside <script>). Each is swapped in its own encoding and only
// in its own region, so quotes, < > & ' and \ in a description neither get
// skipped nor land raw in the markup (or HTML-escaped in the flight data).
const HTML_ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#x27;' };
const kikHtmlEnc = t => String(t).replace(/[&<>"']/g, c => HTML_ESC[c]);
// JSON string escaping, then the JS string literal around it escapes \ and " once more
const kikFlightEnc = t => JSON.stringify(String(t)).slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// Next also writes & < > as \u0026 \u003c \u003e inside the script tag
const kikFlightEncU = t => kikFlightEnc(t).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const ENCODERS = [[kikHtmlEnc, 'dom'], [kikFlightEnc, 'flight'], [kikFlightEncU, 'flight']];

// [old, new, scope] pairs for one text change; `existing` is only used to dedupe
function textPairs(a, b, existing = []) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length < 3 || b.length < 3 || a === b) return [];
  const seen = new Set(existing.map(x => x[2] + '\u0000' + x[0] + '\u0000' + x[1]));
  const out = [];
  for (const [enc, scope] of ENCODERS) {
    const x = enc(a), y = enc(b), key = scope + '\u0000' + x + '\u0000' + y;
    if (x !== y && !seen.has(key)) { seen.add(key); out.push([x, y, scope]); }
  }
  return out;
}

// Apply [old, new] (whole file) and [old, new, 'dom'|'flight'] (scoped) pairs.
function applyScopedPairs(html, pairs) {
  let h = html, hits = 0;
  for (const [a, b, scope] of pairs) {
    if (!scope) {
      const n = h.split(a).length - 1;
      if (n) { h = h.split(a).join(b); hits += n; }
      continue;
    }
    const segs = h.split(/(<script\b[\s\S]*?<\/script>)/);
    for (let i = 0; i < segs.length; i++) {
      if ((i % 2 === 1) !== (scope === 'flight')) continue;
      const n = segs[i].split(a).length - 1;
      if (n) { segs[i] = segs[i].split(a).join(b); hits += n; }
    }
    h = segs.join('');
  }
  return { html: h, hits };
}

module.exports = { kikHtmlEnc, kikFlightEnc, kikFlightEncU, textPairs, applyScopedPairs };
