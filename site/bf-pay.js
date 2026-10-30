/* Blue Ferret, support-page payment UI (loaded from bf.js on /kik/proekty/*).
 *
 * Adds, without touching the prerendered Next bundle:
 *   - a "how the campaign works" panel above the reward cards (what is charged,
 *     what happens if the goal is missed, who processes the card, links to the
 *     offer and refund terms);
 *   - an honest inactive state: while the server has no payment token the
 *     "Підтримати" buttons read "Скоро" with a lock instead of looking broken;
 *   - a "back from payment" notice on /kik/proekty/?payment=...
 * The real buttons and the payment call stay in the site's own client code.
 */
(function () {
  'use strict';

  var LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var CSS = [
    '.bf-pay{margin:0 0 20px;border:1px solid rgba(75,178,114,.28);border-radius:24px;background:#fff;padding:22px;box-shadow:0 20px 46px -34px rgba(15,23,42,.35)}',
    '@media(min-width:640px){.bf-pay{padding:28px}}',
    '.bf-pay{text-align:center}',
    '.bf-pay-head{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:12px}',
    // same face as the page title (h1): Inter 800, tight tracking
    '.bf-pay h2{margin:0;font-family:inherit;font-size:22px;font-weight:800;letter-spacing:.01em;color:#0f172a}',
    // the page title is Inter on the whole site; on the support page it follows the main font like the headings under it
    'html:has(#bf-pay) main h1{font-family:inherit!important;letter-spacing:.01em!important}',
    '.bf-pay-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid}',
    '.bf-pay-chip.on{background:#4BB27218;color:#2f8a52;border-color:#4BB27240}',
    '.bf-pay-chip.off{background:#f59e0b18;color:#b45309;border-color:#f59e0b45}',
    '.bf-pay-bar{height:8px;border-radius:99px;background:#e2e8f0;overflow:hidden;margin:6px auto 6px;max-width:520px}',
    '.bf-pay-bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#4BB272,#34d399)}',
    '.bf-pay-sum{font-size:14px;color:#475569;margin:0 0 18px}',
    '.bf-pay-steps{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:1fr 1fr}',
    '@media(min-width:980px){.bf-pay-steps{grid-template-columns:repeat(4,1fr);gap:12px}}',
    '.bf-pay-steps li{border:1px solid #e2e8f0;border-radius:18px;padding:14px 12px;background:linear-gradient(180deg,#fff,#f8fafc);font-size:13px;line-height:1.45;color:#475569}',
    '@media(min-width:640px){.bf-pay-steps li{padding:18px 14px;font-size:14px;line-height:1.5}}',
    '.bf-pay-steps b{display:block;color:#0f172a;margin-bottom:2px;font-size:14px}',
    '.bf-pay-steps .n{display:inline-flex;width:22px;height:22px;border-radius:99px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;align-items:center;justify-content:center;margin:0 auto 8px}',
    '.bf-pay-promise{margin:16px auto 0;max-width:640px;padding:12px 14px;border-radius:14px;background:#4BB2720f;border:1px solid #4BB27230;font-size:14px;line-height:1.55;color:#14532d}',
    '.bf-pay-foot{margin:12px auto 0;max-width:560px;font-size:13px;line-height:1.55;color:#64748b}',
    '.bf-pay-foot a,.bf-pay-consent a{color:#2f8a52;font-weight:600;text-decoration:underline;text-underline-offset:2px;display:inline-block;padding:6px 0}',
    '.bf-pay-consent{margin:14px auto 0;max-width:560px;text-align:center;font-size:13px;color:#64748b;line-height:1.55}',
    // the support page, centered: title block, set cards
    'html:has(#bf-pay) main h1,html:has(#bf-pay) main h1+p{text-align:center}',
    'html:has(#bf-pay) main div:has(>div>h1){flex-direction:column;align-items:center;text-align:center}',
    'html:has(#bf-pay) main div:has(>div>h1)>a{align-self:center}',
    'html:has(#bf-pay) main .grid.gap-4>div>div{flex-direction:column;align-items:center;text-align:center}',
    'html:has(#bf-pay) main .grid.gap-4>div>div>div{margin-left:auto;margin-right:auto}',
    'html:has(#bf-pay) main .grid.gap-4 ul li{justify-content:center}',
    'html:has(#bf-pay) main .grid.gap-4>div>div>div:last-child{justify-content:center}',
    '.bf-pay-off button:disabled{background:#0f172a!important;color:#fff!important;opacity:.55!important;gap:8px}',
    // preorder form
    '#bf-pre{position:fixed;inset:0;z-index:90;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.55);padding:0;overflow-y:auto}',
    '@media(min-width:640px){#bf-pre{align-items:center;padding:24px}}',
    '#bf-pre form,#bf-pre .bf-pre-done{position:relative;width:100%;max-width:480px;background:#fff;border-radius:24px 24px 0 0;padding:24px 20px 28px;box-shadow:0 30px 80px -20px rgba(15,23,42,.6);max-height:100dvh;overflow-y:auto;text-align:left}',
    '@media(min-width:640px){#bf-pre form,#bf-pre .bf-pre-done{border-radius:24px;padding:28px}}',
    '#bf-pre h3{margin:0 36px 4px 0;font-size:20px;font-weight:800;color:#0f172a}',
    '#bf-pre .sub{margin:0 0 16px;font-size:14px;color:#475569;line-height:1.5}',
    '#bf-pre label{display:block;margin:0 0 12px;font-size:13px;font-weight:600;color:#334155}',
    '#bf-pre input,#bf-pre select,#bf-pre textarea{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:12px 13px;border:1px solid #cbd5e1;border-radius:12px;font:inherit;font-size:16px;font-weight:400;color:#0f172a;background:#fff}',
    '#bf-pre textarea{min-height:68px;resize:vertical}',
    '#bf-pre input:focus,#bf-pre select:focus,#bf-pre textarea:focus{outline:2px solid #4BB272;outline-offset:1px;border-color:#4BB272}',
    '#bf-pre .bad{border-color:#dc2626!important}',
    '#bf-pre .err{margin:0 0 10px;font-size:13px;color:#b91c1c;min-height:0}',
    '#bf-pre .row{display:grid;grid-template-columns:1fr 92px;gap:10px}',
    '#bf-pre .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
    '#bf-pre .go{width:100%;padding:14px;border:0;border-radius:14px;background:#0f172a;color:#fff;font:inherit;font-size:16px;font-weight:700;cursor:pointer}',
    '#bf-pre .go:disabled{opacity:.55;cursor:default}',
    '#bf-pre .x{position:absolute;top:10px;right:10px;width:44px;height:44px;border:0;background:none;font-size:26px;color:#64748b;cursor:pointer}',
    '#bf-pre .fine{margin:12px 0 0;font-size:12px;line-height:1.5;color:#64748b;text-align:center}',
    '#bf-pre .fine a{color:#2f8a52;text-decoration:underline}',
    '#bf-pre .bf-pre-done{text-align:center}',
    '#bf-pre .bf-pre-done p{margin:8px 0 18px;font-size:15px;line-height:1.55;color:#334155}',
    '.bf-pay-pre button[data-bf-pre]{cursor:pointer}',
    '#bf-pay-toast{position:fixed;left:12px;right:12px;bottom:20px;margin:0 auto;max-width:520px;display:flex;align-items:flex-start;gap:8px;z-index:80;background:#0f172a;color:#fff;border-radius:16px;padding:14px 18px;font-size:14px;line-height:1.5;box-shadow:0 18px 50px -12px rgba(15,23,42,.55)}',
    '#bf-pay-toast button{flex:none;margin:-6px -8px 0 0;width:40px;height:40px;background:none;border:0;color:#94a3b8;font-size:20px;cursor:pointer}'
  ].join('');

  function css() {
    if (document.getElementById('bf-pay-css')) return;
    var s = document.createElement('style'); s.id = 'bf-pay-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function money(n) { return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(n) + ' ₴'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function getJSON(u) { return fetch(u, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }); }

  // ---- back from the payment page ----
  var q = new URLSearchParams(location.search).get('payment');
  if (q && /^\/kik\/proekty\/?$/.test(location.pathname)) {
    // React re-renders the whole document when it hydrates (the site-wide #418), which would wipe a
    // node added too early, so wait for the page to settle first.
    var showToast = function () {
      css();
      var t = document.createElement('div'); t.id = 'bf-pay-toast'; t.setAttribute('role', 'status');
      t.innerHTML = '<span><b>Дякуємо!</b> Якщо платіж пройшов, сума з’явиться за кілька хвилин. Якщо ні, спробуйте ще раз: гроші не списані.</span><button type="button" aria-label="Закрити">×</button>';
      t.querySelector('button').onclick = function () { t.remove(); };
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 20000);
      try { history.replaceState(history.state, '', location.pathname); } catch (e) { /* ignore */ }
    };
    var go = function () { setTimeout(showToast, 1200); };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  }

  // ---- support page ----
  var m = location.pathname.match(/^\/kik\/proekty\/([^/]+)\/pidtrymaty\/?$/);
  if (!m) return;
  var id = decodeURIComponent(m[1]);

  function support(btns) {
    for (var i = 0; i < btns.length; i++) if (/^\s*(Підтримати|Передзамовити)\s*$/.test(btns[i].textContent)) return btns[i];
    return null;
  }

  function render(enabled, project, pre) {
    var first = support(document.querySelectorAll('main button'));
    var wrap = first && first.closest('.space-y-5');
    if (!wrap || document.getElementById('bf-pay')) return;
    css();

    var bar = '';
    if (project && project.goal > 0) {
      var pct = Math.max(0, Math.min(100, project.raised / project.goal * 100));
      bar = '<div class="bf-pay-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><i style="width:' + pct + '%"></i></div>' +
        '<p class="bf-pay-sum">Зібрано <b>' + money(project.raised) + '</b> із ' + money(project.goal) + '</p>';
    }
    var chip = pre
      ? '<span class="bf-pay-chip on">● Приймаємо заявки</span>'
      : enabled
        ? '<span class="bf-pay-chip on">● Оплата працює</span>'
        : '<span class="bf-pay-chip off">' + LOCK + ' Оплата скоро відкриється</span>';

    var panel = document.createElement('section');
    panel.id = 'bf-pay'; panel.className = 'bf-pay';
    panel.setAttribute('aria-label', 'Як працює збір');
    panel.innerHTML =
      '<div class="bf-pay-head"><h2>Як працює збір</h2>' + chip + '</div>' + bar +
      (pre
        ? '<ol class="bf-pay-steps">' +
          '<li><span class="n">1</span><b>Заявка</b>Обираєте набір, лишаєте ім’я, телефон і адресу.</li>' +
          '<li><span class="n">2</span><b>Без оплати</b>Зараз гроші не беремо і картку не просимо.</li>' +
          '<li><span class="n">3</span><b>Рахунок</b>Ближче до ' + esc(pre.invoiceDate) + ' надішлемо посилання на оплату в monobank.</li>' +
          '<li><span class="n">4</span><b>Гра</b>Ціль зібрана: робимо гру й відправляємо вам.</li>' +
          '</ol>' +
          '<p class="bf-pay-promise"><b>Передумали?</b> Просто не оплачуйте рахунок: заявка нічого не коштує і ні до чого не зобов’язує.</p>' +
          '<p class="bf-pay-foot">Дані потрібні лише для цього замовлення. <a href="/konfidentsiinist/">Конфіденційність</a></p>'
        : '<ol class="bf-pay-steps">' +
          '<li><span class="n">1</span><b>Оплата карткою</b>Списується одразу, через monobank.</li>' +
          '<li><span class="n">2</span><b>Збір до цілі</b>Ціль і дату видно на сторінці проєкту.</li>' +
          '<li><span class="n">3</span><b>Ціль зібрана</b>Робимо гру й відправляємо вам.</li>' +
          '<li><span class="n">4</span><b>Ціль не зібрана</b>Повертаємо гроші, крім комісії банку.</li>' +
          '</ol>' +
          '<p class="bf-pay-promise"><b>Не зберемо ціль?</b> Гроші повернуться на картку за 14 робочих днів. Комісію банку не повертаємо: її утримує сам банк.</p>' +
          '<p class="bf-pay-foot">Платіж обробляє monobank, номера картки ми не бачимо. Докладніше: <a href="/povernennia/">повернення коштів</a> · <a href="/konfidentsiinist/">конфіденційність</a></p>');
    wrap.parentNode.insertBefore(panel, wrap);

    var consent = document.createElement('p');
    consent.className = 'bf-pay-consent';
    consent.innerHTML = pre
      ? 'Заявка не є оплатою. Рахунок надійде окремо.'
      : 'Натискаючи «Підтримати», ви погоджуєтеся з <a href="/oferta/">офертою</a> та <a href="/povernennia/">умовами повернення</a>.';
    wrap.parentNode.insertBefore(consent, wrap.nextSibling);
  }

  // Buttons are React-owned; (re)apply the inactive look whenever it is missing.
  function lockButtons(wrap) {
    wrap.classList.add('bf-pay-off');
    var btns = wrap.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-bf-lock') === '1' || !/^\s*Підтримати\s*$/.test(b.textContent)) continue;
      b.setAttribute('data-bf-lock', '1');
      b.disabled = true; // really inactive, not only styled so (React owns the attribute, but only rewrites it on a state change)
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Онлайн-оплата відкривається найближчим часом';
      b.innerHTML = LOCK + '<span>Скоро</span>';
    }
  }

  // ---- preorder: a request form instead of a payment ----
  function amountOf(btn) {
    var n = btn;
    for (var i = 0; n && i < 8; i++, n = n.parentElement) {
      var m1 = /(\d[\d\s  ]*)\s*₴/.exec(n.textContent || '');
      if (m1) return Number(m1[1].replace(/\D/g, ''));
    }
    return 0;
  }
  function preButtons(wrap) {
    wrap.classList.add('bf-pay-pre');
    var btns = wrap.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-bf-pre') === '1' || !/^\s*(Підтримати|Скоро)\s*$/.test(b.textContent)) continue;
      b.setAttribute('data-bf-pre', '1');
      b.disabled = false; b.removeAttribute('aria-disabled'); b.removeAttribute('title');
      b.textContent = 'Передзамовити';
    }
  }
  var preInfo = null, preAmount = 0, preOpener = null;
  function closePre() {
    var d = document.getElementById('bf-pre');
    if (d) d.remove();
    document.removeEventListener('keydown', onKey, true);
    if (preOpener && preOpener.focus) try { preOpener.focus(); } catch (e) { /* ignore */ }
  }
  function onKey(e) { if (e.key === 'Escape') closePre(); }
  function openPre(btn) {
    if (!preInfo || document.getElementById('bf-pre')) return;
    css();
    preOpener = btn; preAmount = amountOf(btn);
    var opts = preInfo.tiers.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (Number(t.amount) === preAmount ? ' selected' : '') + '>' + esc(t.title) + ', ' + money(t.amount) + '</option>';
    }).join('');
    var d = document.createElement('div');
    d.id = 'bf-pre'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'bf-pre-h');
    d.innerHTML =
      '<form novalidate autocomplete="on">' +
      '<button type="button" class="x" aria-label="Закрити">×</button>' +
      '<h3 id="bf-pre-h">Передзамовлення</h3>' +
      '<p class="sub">Оплата не потрібна. Рахунок надішлемо ближче до ' + esc(preInfo.invoiceDate) + '.</p>' +
      '<div class="row"><label>Набір<select name="tierId">' + opts + '</select></label>' +
      '<label>К-сть<input name="qty" type="number" inputmode="numeric" min="1" max="10" value="1"></label></div>' +
      '<label>Ім’я та прізвище<input name="name" autocomplete="name" maxlength="80" required></label>' +
      '<label>Телефон<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0XX XXX XX XX" maxlength="20" required></label>' +
      '<label>Місто<input name="city" autocomplete="address-level2" maxlength="80"></label>' +
      '<label>Адреса доставки<textarea name="address" autocomplete="street-address" maxlength="240" placeholder="Вулиця, будинок, квартира або відділення Нової пошти" required></textarea></label>' +
      '<label>Пошта (необов’язково)<input name="email" type="email" autocomplete="email" maxlength="120"></label>' +
      '<div class="hp" aria-hidden="true"><label>Сайт<input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<p class="err" role="alert"></p>' +
      '<button type="submit" class="go">Надіслати заявку</button>' +
      '<p class="fine">Натискаючи кнопку, ви погоджуєтеся на обробку даних для цього замовлення. <a href="/konfidentsiinist/">Конфіденційність</a></p>' +
      '</form>';
    document.body.appendChild(d);
    document.addEventListener('keydown', onKey, true);
    d.addEventListener('mousedown', function (e) { if (e.target === d) closePre(); });
    var f = d.querySelector('form'), err = d.querySelector('.err'), go = d.querySelector('.go');
    d.querySelector('.x').onclick = closePre;
    f.name.focus();
    f.addEventListener('input', function (e) { if (e.target.classList) e.target.classList.remove('bad'); err.textContent = ''; });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = {}; ['tierId', 'qty', 'name', 'phone', 'city', 'address', 'email', 'website'].forEach(function (k) { v[k] = f.elements[k].value; });
      v.projectId = id;
      go.disabled = true; go.textContent = 'Надсилаємо…';
      fetch('/api/preorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (r.ok) {
            d.innerHTML = '<div class="bf-pre-done"><h3 style="margin:0 0 6px">Заявку прийнято</h3>' +
              '<p>Дякуємо! Рахунок на оплату надішлемо ближче до ' + esc(preInfo.invoiceDate) + '. Гроші зараз не списані.</p>' +
              '<button type="button" class="go">Закрити</button></div>';
            d.querySelector('.go').onclick = closePre; d.querySelector('.go').focus();
            return;
          }
          go.disabled = false; go.textContent = 'Надіслати заявку';
          err.textContent = (r.j && r.j.error) || 'Не вдалося надіслати. Спробуйте ще раз.';
          var bad = r.j && r.j.field && f.elements[r.j.field === 'tier' ? 'tierId' : r.j.field];
          if (bad) { bad.classList.add('bad'); bad.focus(); }
        })
        .catch(function () { go.disabled = false; go.textContent = 'Надіслати заявку'; err.textContent = 'Немає зв’язку. Перевірте інтернет і спробуйте ще раз.'; });
    });
  }
  // React owns these buttons: catch the click before its handler and open the form instead.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-bf-pre="1"]');
    if (!b || !preInfo) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openPre(b);
  }, true);

  var state = null;
  function ensure() {
    if (!state) return;
    render(state.enabled, state.project, state.pre);
    if (state.pre) {
      var pf = support(document.querySelectorAll('main button')) || document.querySelector('main button[data-bf-pre="1"]');
      var pw = pf && pf.closest('.space-y-5');
      if (pw) preButtons(pw);
    } else if (!state.enabled) {
      var first = support(document.querySelectorAll('main button'));
      var wrap = first && first.closest('.space-y-5');
      if (wrap) lockButtons(wrap);
    }
  }

  Promise.all([
    getJSON('/api/mono/status').catch(function () { return { enabled: false }; }),
    getJSON('/api/public/kik').catch(function () { return []; }),
    getJSON('/api/preorder/info?project=' + encodeURIComponent(id)).catch(function () { return { enabled: false }; })
  ]).then(function (r) {
    var project = null;
    for (var i = 0; i < r[1].length; i++) if (r[1][i].id === id) project = r[1][i];
    var pi = r[2] && r[2].enabled && r[2].tiers && r[2].tiers.length ? r[2] : null;
    if (pi) { pi.invoiceDate = pi.invoiceDate || 'початку грудня'; preInfo = pi; }
    state = { enabled: !!r[0].enabled, project: project, pre: pi };
    // Not before hydration has finished (see bf.js); then re-check for a few
    // seconds in case React replaced the section while recovering.
    var go = function () { var n = 0, iv = setInterval(function () { ensure(); if (++n > 12) clearInterval(iv); }, 600); };
    if (document.readyState === 'complete') setTimeout(go, 400); else window.addEventListener('load', function () { setTimeout(go, 400); });
  });
})();
