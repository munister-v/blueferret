const fs = require('fs');
let doc = fs.readFileSync('site/kik/proekty/index.html', 'utf8');
const match = doc.match(/(<header[^>]*>.*?<\/header>)\s*<main>[\s\S]*?(?=<\/main>\s*<\/div>\s*<\/main>)/);
if (match) console.log("Match found! Replaced successfully.");
else console.log("No match found.");
