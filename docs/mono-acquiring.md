# monobank acquiring (KIK)

Model: money is **charged immediately** (`paymentType: debit`). If a campaign misses its goal, every
paid pledge is refunded with `invoice/cancel`. (A `hold` lasts only 9 days in monobank's API, so it
cannot cover a month-long campaign. monobank does **not** return its acquiring commission on a refund,
and we do not pass it back either: a refund is the amount paid **minus the commission of that payment**
(`paymentInfo.fee`, remembered per pledge). The offer, the refund terms and the panel on the support page say so.)

There is no "support without a reward" any more: only the reward sets can be bought, and the server
refuses an amount that is not one of the project's tier prices.

## What is in the repo

| File | What |
|---|---|
| `src/mono.js` | API client (`X-Token`), webhook ECDSA verification with cached public key |
| `src/pledges.js` | table `kik_pledges`, state machine, reconcile, refunds, catalog deltas |
| `src/mono-routes.js` | `POST /api/mono/invoice`, `POST /api/mono/webhook`, `GET /api/mono/status`; admin: `GET /api/admin/pledges?project=`, `POST /api/admin/pledges/refund`, `POST /api/admin/pledges/:id/refund` |
| `server.js` | `applyKikRaisedDeltas` (adds confirmed money to the catalog `raised`), `POST /api/admin/kik-projects/:id/open-collection`, mounts the routes |
| `site/bf-pay.js` | "How the collection works" panel, the inactive "Скоро" button state, back-from-payment notice |
| `site/bf.js` | footer links to the legal pages on every page; loads `bf-pay.js` on `/kik/proekty/*` |
| `docs/legal/*.md` | offer, refund terms, privacy policy (templates) |
| `scripts/build-legal.js` | turns those into `/oferta/`, `/povernennia/`, `/konfidentsiinist/` (refuses leftover placeholders with `--strict`) |
| `scripts/enable-payments.js` | flips the build-time flag in the support-page bundle (and the prerendered buttons); `--revert` undoes it |
| `scripts/bump-asset.js` | cache-busts `bf.js?v=N` in every page |
| `scripts/remove-donation.js`, `src/donation.js` | takes the "Підтримка без нагороди" block off every support page (HTML, page text, client bundle); `open-collection` does the same for pages it builds |
| `scripts/deploy-mono.sh` | the three-part rollout below, dry-run by default |
| `tests/mono.test.js` | `npm test` |

`/api/` is already proxied by nginx to port 4100, so no nginx change is needed.

## Config (server only, never in git — the repo is public)

| Variable | Meaning |
|---|---|
| `MONO_API_TOKEN` | merchant token from the monobank acquiring cabinet. **Absent = payments off** (`/api/mono/invoice` answers 503, the site shows "Скоро") |
| `MONO_ALLOWED_PROJECTS` | e.g. `6`. Only these project ids can take money. **Set it at launch**: the live catalog also holds five demo projects (`1`–`5`, with invented raised amounts) that must never accept real payments |
| `PUBLIC_BASE_URL` | default `https://blueferret.com.ua`; used for the webhook and redirect URLs |
| `MONO_MAX_UAH` | cap for one payment, default 50000 |
| `MONO_FEE_PCT` | optional fallback commission in percent, used at refund time only for a pledge whose fee monobank never reported. Without it such a pledge is **not** refunded (`fee_unknown`) rather than refunded in full |
| `MONO_API_BASE` | default `https://api.monobank.ua` (tests point it at a fake) |

Set them in the pm2 environment on the server (not in `ecosystem.config.js`, which is committed):
`MONO_API_TOKEN=… MONO_ALLOWED_PROJECTS=6 pm2 restart blueferret-admin --update-env && pm2 save`.

## Behaviour worth knowing

- The server decides everything: project, minimum, amount limits, redirect and webhook URLs. From the
  client it only reads the amount and the project (taken from `reference`, as the current page sends it).
- Whole hryvnias only. Webhooks are verified by signature, deduplicated, ordered by `modifiedDate`,
  and a payment whose amount differs from the invoice is **not** counted (`mismatch`).
