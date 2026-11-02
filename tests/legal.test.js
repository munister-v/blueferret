const test = require('node:test');
const assert = require('node:assert/strict');
const { render, htmlToMd, placeholders } = require('../src/legal');

const MD = `# Політика

Редакція від 02.11.2026

## Дані

- **При оплаті:** сума & дата
- Пишіть на [пошту](mailto:a@b.c)

1. Перше
2. Друге

Використовуємо [Сервіс] для аналітики.
`;

test('renders headings, lists, bold, links and marks placeholders', () => {
  const html = render(MD);
  assert.ok(html.includes('<h1>Політика</h1>'));
  assert.ok(html.includes('<li><strong>При оплаті:</strong> сума &amp; дата</li>'));
  assert.ok(html.includes('<a href="mailto:a@b.c">пошту</a>'));
  assert.ok(html.includes('<ol>\n<li>Перше</li>\n<li>Друге</li>\n</ol>'));
  assert.equal(placeholders(html), 1);
});

test('drops unsafe link targets and escapes html', () => {
  const html = render('[x](javascript:alert(1)) <script>');
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('htmlToMd takes a rendered page back to the same markdown', () => {
  const page = `<html><body><article>\n${render(MD)}\n</article></body></html>`;
  assert.equal(render(htmlToMd(page)), render(MD));
});
