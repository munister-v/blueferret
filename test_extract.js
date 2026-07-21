const fs = require('fs');
const cheerio = require('cheerio');
const crypto = require('crypto');

function decodeHtmlEnts(str) { return str; } // Mock
function cleanInner(str) { return str.replace(/<[^>]+>/g, '').trim(); } // Mock

function extractBlocks(html){
  const $ = cheerio.load(html, { decodeEntities: false });
  const blocks = [];
  let changed = false;

  const add = (id, type, label, icon, value, domIndex, extra = {}) => {
    const v = (value || '').trim();
    if (!v && type !== 'img') return;
    blocks.push({ id, type, label, icon, value: v, domIndex, orig: id, origVal: v, ...extra });
  };

  const title = $('head title').text();
  if (title) add('seo_title', 'seo', 'Заголовок сторінки (SEO)', '🔍', decodeHtmlEnts(title), -3);
  
  const ogTitle = $('head meta[property="og:title"]').attr('content');
  if (ogTitle) add('seo_og_title', 'seo', 'OG Title (соцмережі)', '📲', decodeHtmlEnts(ogTitle), -2);
  
  const metaDesc = $('head meta[name="description"]').attr('content');
  if (metaDesc) add('seo_meta_desc', 'seo', 'Meta Description', '📝', decodeHtmlEnts(metaDesc), -1);

  const root = $('main').length ? $('main') : $('body');
  
  let idx = 0;
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
    
    if (tag === 'img') {
      const src = ($el.attr('src') || '').trim();
      if (src && !src.startsWith('data:') && src.length > 5 && !/favicon|icon/i.test(src)) {
        add(id, 'img', decodeHtmlEnts($el.attr('alt') || '') || 'Зображення', '🖼', src, idx++);
      }
    } else if (tag === 'a') {
      const text = cleanInner($el.html() || '');
      const href = ($el.attr('href') || '').trim();
      if (text && text.length >= 2 && text.length <= 150 && !$el.find('img').length) {
        add(id, 'a', 'Посилання / кнопка', '🔗', text, idx++, { href });
      }
    } else if (['h1', 'h2', 'h3'].includes(tag)) {
      const text = cleanInner($el.html() || '');
      if (text && text.length >= 2 && text.length <= 160) {
        const label = tag === 'h1' ? 'Заголовок H1' : tag === 'h2' ? 'Заголовок H2' : 'Підзаголовок';
        const icon = tag === 'h1' ? 'H₁' : tag === 'h2' ? 'H₂' : 'H₃';
        add(id, tag, label, icon, text, idx++);
      }
    } else if (tag === 'p') {
      const innerHtml = $el.html() || '';
      const text = cleanInner(innerHtml);
      if (text && text.length >= 2 && text.length <= 1500) {
        add(id, 'p', 'Абзац тексту', '¶', text, idx++);
      }
    } else if (tag === 'li') {
      const innerHtml = $el.html() || '';
      const text = cleanInner(innerHtml);
      if (text && text.length >= 4 && text.length <= 200) {
        add(id, 'li', 'Елемент списку', '📌', text, idx++);
      }
    } else if (tag === 'span') {
      const text = decodeHtmlEnts($el.text()).trim();
      if (text && text.length >= 3 && text.length <= 60 && !$el.find('*').length) {
        add(id, 'span', 'Мітка / бейдж', '🏷', text, idx++);
      }
    }
  });

  return { blocks, changed };
}

const html = fs.readFileSync('./site/index.html', 'utf8');
const res = extractBlocks(html);
console.log(res.blocks.length);
