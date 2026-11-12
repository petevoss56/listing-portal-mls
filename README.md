# 3% Listing Co. — MLS Comps Connector

Keeps a private copy of MRED listings for the Quad Cities (from MLS Grid) and lets Claude and the Listing Portal run CMAs on it using the 3% Listing Co. Step 1 rules.

- **Hourly-ish sync** (every 15 minutes) from MLS Grid, Broker Back Office subscription, source `mred`
- **Only the service area is stored:** Scott County IA, Rock Island County IL, Henry County IL (change `SERVICE_AREA` in `wrangler.toml`)
- **Only records the MLS allows for Back Office use** are used for comps (`MlgCanUse` contains `BO`)
- **Never mixes Iowa and Illinois comps**
- **One key per person**, and every tool call is logged with who ran it

## Tools Claude gets

| Tool | What it does |
|---|---|
| `run_cma` | Full Step 1 CMA: 5–8 sold comps and 3–4 actives (radius widens first, then the time window), adjustments, value, $10k range, recommended price, confidence score with concerns, top 3 competitors |
| `find_sold_comps` | Closed sales near an address, best matches first |
| `find_active_listings` | Active / coming soon / pending listings near an address |
| `get_listing` | One listing by MLS number, including remarks |
| `search_listings_by_address` | Past and current MLS records for an address |
| `sync_status` | How current the data is, record counts, recent usage |

The Listing Portal can call the same tools at `POST /api/tools/<tool name>` with the same key.

## Setup (one time)

You'll need: your MLS Grid access token, a Cloudflare account, and about 30 minutes.

1. **Cloudflare plan.** In Cloudflare, switch Workers to the **Workers Paid** plan. The free plan doesn't allow enough processing time per sync run.
2. **Create the database.** In the Cloudflare dashboard, go to **Storage & Databases → D1**, choose **Create**, and name it `listing-portal-mls`. Copy its **Database ID** and send it to Claude, or paste it into `wrangler.toml` in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`. The ID isn't a secret.
3. **Deploy from GitHub.** In **Workers & Pages**, choose **Create**, then **Import a repository**, and pick `petevoss56/listing-portal-mls`. Keep the default build settings; it reads everything from `wrangler.toml`. Cloudflare redeploys automatically whenever this repo changes.
4. **Add the two secrets.** In the Worker, go to **Settings → Variables and Secrets** and add two values, both as type **Secret**:
   - `MLSGRID_TOKEN`: your MLS Grid token.
   - `CONNECTOR_KEYS`: one entry per person, as `name:key` pairs separated by commas, e.g. `pete:<key>,chris:<key>`. Make each key a random 40+ character password from your password manager. Don't send keys or the token in chat.
5. **Let the first import run.** The sync runs every 15 minutes. The first full import of MRED residential data may take several runs. Ask Claude to call `sync_status` to watch progress. Your Worker's address is shown in Cloudflare and looks like `https://listing-portal-mls.<your-subdomain>.workers.dev`. Opening `/health` there should show `"ok": true`.
6. **Connect Claude (Pro plan).** In Claude, open **Customize → Connectors**, choose **+ Add**, then **Add custom connector**:
   - Name: `3% MLS Comps`
   - URL: `https://listing-portal-mls.<your-subdomain>.workers.dev/mcp`
   - Authentication: **No sign in**
   - Request header: `Authorization` = `Bearer <your key from step 4>`
7. **Test it:** ask Claude to "run a CMA on 709 40th Ave, East Moline IL."

**Adding an agent later:** add `name:key` to `CONNECTOR_KEYS` and give the agent their key. **Removing one:** delete their entry. On a Claude Team plan, the Owner adds the connector once for everyone.

## Settings (`wrangler.toml` → `[vars]`)

| Setting | Default | Meaning |
|---|---|---|
| `ORIGINATING_SYSTEM` | `mred` | MLS Grid source |
| `SERVICE_AREA` | `IA:Scott;IL:Rock Island;IL:Henry` | State:County pairs to keep |
| `SYNC_PROPERTY_TYPES` | `Residential` | Property types pulled from MLS Grid |
| `ADMIN_AGENTS` | `pete` | Key names allowed to run `POST /admin/sync` |
| `SYNC_PAGE_SIZE` / `SYNC_MAX_PAGES` | `5000` / `20` | Records per request / requests per run |

## How the valuation works

- **Indicated value:** `(price + adjustments) ÷ comp sq ft × subject sq ft`. Results are weighted toward closer, more similar, more recent sales.
- **Adjustments:** condition grade step by size tier ($5k/$10k/$15k/$20k/$25k), $10k per full bath, $5k per half bath, $10k per garage stall, $70 per sf of finished basement.
- **Eligibility:** bedroom eligibility and age rules from the Listing Portal brief. Comps are always from the same state.
- **Condition:** the MLS doesn't record condition, so comps start at the subject's grade. Pass `comp_grades` (for example `{"12345678": "B"}`) after reviewing photos.
- **Square footage:** uses above-grade sq ft when the MLS reports it; otherwise total living area, and it says so in the concerns.

## Compliance notes

- Data is licensed under the MLS Grid Data License Agreement and AI Use Addendum, for internal brokerage use by licensed agents.
- Records MLS Grid marks `MlgCanView = false` are deleted on the next sync.
- No photos are stored.
- Keys are per person and every call is logged (`usage_log` table).

## Development

```
npm test        # runs the test suite (Node 22+, no install needed)
npm run deploy  # manual deploy with Wrangler (normally Cloudflare deploys from GitHub)
```

Code: `src/sync.js` (MLS Grid replication), `src/cma.js` (Step 1 rules), `src/tools.js` (tool definitions), `src/mcp.js` (Claude connector protocol), `src/index.js` (routes, keys, cron), `src/db.js` (database).
