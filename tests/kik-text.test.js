const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { textPairs, applyScopedPairs, kikHtmlEnc, kikFlightEnc } = require('../src/kik-text');

const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'kik', 'proekty', '6', 'index.html'), 'utf8');
const OLD = 'Дуельна гра, де ви можете стати тхором, який ховає корм по квартирі, або господарем, що намагається знайти всі схованки! Гра на блеф та прорахунок імовірностей.';
const split = h => { const s = h.split(/(<script\b[\s\S]*?<\/script>)/); return { dom: s.filter((_, i) => i % 2 === 0).join(''), scr: s.filter((_, i) => i % 2 === 1).join('') }; };

for (const [name, text] of Object.entries({
  plain: 'Нова проста назва опису для перевірки роботи',
  apostrophe_ampersand: "Гра, де ти — тхір: хова'єш корм & шукаєш схованки",
  double_quotes: 'Гра "Ничка" про тхорів і їхні схованки по квартирі',
  angle_brackets: 'Гра для 2 гравців, тривалість < 20 хв і > 10 хв',
  backslash: 'Назад слеш \\ і ще текст для перевірки',
})) {
  test(`description with ${name}: DOM, meta and flight each get it in their own encoding`, () => {
    assert.ok(page.includes(OLD));
    const { html, hits } = applyScopedPairs(page, textPairs(OLD, text));
    const { dom, scr } = split(html);
    assert.ok(hits >= 4);
    assert.ok(dom.includes(kikHtmlEnc(text)), 'DOM/meta has the HTML-escaped text');
    assert.ok(scr.includes(kikFlightEnc(text)) || scr.includes(kikFlightEnc(text).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')), 'flight has the JSON-escaped text');
    assert.ok(!dom.includes(OLD) && !scr.includes(OLD), 'old text is gone everywhere');
    if (kikHtmlEnc(text) !== kikFlightEnc(text)) assert.ok(!scr.includes(kikHtmlEnc(text)), 'no HTML entities leak into the flight data');
    // and back again: a stale page is pulled to the catalog's text
    assert.equal(applyScopedPairs(html, textPairs(text, OLD)).html, page);
  });
}

test('too short or equal texts produce no pairs', () => {
  assert.deepEqual(textPairs('ab', 'abcd'), []);
  assert.deepEqual(textPairs('same text', 'same text'), []);
});