- `expired` never arrives by webhook: a 5-minute reconcile polls `invoice/status` for stuck invoices.
- `raised` in the catalog is updated by **delta**, so manual admin edits are respected. The site's
  runtime schema rejects `goal < raised` (it would blank `/kik/proekty/`), so the displayed `raised` is
  capped at the goal and the surplus is kept in the setting `kikOverflow`; refunds eat the surplus first.
- Publishing to the static pages is debounced (a few seconds) and skipped while an admin save is running.
- Refunds: `POST /api/admin/pledges/refund {projectId}` is a **dry run** (it shows `totalKop`, `feeKop`, `refundKop`, `unknownFee`; fees not yet known are asked from `invoice/status`); add `confirm: true` to execute. The cancel is sent with `amount = paid − fee`; the invoice keeps the fee, which is why a `reversed` state with exactly the fee left counts as refunded, while any other partial reversal is flagged for a human.
  Each refund has a stable `extRef` (`refund-<id>`), 429 is retried, failures are recorded and can be repeated.
  A `processing` refund is finished by the later `reversed` webhook or the reconcile.
- **Keep enough money on the FOP account until the campaign is closed.** Do not withdraw it. Every refund
  costs the acquiring commission that monobank keeps.
- The site pages show "14 робочих днів" for refunds (`site/bf-pay.js`, `docs/legal/*`): keep them in sync.

## Launch of "Нічка" (project id `6`)

Today every KIK project is hidden, and Нічка's support page was prerendered in the "збір ще не
стартував" state (no reward cards, no buttons). In order:

1. **Server code, payments still off.** `scripts/deploy-mono.sh --server` (dry run), then `--server --apply`.
   `GET https://blueferret.com.ua/api/mono/status` → `{"enabled":false}`.
2. **Legal pages.** Fill every `[PLACEHOLDER]` in `docs/legal/*.md` (FOP data, dates, terms) and have a
   lawyer look at it. `scripts/deploy-mono.sh --site` refuses to run while placeholders remain; then `--site --apply`.
   Send monobank the three URLs if they ask for site pages.
3. **Token.** After the FOP and the acquiring cabinet exist: set `MONO_API_TOKEN` and
   `MONO_ALLOWED_PROJECTS=6` in the pm2 env, restart. `…/api/mono/status` → `{"enabled":true}`.
4. **Open collection on Нічка's support page.** Logged in to `/admin/`, in the browser console:
   ```js
   fetch('/api/admin/kik-projects/6/open-collection', {method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({templateId:'1'})}).then(r => r.json()).then(console.log)
   ```
   It replaces only the support page, rebuilds the reward cards from Нічка's own tiers (title, description,
   price, bullets, badge, default amount), keeps a `.bak-…` copy and leaves the project's detail page alone.
   Edit Нічка's tiers in the admin first (`includes`, a second tier if wanted), then run it.
5. **Show it.** In the admin KIK editor: make Нічка visible; keep the five demo projects hidden (or delete
   them — their pages stay parked on disk).
6. **Switch the button on.** `scripts/deploy-mono.sh --enable-payments` (dry run) then `--apply`. It edits the
   support-page bundle (new hashed file, pages relinked) and removes the prerendered `disabled` from the
   buttons. Undo: `node scripts/enable-payments.js --root /var/www/blueferret --revert`.
7. **Real test.** Pay the cheapest set yourself, check that the pledge row has a `fee` (if monobank sends none, set `MONO_FEE_PCT`), watch the `audit` entries (`mono_*`) and `raised`, then
   `POST /api/admin/pledges/refund {projectId:'6', confirm:true}` and check the money comes back.

monobank questions still open: is a PRRO link needed (then `merchantPaymInfo.basketOrder` must be sent)?
Is there a test token? What exactly must the site show for approval?

## At the end of a campaign

- Goal reached: nothing to do for money; set the project status to `complete` in the admin.
- Goal missed: `POST /api/admin/pledges/refund {projectId}` (dry run shows count and total), then with
  `confirm:true`. Check `GET /api/admin/pledges?project=<id>` for `pendingRefund` and failures; repeat for the failed ones.

## Known gaps

- `src/db.js` has no migration for `games.box_faces` / `games.files`; a fresh database cannot boot
  `server.js` (the live DB has them). Only matters for a clean install.
- The site logs a React hydration warning (#418) on every page; it was there before this work.
