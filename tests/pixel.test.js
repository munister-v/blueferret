const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ID = '1867446057590592';
// Pages the admin server (re)generates on boot or on save must carry the Meta Pixel,
// otherwise a deploy restart silently drops it from them.
test('generated game pages (views/game.ejs) carry the Meta Pixel in <head>', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'views', 'game.ejs'), 'utf8');
  assert.ok(t.indexOf(ID) > -1 && t.indexOf(ID) < t.indexOf('</head>'));
});
test('new-page template in server.js carries the Meta Pixel', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes(ID));
});
