# openguardrails.com routing infra (snapshot)

Version-controlled snapshot of the production routing for `openguardrails.com`.
These files are **documentation + a reconcile helper**, not the live source of
truth — the live config lives in the Cloudflare dashboard and on the origin host.
Re-run [`snapshot.sh`](./snapshot.sh) to refresh them from production.

## Request flow

```
client ──▶ Cloudflare edge (zone openguardrails.com)
             │
             ├─ www.openguardrails.com/*   ─▶ Worker platform-proxy ─▶ 301 to apex (canonical)
             │
             ├─ openguardrails.com/{core,dashboard,account,login,claim,platform,api,v1}*
             │                             ─▶ Worker platform-proxy
             │                                   rewrites Host ─▶ api.openguardrails.com
             │                                   ─▶ origin nginx (47.251.252.98)
             │
             └─ openguardrails.com/*  (everything else, e.g. marketing pages)
                                           ─▶ Cloudflare Pages (this Next.js site)
```

Key facts that make this non-obvious:

- **Apex is Pages by default.** `openguardrails.com` / `www` are CNAMEd to
  `openguardrails-com.pages.dev`. Only the path-prefixes listed in
  [`worker-routes.json`](./cloudflare/worker-routes.json) are carved out to the
  Worker; anything else is served by Pages. A path that must reach the app but
  has **no matching Worker route** returns the Pages 404.
- **The Worker forwards to `api.openguardrails.com`**, so those requests hit the
  **`api.openguardrails.com` nginx server block** — not the main
  `openguardrails.com` block. Any app route (e.g. `/core`, `/dashboard`) must
  therefore exist in **both** vhosts. See the "Core app + console routes" section
  in [`nginx/openguardrails-ogr.conf`](./nginx/openguardrails-ogr.conf).
- **`www` → apex** canonical redirect is done inside the Worker (the API token in
  use lacks Rulesets permission, so it is not a Single Redirect rule).

## Files

| File | What it is |
|------|------------|
| `cloudflare/platform-proxy.worker.js` | Source of the `platform-proxy` Worker. |
| `cloudflare/worker-routes.json` | Desired Worker route patterns (exact set). |
| `cloudflare/apply.sh` | Deploy the Worker + reconcile routes to match the JSON. |
| `snapshot.sh` | Pull the live Worker source, routes, and origin nginx back into this dir. |
| `nginx/openguardrails-ogr.conf` | Snapshot of the origin `/etc/nginx/sites-available/ogr`. |

## Apply / refresh

```bash
export CLOUDFLARE_API_TOKEN=...            # Workers Scripts:Edit + Workers Routes:Edit
./cloudflare/apply.sh --dry-run            # preview
./cloudflare/apply.sh                      # deploy worker + reconcile routes

./snapshot.sh                              # refresh all snapshots from prod
```

> The origin nginx file is **not** applied by any script here — it is a reference
> copy. Edit it on the host (`/etc/nginx/sites-available/ogr`), then
> `sudo nginx -t && sudo systemctl reload nginx`, then run `./snapshot.sh` to
> update this copy. A backup of the pre-`/core`-fix config is on the host at
> `/etc/nginx/sites-available/ogr.bak-precore`.
>
> **DRY improvement worth doing:** the `/core`, `/dashboard`, `/account`,
> `/login`, `/claim` blocks are currently duplicated across the main and api
> server blocks. Factor them into an `include`d snippet both blocks pull in so
> they can't drift.
