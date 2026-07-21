const cheerio = require('cheerio');
const $ = cheerio.load('<div><p id="1">1</p><p id="2">2</p></div>');
$('#2').after($('#1'));
console.log($.html());
