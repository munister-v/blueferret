/* Blue Ferret Site Enhancements */

// ── Missing-chunk workaround ──
// Some route client bundles wait on webpack chunk ids 8441/7358 before they will
// hydrate real content (e.O(0,[...,8441,...], cb)) — they were never captured
// during the original site migration (source lost, see repo README) and no
// shipped chunk anywhere actually imports from it (grepped every chunk file:
// zero direct module calls for these ids). Routes whose main content is server-rendered are
// unaffected, but any route that bails out to client-only rendering (uses
// useSearchParams, e.g. /igry/) hangs forever on the loading fallback
// waiting for a chunk that will never arrive. Since nothing consumes its
// exports, satisfying the wait with an empty stub is safe — this just marks
// those chunk ids "loaded" so webpack's pending callbacks can fire.
(function () {
  (self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([[8441, 7358], {}]);
})();

(function () {
  'use strict';

  // ── Scroll progress bar ──
  const prog = document.createElement('div');
  prog.id = 'bf-scroll-progress';
  document.body.prepend(prog);

  // ── Back to top ──
  const top = document.createElement('button');
  top.id = 'bf-back-top';
  top.innerHTML = '↑';
  top.setAttribute('aria-label', 'Вгору');
  top.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.appendChild(top);

  // ── Scroll handler ──
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const s = window.scrollY;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      // progress bar
      prog.style.transform = `scaleX(${h > 0 ? s / h : 0})`;
      // back to top
      top.classList.toggle('show', s > 400);
      // header shadow
      const hdr = document.querySelector('header');
      if (hdr) hdr.classList.toggle('scrolled', s > 20);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── IntersectionObserver for scroll animations ──
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  // Elements to animate on scroll
  const SELECTORS = [
    // Section headings
    'h2:not([class*="heading-2"])',
    // Cards
    '[class*="rounded-2xl"][class*="border-2"]',
    '[class*="rounded-2xl"][class*="shadow"]',
    // Sections
    'section > div > div',
    // Footer blocks
    'footer [class*="col-span"]',
  ];

  function initAnimations() {
    // Already animated elements (have inline opacity:0 transform) — handled by existing code
    // Add bf-reveal to new elements that don't already have animation
    const allEls = document.querySelectorAll(SELECTORS.join(','));
    let delay = 0;

    allEls.forEach(el => {
      // Skip if already has a visibility style set or is in nav/header
      if (
        el.closest('header') ||
        el.closest('nav') ||
        el.closest('#mobile-site-nav') ||
        el.getAttribute('style')?.includes('opacity') ||
        el.classList.contains('bf-reveal') ||
        el.classList.contains('bf-reveal-done')
      ) return;

      // Check if it's in viewport already
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.top > 0) {
        // Already in view — animate quickly
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = `opacity .5s ease ${delay}ms, transform .5s cubic-bezier(.22,1,.36,1) ${delay}ms`;
        delay += 50;
        setTimeout(() => {
          el.style.opacity = '';
          el.style.transform = '';
          el.classList.add('bf-reveal-done');
        }, 50 + delay);
      } else if (rect.top >= window.innerHeight) {
        // Below viewport — add reveal class
        el.classList.add('bf-reveal');
        io.observe(el);
      }
    });

    // Footer elements
    const footerEls = document.querySelectorAll('footer [class*="col-span"], footer h3, footer h4, footer ul, footer [class*="space-y"]');
    footerEls.forEach((el, i) => {
      if (!el.classList.contains('bf-reveal')) {
        el.classList.add('bf-reveal');
        el.style.transitionDelay = `${i * 80}ms`;
        io.observe(el);
      }
    });
  }

  // ── Mobile menu enhancements ──
  function enhanceMenu() {
    const nav = document.getElementById('mobile-site-nav');
    if (!nav) return;

    // Add subtle entry animation enhancement
    nav.style.transition = 'box-shadow .3s ease';

    // Add ripple to menu links
    nav.querySelectorAll('a').forEach(link => {
      link.classList.add('bf-ripple');
    });

    // Close menu on outside tap (enhance existing behavior)
    const closeBtn = document.querySelector('[aria-label="Відкрити меню"]');
    if (closeBtn) {
      // Already has aria-expanded handling
    }
  }

  // ── Mobile menu observer ──
  const menuObs = new MutationObserver(() => {
    const nav = document.getElementById('mobile-site-nav');
    if (nav) { enhanceMenu(); menuObs.disconnect(); }
  });
  menuObs.observe(document.body, { childList: true, subtree: true });

  // ── Dynamic opacity:0 reveal (mobile menu, and anything else mounted after
  //    load) ── nginx's sub_filter forces visible any whileInView element
  //    already present in the server-rendered HTML (framer-motion leaves
  //    them at opacity:0 under React 19 — source lost, can't rebuild), but
  //    the mobile-nav panel and its backdrop are NOT in that HTML at all —
  //    React only inserts them after the hamburger button is clicked, so
  //    nginx never gets a chance to touch them. Tapping the button toggles
  //    state and the panel does mount, it's just invisible — looks like
  //    "nothing happens". Runs on every open (unlike the one-shot observer
  //    above), since the panel unmounts/remounts each time.
  function revealStuckOpacity(root) {
    root.querySelectorAll('[style*="opacity:0"],[style*="opacity: 0"]').forEach((el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }
  const revealObs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.getAttribute?.('style')?.includes('opacity:0') || node.getAttribute?.('style')?.includes('opacity: 0')) {
          node.style.opacity = '1';
          node.style.transform = 'none';
        }
        revealStuckOpacity(node);
      });
    }
  });
  revealObs.observe(document.body, { childList: true, subtree: true });

  // ── "Наші ігри" desktop nav fix ──
  // The desktop header dropdown only opens on hover (onMouseEnter/onMouseLeave),
  // with no click handler on the trigger <button>. Mouse users are fine, but
  // touch devices at md+ viewport width (iPad and similar tablets, which get
  // the desktop nav, not the mobile hamburger) have no hover — tapping the
  // button does nothing. Give the trigger a real click target: navigate to
  // the games catalog, same as its "all games" dropdown item and the mobile
  // nav link already do. Hover-to-reveal-submenu keeps working for mouse users.
  function fixGamesNavButton() {
    document.querySelectorAll('header button').forEach((btn) => {
      if (btn.dataset.bfGamesFixed) return;
      if (!btn.textContent.trim().startsWith('Наші ігри')) return;
      btn.dataset.bfGamesFixed = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = '/igry/';
      });
    });
  }

  // ── Mobile hamburger fallback ──
  // Some pages are served from a captured Next.js build. If hydration stalls,
  // the SSR hamburger button remains visible but has no React click handler.
  // This fallback owns the mobile menu interaction in plain DOM, so the menu
  // works even when the original client bundle does not finish mounting.
  function ensureFallbackMobileMenu() {
    let menu = document.getElementById('bf-mobile-menu-fallback');
    if (menu) return menu;

    menu = document.createElement('div');
    menu.id = 'bf-mobile-menu-fallback';
    menu.hidden = true;
    menu.innerHTML = `
      <button class="bf-mm-backdrop" type="button" aria-label="Закрити меню" data-bf-close-menu></button>
      <aside class="bf-mm-panel" role="dialog" aria-modal="true" aria-label="Мобільне меню Blue Ferret">
        <div class="bf-mm-head">
          <strong>Blue Ferret</strong>
          <button type="button" aria-label="Закрити меню" data-bf-close-menu>×</button>
        </div>
        <nav class="bf-mm-links" aria-label="Мобільна навігація">
          <a href="/">Головна</a>
          <a href="/igry/">Наші ігри</a>
          <a href="/kik/">KIK вдома</a>
          <a href="/kontakty/">Контакти</a>
        </nav>
        <a class="bf-mm-kik" href="/kik/">
          <span>KIK вдома</span>
          <small>Підтримка авторських настільних ігор</small>
        </a>
      </aside>
    `;
    document.body.appendChild(menu);

    menu.querySelectorAll('[data-bf-close-menu]').forEach((el) => {
      el.addEventListener('click', closeFallbackMobileMenu);
    });
    menu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeFallbackMobileMenu);
    });

    return menu;
  }

  function setHamburgerExpanded(expanded) {
    document.querySelectorAll('button[aria-controls="mobile-site-nav"], button[aria-label="Відкрити меню"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  function openFallbackMobileMenu() {
    const menu = ensureFallbackMobileMenu();
    menu.hidden = false;
    requestAnimationFrame(() => {
      menu.classList.add('is-open');
      document.documentElement.classList.add('bf-mobile-menu-open');
      setHamburgerExpanded(true);
      menu.querySelector('a')?.focus({ preventScroll: true });
    });
  }

  function closeFallbackMobileMenu() {
    const menu = document.getElementById('bf-mobile-menu-fallback');
    if (!menu) return;
    menu.classList.remove('is-open');
    document.documentElement.classList.remove('bf-mobile-menu-open');
    setHamburgerExpanded(false);
    window.setTimeout(() => {
      if (!menu.classList.contains('is-open')) menu.hidden = true;
    }, 220);
  }

  function initMobileMenuFallback() {
    document.querySelectorAll('button[aria-controls="mobile-site-nav"], button[aria-label="Відкрити меню"]').forEach((btn) => {
      if (btn.dataset.bfMobileFallback) return;
      btn.dataset.bfMobileFallback = '1';
      btn.setAttribute('aria-controls', 'bf-mobile-menu-fallback');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFallbackMobileMenu();
      }, true);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFallbackMobileMenu();
  });

  // ── Image load fade ──
  function initImages() {
    document.querySelectorAll('img[loading="lazy"]').forEach(img => {
      if (!img.complete) {
        img.style.opacity = '0';
        img.style.transition = 'opacity .4s ease';
        img.addEventListener('load', () => { img.style.opacity = ''; }, { once: true });
      }
    });
  }

  function polishGamesCatalog() {
    if (!/^\/igry\/?$/.test(window.location.pathname)) return;

    document.querySelectorAll('a[href="/igry/trymaysia/"], a[href$="/igry/trymaysia/"]').forEach(card => {
      const img = card.querySelector('img');
      if (!img) return;
      if ((img.getAttribute('src') || '').includes('box-front-v6.png')) {
        img.setAttribute('src', '/images/trymaysia/box-front-center-v11.jpg');
      }
      img.style.objectFit = 'contain';
      img.style.objectPosition = 'center';
      img.style.padding = '10px 12px 0';
      img.style.background = '#263d57';
    });
  }

  // ── Button ripple on all CTA buttons ──
  function initRipples() {
    document.querySelectorAll('button, a[class*="btn"], a[class*="rounded-xl"][class*="bg-"]').forEach(el => {
      if (!el.classList.contains('bf-ripple')) el.classList.add('bf-ripple');
    });
  }

  // ── Run after DOM ready ──
  function init() {
    initAnimations();
    initImages();
    polishGamesCatalog();
    initRipples();
    fixGamesNavButton();
    initMobileMenuFallback();
    // Re-run after a short delay to catch dynamically rendered content
    setTimeout(() => {
      initAnimations();
      polishGamesCatalog();
      initRipples();
      fixGamesNavButton();
      initMobileMenuFallback();
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-run on visibility change (tab switch back)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(initAnimations, 100);
  });

})();
