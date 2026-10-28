# monobank acquiring (KIK)

Model: money is **charged immediately** (`paymentType: debit`). If a campaign misses its goal, every
paid pledge is refunded with `invoice/cancel`. (A `hold` lasts only 9 days in monobank's API, so it
cannot cover a month-long campaign. The commission is **not** returned by monobank on refund — it is
the seller's cost; the offer text says so.)

## Moving parts

| File | What |
|---|---|
| `src/mono.js` | API client (`X-Token`), webhook ECDSA verification with cached public key |
| `src/pledges.js` | table `kik_pledges`, state machine, reconcile, refunds, catalog deltas |
| `src/mono-routes.js` | `POST /api/mono/invoice`, `POST /api/mono/webhook`, `GET /api/mono/status`, admin: `GET /api/admin/pledges?project=`, `POST /api/admin/pledges/refund`, `POST /api/admin/pledges/:id/refund` |
| `server.js` | `applyKikRaisedDeltas` (adds confirmed money to the catalog `raised`), mounts the routes |
| `tests/mono.test.js` | `npm test` — signature, state machine, refunds, reconcile |

`/api/` is already proxied by nginx to port 4100, so no nginx change is needed.

## Config (server only, never in git — the repo is public)

| Variable | Meaning |
|---|---|
| `MONO_API_TOKEN` | merchant token from the monobank acquiring cabinet. **Absent = payments off** (`/api/mono/invoice` answers 503) |
| `PUBLIC_BASE_URL` | default `https://blueferret.com.ua`; used for the webhook and redirect URLs |
| `MONO_MAX_UAH` | cap for one payment, default 50000 |
| `MONO_API_BASE` | default `https://api.monobank.ua` (tests point it at a fake) |

Set them in the pm2 environment on the server (not in `ecosystem.config.js`, which is committed):
`MONO_API_TOKEN=… pm2 restart blueferret-admin --update-env`.

## Behaviour worth knowing

- The server decides everything: project, minimum, amount limits, redirect and webhook URLs. From the
  client it only reads the amount and the project (taken from `reference`, as the current page sends it).
- Whole hryvnias only. Webhooks are verified by signature, deduplicated, ordered by `modifiedDate`,
  and a payment whose amount differs from the invoice is **not** counted (`mismatch`).
- `expired` never arrives by webhook: a 5-minute reconcile polls `invoice/status` for stuck invoices.
- `raised` in the catalog is updated by **delta**, so manual admin edits are respected. The site's
  runtime schema rejects `goal < raised`, so the displayed `raised` is capped at the goal and the
  surplus is kept in the setting `kikOverflow`; refunds eat the surplus first.
- Publishing to the static pages is debounced (a few seconds) and skipped while an admin save is running.
- Refunds: `POST /api/admin/pledges/refund {projectId}` is a **dry run**; add `confirm: true` to execute.
  Each refund has a stable `extRef` (`refund-<id>`), 429 is retried, failures are recorded and can be repeated.
  A `processing` refund is finished by the later `reversed` webhook or the reconcile.
- **Keep enough money on the FOP account until the campaign is closed.** Do not withdraw it.

## Launch checklist

1. FOP + account + acquiring cabinet. Get a **test** token if monobank offers one; otherwise the first
   real payments are real: use a small amount on the lowest-priced project and refund it.
2. Ask monobank: is a PRRO link needed (then `merchantPaymInfo.basketOrder` must be sent)? Which pages must
   the site have? (templates: `docs/legal/`)
3. Publish `/oferta/`, `/povernennia/`, `/konfidentsiinist/`, contacts with FOP details; link them in the
   footer and on the "Підтримати" page. Add a line on that page: "Якщо ціль не зібрано до <дата> — повернемо кошти".
4. Set the env vars on the server, restart `blueferret-admin`.
5. Turn on the button on the site: the support page's bundled constant `NEXT_PUBLIC_ENABLE_PAYMENTS` is
   baked at build time (the chunk currently has it off). It has to be patched in the live chunk (and the
   hashed file renamed and relinked like `writeKikProjects` does). Not done yet.
6. Un-hide the project (`/kik/proekty/<id>/` pages are parked as "Проєкт недоступний" right now).
7. Pay a minimum amount yourself, watch `audit` (`mono_*` entries) and the project's `raised`, then refund it.

## Known gap in the repo (not related to Mono)

`src/db.js` has no migration for `games.box_faces` / `games.files`; a fresh database cannot boot
`server.js` (the live DB has them). Only matters for a clean install.
