const cheerio = require('cheerio');

const html = `<!doctype html>
<html lang="uk">
<head><title>Test</title></head>
<body><main><h1>Hello</h1></main></body>
</html>`;

const $ = cheerio.load(html, { decodeEntities: false });
console.log($.html());
