/* Blue Ferret — support-page payment UI (loaded from bf.js on /kik/proekty/*).
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
    '.bf-pay-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;justify-content:space-between;margin-bottom:6px}',
    // same face as the page title (h1): Inter 800, tight tracking
    '.bf-pay h2{margin:0;font-family:inherit;font-size:22px;font-weight:800;letter-spacing:.01em;color:#0f172a;display:flex;align-items:center;gap:8px}',
    // the page title is Inter on the whole site; on the support page it follows the main font like the headings under it
    'html.bf-support main h1{font-family:inherit!important;letter-spacing:.01em!important}',
    '.bf-pay-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid}',
    '.bf-pay-chip.on{background:#4BB27218;color:#2f8a52;border-color:#4BB27240}',
    '.bf-pay-chip.off{background:#f59e0b18;color:#b45309;border-color:#f59e0b45}',
    '.bf-pay-bar{height:8px;border-radius:99px;background:#e2e8f0;overflow:hidden;margin:10px 0 4px}',
    '.bf-pay-bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#4BB272,#34d399)}',
    '.bf-pay-sum{font-size:14px;color:#475569;margin:0 0 14px}',
    '.bf-pay-steps{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:1fr 1fr}',
    '@media(min-width:980px){.bf-pay-steps{grid-template-columns:repeat(4,1fr);gap:12px}}',
    '.bf-pay-steps li{border:1px solid #e2e8f0;border-radius:16px;padding:12px;background:#f8fafc;font-size:13px;line-height:1.45;color:#475569}',
    '@media(min-width:640px){.bf-pay-steps li{padding:14px;font-size:14px;line-height:1.5}}',
    '.bf-pay-steps b{display:block;color:#0f172a;margin-bottom:2px;font-size:14px}',
    '.bf-pay-steps .n{display:inline-flex;width:22px;height:22px;border-radius:99px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;align-items:center;justify-content:center;margin-bottom:8px}',
    '.bf-pay-promise{margin:14px 0 0;padding:12px 14px;border-radius:14px;background:#4BB2720f;border:1px solid #4BB27230;font-size:14px;line-height:1.55;color:#14532d}',
    '.bf-pay-foot{margin:12px 0 0;font-size:13px;line-height:1.55;color:#64748b}',
    '.bf-pay-foot a,.bf-pay-consent a{color:#2f8a52;font-weight:600;text-decoration:underline;text-underline-offset:2px;display:inline-block;padding:6px 0}',
    '.bf-pay-consent{margin:14px 4px 0;font-size:13px;color:#64748b;line-height:1.55}',
    '.bf-pay-off button:disabled{background:#0f172a!important;color:#fff!important;opacity:.55!important;gap:8px}',
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
      t.innerHTML = '<span><b>Дякуємо!</b> Якщо платіж пройшов, сума з’явиться на сторінці за кілька хвилин, а підтвердження — у вашому банку. Якщо оплата не вдалася, просто спробуйте ще раз: гроші не списані.</span><button type="button" aria-label="Закрити">×</button>';
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
  document.documentElement.classList.add('bf-support');

  function support(btns) {
    for (var i = 0; i < btns.length; i++) if (/^\s*Підтримати\s*$/.test(btns[i].textContent)) return btns[i];
    return null;
  }

  function render(enabled, project) {
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
    var chip = enabled
      ? '<span class="bf-pay-chip on">● Онлайн-оплата працює</span>'
      : '<span class="bf-pay-chip off">' + LOCK + ' Онлайн-оплата відкривається найближчим часом</span>';

    var panel = document.createElement('section');
    panel.id = 'bf-pay'; panel.className = 'bf-pay';
    panel.setAttribute('aria-label', 'Як працює збір');
    panel.innerHTML =
      '<div class="bf-pay-head"><h2>Як працює збір</h2>' + chip + '</div>' + bar +
      '<ol class="bf-pay-steps">' +
      '<li><span class="n">1</span><b>Оплата карткою</b>Сума списується одразу на захищеній сторінці monobank. Це не «заморожування» коштів.</li>' +
      '<li><span class="n">2</span><b>Збір до цілі</b>Ціль і дата завершення вказані на сторінці проєкту й не змінюються під час збору.</li>' +
      '<li><span class="n">3</span><b>Ціль зібрана</b>Виготовляємо гру й відправляємо нагороду — примірник гри, який ви обрали.</li>' +
      '<li><span class="n">4</span><b>Ціль не зібрана</b>Автоматично повертаємо на вашу картку суму платежу без комісії банку.</li>' +
      '</ol>' +
      '<p class="bf-pay-promise"><b>Наша обіцянка:</b> якщо до дати завершення збору ціль не набрана, ви отримаєте гроші назад на ту саму картку протягом 10 робочих днів. <b>Комісію банку за обробку платежу ми не повертаємо</b>: банк утримує її при оплаті й не віддає навіть при поверненні, тому з вашої суми віднімається тільки вона.</p>' +
      '<p class="bf-pay-foot">Платіж обробляє monobank. Номер вашої картки ми не бачимо і не зберігаємо. Докладно: <a href="/povernennia/">повернення коштів</a>, <a href="/konfidentsiinist/">конфіденційність</a>.</p>';
    wrap.parentNode.insertBefore(panel, wrap);

    var consent = document.createElement('p');
    consent.className = 'bf-pay-consent';
    consent.innerHTML = 'Натискаючи «Підтримати», ви погоджуєтеся з <a href="/oferta/">публічною офертою</a> та <a href="/povernennia/">умовами повернення коштів</a>.';
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

  var state = null;
  function ensure() {
    if (!state) return;
    render(state.enabled, state.project);
    if (!state.enabled) {
      var first = support(document.querySelectorAll('main button'));
      var wrap = first && first.closest('.space-y-5');
      if (wrap) lockButtons(wrap);
    }
  }

  Promise.all([
    getJSON('/api/mono/status').catch(function () { return { enabled: false }; }),
    getJSON('/api/public/kik').catch(function () { return []; })
  ]).then(function (r) {
    var project = null;
    for (var i = 0; i < r[1].length; i++) if (r[1][i].id === id) project = r[1][i];
    state = { enabled: !!r[0].enabled, project: project };
    // Not before hydration has finished (see bf.js); then re-check for a few
    // seconds in case React replaced the section while recovering.
    var go = function () { var n = 0, iv = setInterval(function () { ensure(); if (++n > 12) clearInterval(iv); }, 600); };
    if (document.readyState === 'complete') setTimeout(go, 400); else window.addEventListener('load', function () { setTimeout(go, 400); });
  });
})();
