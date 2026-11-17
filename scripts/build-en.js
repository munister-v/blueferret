#!/usr/bin/env node
// Builds site/bf-en.js (the English overlay) from scripts/i18n/en.json + scripts/i18n/bf-en.tpl.js.
//   node scripts/build-en.js      then: ./deploy-site.sh bf-en.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', 'en.json'), 'utf8'));
const tpl = fs.readFileSync(path.join(__dirname, 'i18n', 'bf-en.tpl.js'), 'utf8');
fs.writeFileSync(path.join(root, 'site', 'bf-en.js'), tpl.replace('/*DICT*/', () => JSON.stringify(dict)));
console.log('site/bf-en.js written:', Object.keys(dict.text).length, 'strings');
