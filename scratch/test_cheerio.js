const cheerio = require('cheerio');
const crypto = require('crypto');

const html = `
<main>
  <h1>Hello</h1>
  <p>Some text</p>
  <img src="test.jpg" alt="pic">
</main>
`;

function extractBlocks(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const blocks = [];
  let changed = false;
  
  const root = $('main').length ? $('main') : $('body');
  
  root.find('h1, h2, h3, p, a, span, img, li').each((_, el) => {
    const $el = $(el);
    if ($el.closest('script, style, svg, header, nav, footer').length > 0) return;

    const tag = el.tagName.toLowerCase();
    
    let id = $el.attr('data-bf-id');
    if (!id) {
      id = 'bf_' + crypto.randomBytes(4).toString('hex');
      $el.attr('data-bf-id', id);
      changed = true;
    }
    
    blocks.push({ id, tag, value: $el.html() || $el.attr('src') });
  });

  return { blocks, newHtml: changed ? $.html() : html };
}

const res = extractBlocks(html);
console.log("Blocks:", res.blocks);
console.log("New HTML:", res.newHtml);

const $ = cheerio.load(res.newHtml, { decodeEntities: false });
$(`[data-bf-id="${res.blocks[0].id}"]`).html('Updated H1!');
console.log("Patched HTML:", $.html());
