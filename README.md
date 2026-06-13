# Budget & Debt Coach — Backend API v2.0

Secure Node.js/Express backend for the Budget & Debt Coach app.

## What's new in v2.0

| Feature | Old | New |
|---------|-----|-----|
| Security headers | None | Helmet |
| Response compression | None | Gzip (compression) |
| CORS | Wildcard `*` | Whitelist — frontend URL only |
| Rate limiting | None | 120 req/15 min global + 10 req/hr on AI |
| Input validation | None | express-validator on all POST/GET inputs |
| AI advice | None | SSE streaming (Claude Haiku or rule-based) |
| Financial data | Scraped in browser | Served from backend, browser-cached 1 hr |
| Keep-alive | None | node-cron pings /health every 14 min |
| Graceful shutdown | None | SIGTERM/SIGINT handled cleanly |
| Analytics | Basic | DAU chart, feature usage, error tracking |

## Quick start

```bash
npm install
cp .env.example .env    # fill in your values
npm run dev             # development with nodemon
npm start               # production
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Default `3001` |
| `NODE_ENV` | Yes | Set to `production` on Render |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string |
| `ADMIN_API_KEY` | Yes | Protects `/api/admin/logs` |
| `FRONTEND_URL` | Yes | Exact Render frontend URL (for CORS) |
| `SELF_URL` | No | Backend URL for keep-alive cron |
| `ANTHROPIC_API_KEY` | No | Enables real Claude Haiku AI advice |

## API endpoints

### `GET /health`
Keep-alive ping. Returns `{ status, uptime, timestamp, version }`.
Used by UptimeRobot and internal cron job.

### `GET /api/financial-data`
Returns verified 2025 Kenyan financial rates:
- Money Market Funds (MMFs) with yields
- SACCOs with dividend rates
- CBK Treasury Bills & Bond rates
- Bank call deposit rates
- Kenyan lender typical rates (Fuliza, Tala, Hustler Fund etc.)

Browser caches response for 1 hour.

### `POST /api/advice/stream`
Streams personalised financial advice via Server-Sent Events.
Rate limited to 10 requests per hour per IP.

**Request body:**
```json
{
  "salary": 85000,
  "currency": "KES",
  "householdSize": 2,
  "savingsPct": 10,
  "debtPct": 20,
  "expensesPct": 70,
  "adjSavings": 8500,
  "adjDebt": 17000,
  "adjExp": 59500,
  "spareCash": 0,
  "deficit": 0,
  "snowball": { "months": 18, "interest": 45000 },
  "avalanche": { "months": 15, "interest": 38000 },
  "emergencyTarget": 178500,
  "currentSavings": 25000,
  "mmf": { "name": "Lofty-Corban MMF", "net": 16.92 },
  "sacco": { "name": "Tower Sacco", "dividend": 20 }
}
```

**SSE response format:**
```
data: Your \n\ndata: plan \n\ndata: is \n\ndata: [DONE]\n\n
```

If `ANTHROPIC_API_KEY` is set → uses Claude Haiku.
Otherwise → streams rule-based advice referencing the user's actual numbers.

### `POST /api/log`
Records a user action in MongoDB.

**Request body:**
```json
{
  "uid": "user-session-id",
  "action": "calculate_budget",
  "date": "2025-06-13",
  "details": { "salary": 85000, "currency": "KES" }
}
```

Common action values: `calculate_budget`, `download_pdf`, `export_csv`,
`ai_advice_generated`, `calculate_error`, `pwa_install_accepted`.

### `GET /api/admin/logs?key=SECRET&since=YYYY-MM-DD&limit=200`
Returns analytics dashboard. Requires `ADMIN_API_KEY`.

**Response includes:**
- Total users, repeat users, one-time users
- Average events per user
- Feature usage (calculate, PDF, CSV, AI)
- Top 5 actions
- Daily active users (last 30 days)
- Error/issue events
- Latest 100 raw log entries

## Deploying to Render

1. Push this folder as a separate GitHub repo (`budget-debt-backend`)
2. Create **Web Service** on Render → connect the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all environment variables from `.env.example`
6. Set `SELF_URL` = your Render service URL (enables keep-alive cron)
7. Optionally add `ANTHROPIC_API_KEY` for real AI advice

## Updating financial data

Edit `FINANCIAL_DATA` in `server.js` and redeploy. The object is clearly
labelled with the data source and last-updated date. The frontend will
pick up new rates within 1 hour (cache expiry).

## Adding real AI (optional)

1. Sign up at https://console.anthropic.com
2. Create an API key
3. Add `ANTHROPIC_API_KEY=sk-ant-...` to Render environment variables
4. Redeploy — no code changes needed
5. Cost: Claude Haiku costs ~$0.001 per advice call (very cheap)
