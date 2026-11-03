# MCB Revenue Intelligence

Fee-collection analytics over **MCBMaster** (Azure SQL Managed Instance): payment-mode mix, MCB gateway share, gateway leaderboard, institute scoring, pay-link campaigns and an upsell pipeline.

- **Frontend:** plain HTML, CSS and JavaScript modules in `frontend/`. Bootstrap 5.3 is vendored; there is no build step.
- **Backend:** FastAPI in `backend/`. It serves both the API (`/api/*`) and the frontend.

## Run

```powershell
cd backend
pip install -r requirements.txt          # needs "ODBC Driver 18 for SQL Server" on the machine
copy .env.example .env                   # then fill in the DB credentials
python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Open http://127.0.0.1:8765. To check the database connection, open `GET /api/health`.

## Data sources (read-only)

| Table / view | Used for |
|---|---|
| `dbo.MCBOrganisationPaymentsAnalysis` | All collection figures: per tenant DB, organisation, payment mode and month |
| `dbo.MCBFeePaymentModes` | Payment-mode names (joined by `PaymentModeID`) |
| `dbo.MasterPaymentGateways` | Gateway master: canonical names and the `IsMCBPartner` / `IsActive` flags |
| `dbo.MCB_OrganisationPaymentGatewayName` | Organisation/branch → gateway mapping. If this combined view cannot be read, each tenant's `[db].dbo.View_OrganisationPaymentGatewayName` is read separately. Tenant DBs that deny access are skipped and listed in the portal. |

**Rules applied to the data**

- **Institute key:** an institute is identified by `DBName:OrganisationID`.
- **Months:** only complete months count, meaning months before the month of `GeneratedDate`.
- **Exclusions:** school-store rows (`IsSchoolStore = 1`) and the DBs listed in `MCB_EXCLUDE_DBS` are left out of all figures.
- **MCB gateway:** "Online Payment" (`PaymentModeID` 5) counts as collections through the MCB gateway. Mode roles are set in `MODE_MAP` in `backend/app/analytics.py`.
- **Per-gateway volume:** this is *attributed*, not reported. Each institute's Online Payment total is assigned to its mapped gateway(s), and split evenly when an institute has more than one.

## Gateway status per institute

The gateway view's `PaymentGatewayName` decides each institute's status:

| Status | Meaning |
|---|---|
| **MCB gateway** | At least one branch is mapped to a real gateway. Branches marked `NA` are counted and shown. |
| **Not using MCB gateway (N/A)** | Every branch is marked `NA`, meaning the institute does not use MCB payment gateways. |
| **No gateway mapping** | The institute has no rows in the mapping. |
| **Mapping not readable** | The tenant DB's view is denied to the analytics login. |

## Live data

`MCBOrganisationPaymentsAnalysis` is a snapshot: every row carries the `GeneratedDate` of the job that built it.

- **Backend:** the backend checks `MAX(GeneratedDate)` at most every `MCB_FRESHNESS_CHECK` seconds (default 5). When the value changes, it drops every cached result, so the next request reads the new snapshot.
- **Open pages:** an open page polls `GET /api/version` every 2 minutes, and right away when its tab regains focus. When the snapshot has changed, the page shows a **"New data is available — Reload figures"** banner. The reload keeps the current screen and filters.
- **Manual refresh:** **Account menu → Refresh data from database** forces an immediate reload.

The portal shows whatever the snapshot contains, so it can only be as fresh as the job that builds the table. The gateway mapping is re-read every `MCB_CACHE_TTL` seconds.

## Portal-only data

Owners, notes, pipeline deals, revenue settings, reminder consent and campaigns are stored in **PostgreSQL**, configured with `MCB_APP_DB_URL`. The tables are created automatically in schema `portal` on first start, and the analytics login never writes to production.

If PostgreSQL is not reachable, the analytics screens still work. Saving those items returns a clear 503 error, and a notice appears in the portal.

To set the owners available for assignment, use `MCB_OWNERS=RC:Name,SM:Name` in `.env`.

## How MCB earns: the commission model

MCB earns commission only on fees paid through **active MCB-partner gateways**, meaning `MasterPaymentGateways.IsActive = 1 AND IsMCBPartner = 1`.

- **Commission now** = Online Payment attributed to active partner gateways × the commission rate set in Revenue settings. A school on several gateways counts only its share on partner gateways.
- **Growth levers** (`GET /api/commission`, under the current filters). Each lever lists its top institutes.

| Lever | Extra partner volume |
|---|---|
| Convert offline fees at partner-gateway institutes | Cash, card, cheque and DD × the conversion target |
| Move non-partner gateway volume to a partner gateway | Online volume on non-partner, inactive or unlisted gateways |
| Onboard N/A branches of partly covered institutes | Collections × (N/A branches ÷ branches) × the conversion target. Estimated, since there's no branch-level money |
| Onboard institutes not using MCB gateways (N/A) | Collections × the conversion target |

## AI suggestions (Claude API)

- **What it does:** a "Get suggestions" button on the Command Center (current filters) and on each school page. Claude (`claude-opus-5-5`, configurable) reads only aggregated portal figures and returns 3–6 prioritised actions to grow partner-gateway volume, each with its expected commission. It never sees student or parent data.
- **Key:** set `MCB_ANTHROPIC_API_KEY` in `backend/.env`. Without it, the button shows a clear "not configured" message.
- **Answers:** returned as structured JSON and validated. An answer is reused for `MCB_AI_CACHE_MINUTES` when the data snapshot and filters are unchanged; **Regenerate** forces a fresh one. Refusal fallbacks (`fallbacks: "default"`) are on.
- **Cost:** about 3k input tokens per portfolio request.

## Accuracy and live data

- **Every page load checks the database.** The server re-reads `MAX(GeneratedDate)` at most every `MCB_FRESHNESS_CHECK` seconds (default 5). Cached aggregates are served only while that snapshot is unchanged, so they are identical to re-running the queries.
- **Gateway mapping:** it is a live view, so it is re-read every `MCB_GATEWAY_MAP_TTL` seconds (default 120).
- **If the database is unreachable,** requests return a 503 and the page shows **Database offline**. Stale figures are never served.
- **The top-bar badge** runs `GET /api/health/data` on load. It sums `PaidAmount`, `NoOfTransactions` and institutes straight from SQL and compares them with what the portal serves. **Live · verified** means they match exactly.

## Production

- **Start command:** `powershell -File backend\run-prod.ps1 -Port 8765 -Workers 2`. This runs uvicorn with workers, proxy headers and no server header.
- **Hosting:** run it behind IIS or nginx with HTTPS and company sign-in. The portal has no login of its own yet. Run it as a service with NSSM or Task Scheduler.
- **Built in:**
  - gzip
  - security headers (CSP, `X-Frame-Options`, `nosniff`)
  - `no-store` on API responses
  - a request id and timing on every log line
  - one automatic retry on a dropped database connection
  - friendly 503s for database and AI errors
  - a startup configuration log
- **Health checks:** `GET /api/health` (database, portal database, AI) and `GET /api/health/data` (accuracy).

## Endpoints

- `GET /api/meta`
- `GET /api/payment-modes`
- `GET /api/gateways`
- `GET /api/loans`
- `GET /api/institutes`
- `GET /api/institutes/{id}`
- `GET /api/filter-options`
- `GET /api/alerts`
- `GET /api/pipeline`
- `GET /api/settings` and `PUT /api/settings`
- `POST /api/refresh` (clears the query cache)

The analytics endpoints take `?fy=2026-2027`. Interactive docs are at `/docs`.
