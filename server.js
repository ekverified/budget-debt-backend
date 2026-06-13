// server.js
// ─────────────────────────────────────────────────────────────────
// Budget & Debt Coach — Backend API  v2.0
//
// WHAT CHANGED FROM ORIGINAL:
//   Old: 2 endpoints, no security, wildcard CORS, no rate limit,
//        no streaming, no financial data, no keep-alive.
//
//   New: 5 endpoints, helmet + gzip + CORS whitelist, rate limiting,
//        SSE streaming AI advice, financial data served from backend,
//        node-cron keep-alive, graceful shutdown, full analytics.
//
// ENDPOINTS:
//   GET  /health                  keep-alive ping (UptimeRobot / cron)
//   GET  /api/financial-data      verified 2025 Kenyan market data
//   POST /api/advice/stream       SSE streaming AI / rule-based advice
//   POST /api/log                 log a user action to MongoDB
//   GET  /api/admin/logs          admin dashboard (ADMIN_API_KEY required)
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const mongoose    = require('mongoose');
const rateLimit   = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const cron        = require('node-cron');
const https       = require('https');
const http        = require('http');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Trusted frontend origins ────────────────────────────────────── */
const FRONTEND_ORIGIN = (process.env.FRONTEND_URL || 'https://budget-debt-coach-js.onrender.com').trim();

/* ════════════════════════════════════════════════════════════════════
   MIDDLEWARE
════════════════════════════════════════════════════════════════════ */

/* Security headers — tighten HTTP defaults */
app.use(helmet({
  crossOriginEmbedderPolicy: false, // charts/iframes need this off
  contentSecurityPolicy:     false, // React app manages its own CSP
}));

/* Gzip — ~70% smaller payloads on slow Kenyan mobile connections */
app.use(compression());

/* CORS — only our frontend + localhost dev; no wildcard */
app.use(cors({
  origin: (origin, cb) => {
    const ALLOWED = [
      FRONTEND_ORIGIN,
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    // Requests with no origin header (Postman, cron, server-to-server) are allowed
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    false,
}));

/* JSON body — 10 kB ceiling (no oversized payloads) */
app.use(express.json({ limit: '10kb' }));

/* HTTP request logging — skips /health to keep Render logs readable */
app.use(morgan('tiny', { skip: req => req.path === '/health' }));

/* Global rate limit: 120 requests per 15 minutes per IP */
app.use(rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Please wait a few minutes.' },
}));

/* Stricter limit for AI advice: 10 requests per hour per IP */
const aiLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'AI advice limit reached (10 per hour). Please try again later.' },
});

/* ════════════════════════════════════════════════════════════════════
   MONGODB CONNECTION
════════════════════════════════════════════════════════════════════ */
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log('[DB] MongoDB connected'))
    .catch(err => console.error('[DB] Connection failed:', err.message));
} else {
  console.warn('[DB] MONGODB_URI not set — analytics logging is disabled');
}

/* ── Log schema ─────────────────────────────────────────────────── */
const logSchema = new mongoose.Schema({
  uid:       { type: String, required: true, index: true },
  timestamp: { type: Date,   default: Date.now, index: true },
  action:    { type: String, required: true },
  details:   { type: Object, default: {} },
  date:      { type: String, required: true, index: true }, // YYYY-MM-DD
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
});

const Log = mongoose.models.Log || mongoose.model('Log', logSchema);

/* ════════════════════════════════════════════════════════════════════
   KENYAN FINANCIAL DATA
   Single source of truth — served from backend, cached 1 hr in browser.
   Update rates here when you redeploy. No scraping; no stale browser data.
   Sources: CBK website, Vasili Africa, Money254 (verified June 2025)
════════════════════════════════════════════════════════════════════ */
const FINANCIAL_DATA = {
  lastUpdated: '2025-06',
  disclaimer:  'Rates are indicative based on publicly available 2025 data. Verify current rates before investing. This is not financial advice.',

  mmfs: [
    { name: 'Lofty-Corban MMF',  net: 16.92, note: 'Leading daily yield — Vasili Africa report June 2025' },
    { name: 'Etica Capital MMF', net: 16.86, note: 'Consistent top-3 performer, regulated by CMA Kenya' },
    { name: 'Cytonn MMF',        net: 16.80, note: 'High yield, online registration, accessible minimums' },
    { name: 'Madison MMF',       net: 14.20, note: 'Established fund manager, NSSF-registered' },
    { name: 'Sanlam MMF',        net: 13.80, note: 'Stable returns, NSE-listed management company' },
  ],

  saccos: [
    { name: 'Tower Sacco',   dividend: 20, note: '249,000+ members, Tier-1 DT Sacco, consistent dividends' },
    { name: 'Port DT Sacco', dividend: 20, note: 'Assets KSh 10.54 billion, top-tier track record' },
    { name: 'Yetu Sacco',    dividend: 19, note: 'Assets KSh 7.86 billion, strong member returns' },
    { name: 'Imarika Sacco', dividend: 18, note: 'Coast-based DT Sacco, reliable dividend history' },
    { name: 'Stima Sacco',   dividend: 16, note: 'Open membership, strong governance, SASRA regulated' },
  ],

  bonds: {
    '10Y':   13.13,
    tBills: {
      '91-day':  7.81,
      '182-day': 7.90,
      '364-day': 9.34,
    },
    source: 'Central Bank of Kenya — June 2025 auction results',
    accessPortal: 'https://www.centralbank.go.ke/bills-bonds/',
    dhowCSD: 'https://dhowcsd.centralbank.go.ke/', // CBK's retail bond portal
  },

  callDeposits: [
    { name: 'Credit Bank',          rate: 13.18, minInvestment: 100000, note: 'Highest savings rate — CBK survey 2025' },
    { name: 'African Banking Corp',  rate: 12.32, minInvestment:  50000, note: 'Competitive fixed-call deposit' },
    { name: 'Family Bank',           rate: 11.50, minInvestment: 100000, note: 'Accessible minimum, nationwide branches' },
    { name: 'Equity Bank',           rate:  9.80, minInvestment: 100000, note: 'Largest bank by customer base in Kenya' },
    { name: 'KCB Bank',              rate:  8.50, minInvestment: 100000, note: 'Largest bank by assets, most branches' },
  ],

  // Kenyan lender typical rates — used for advice about debt priority
  kenyanLenders: [
    { name: 'Fuliza (M-Pesa)',   dailyRate: 1.083, note: 'Safaricom overdraft — ~395% effective APR, clear first' },
    { name: 'Tala',              monthlyRate: 15,  note: 'Digital loan — ~180% APR, clear second' },
    { name: 'Branch',            monthlyRate: 12,  note: 'Digital loan — improving rates for good repayment history' },
    { name: 'KCB M-Pesa',       monthlyRate:  8.64, note: 'Mobile loan, flexible repayment' },
    { name: 'M-Shwari',         flatFee:      7.5,  note: 'CBA & Safaricom — one-time fee on 30-day loan' },
    { name: 'Hustler Fund',      annualRate:   8.0, note: 'Government fund — daily interest, 8% p.a. effective' },
  ],
};

/* ════════════════════════════════════════════════════════════════════
   ROUTE: GET /health
   Keep-alive ping. Used by UptimeRobot and the internal cron job.
════════════════════════════════════════════════════════════════════ */
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    version:   '2.0.0',
  });
});

/* ════════════════════════════════════════════════════════════════════
   ROUTE: GET /api/financial-data
   Returns verified 2025 Kenyan financial data.
   Cache-Control allows 1-hour browser caching (reduces backend calls).
════════════════════════════════════════════════════════════════════ */
app.get('/api/financial-data', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.json(FINANCIAL_DATA);
});

/* ════════════════════════════════════════════════════════════════════
   ROUTE: POST /api/advice/stream
   Streams personalised financial advice via Server-Sent Events (SSE).
   Rate-limited: 10 requests per hour per IP.

   Flow:
   1. Frontend POSTs budget context (salary, debts, savings etc.)
   2. Backend streams response word-by-word so text appears progressively
   3. If ANTHROPIC_API_KEY is set → uses Claude Haiku for real AI advice
   4. Otherwise → streams high-quality rule-based advice (same format)
   5. Ends with data: [DONE] so frontend knows stream is complete
════════════════════════════════════════════════════════════════════ */
app.post('/api/advice/stream', aiLimiter, async (req, res) => {

  /* SSE headers — must be set before any write */
  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache, no-transform');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no'); // disable Nginx/Render proxy buffering
  res.flushHeaders();

  const ctx = req.body || {};

  /* Send one SSE data line */
  const send = (text) => {
    if (!res.writableEnded) res.write(`data: ${text}\n\n`);
  };

  /* Stream a string token-by-token with realistic pacing */
  const streamWords = async (text) => {
    const tokens = text.split(/(\s+)/); // split on whitespace, keep it
    for (const token of tokens) {
      if (!token) continue;
      send(token);
      await new Promise(r => setTimeout(r, 20)); // ~50 tokens/sec
    }
  };

  try {
    /* ── Option A: Anthropic Claude Haiku ── */
    if (process.env.ANTHROPIC_API_KEY) {
      // Dynamic require so the server starts even without the SDK installed
      let Anthropic;
      try {
        Anthropic = require('@anthropic-ai/sdk');
      } catch {
        throw new Error('ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
      }

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const stream = await client.messages.stream({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages:   [{ role: 'user', content: buildAIPrompt(ctx) }],
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          send(chunk.delta.text);
        }
      }

    } else {
      /* ── Option B: Rule-based advice (no API key needed) ── */
      const advice = buildRuleBasedAdvice(ctx);
      await streamWords(advice);
    }

    send('[DONE]');
    res.end();

    /* Non-blocking analytics log */
    if (mongoose.connection.readyState === 1) {
      new Log({
        uid:    ctx.uid || 'anonymous',
        action: 'ai_advice_generated',
        details: {
          salary:        ctx.salary,
          currency:      ctx.currency,
          householdSize: ctx.householdSize,
          savingsPct:    ctx.savingsPct,
          hadDeficit:    (ctx.deficit || 0) > 0,
        },
        date: new Date().toISOString().slice(0, 10),
        ip:   req.ip || '',
      }).save().catch(() => {/* non-fatal */});
    }

  } catch (err) {
    console.error('[SSE]', err.message);
    send('Unable to generate advice right now. Please review your action plan above.');
    send('[DONE]');
    if (!res.writableEnded) res.end();
  }
});

/* ════════════════════════════════════════════════════════════════════
   ROUTE: POST /api/log
   Records a user action in MongoDB for analytics.
   Validates and sanitises all inputs before saving.
════════════════════════════════════════════════════════════════════ */
app.post(
  '/api/log',
  [
    body('uid').isString().trim().notEmpty().isLength({ max: 128 })
      .withMessage('uid is required and must be under 128 chars'),
    body('action').isString().trim().notEmpty().isLength({ max: 64 })
      .withMessage('action is required and must be under 64 chars'),
    body('date').matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('date must be in YYYY-MM-DD format'),
    body('details').optional().isObject()
      .withMessage('details must be a JSON object'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }

    if (mongoose.connection.readyState !== 1) {
      // Silently accept when DB is down — don't error the frontend
      return res.status(202).json({ message: 'Accepted (logging unavailable)' });
    }

    try {
      const { uid, action, details = {}, date } = req.body;
      await new Log({
        uid, action, details, date,
        ip:        req.ip || '',
        userAgent: (req.headers['user-agent'] || '').slice(0, 200),
      }).save();
      res.status(201).json({ message: 'Logged' });
    } catch (err) {
      console.error('[LOG]', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ════════════════════════════════════════════════════════════════════
   ROUTE: GET /api/admin/logs
   Returns analytics dashboard for the admin.
   Protected by ADMIN_API_KEY query parameter.
════════════════════════════════════════════════════════════════════ */
app.get(
  '/api/admin/logs',
  [
    query('key').isString().notEmpty(),
    query('since').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  async (req, res) => {
    /* Auth check first — before touching DB */
    if (!process.env.ADMIN_API_KEY || req.query.key !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid query parameters' });
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    try {
      /* Default: last 30 days */
      const since = req.query.since
        || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const limit = Math.min(parseInt(req.query.limit) || 500, 500);

      const logs = await Log.find({ date: { $gte: since } })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

      /* ── Core metrics ── */
      const uidSet     = new Set(logs.map(l => l.uid));
      const totalUsers = uidSet.size;
      const totalEvents = logs.length;

      const userCounts = {};
      logs.forEach(l => { userCounts[l.uid] = (userCounts[l.uid] || 0) + 1; });
      const repeatUsers  = Object.values(userCounts).filter(c => c > 1).length;
      const oneTimeUsers = totalUsers - repeatUsers;

      /* ── Top actions ── */
      const actionCounts = {};
      logs.forEach(l => { actionCounts[l.action] = (actionCounts[l.action] || 0) + 1; });
      const topActions = Object.entries(actionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([action, count]) => ({ action, count }));

      /* ── Daily Active Users (last 30 days) ── */
      const dailyMap = {};
      logs.forEach(l => {
        if (!dailyMap[l.date]) dailyMap[l.date] = new Set();
        dailyMap[l.date].add(l.uid);
      });
      const dailyActiveUsers = Object.entries(dailyMap)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 30)
        .map(([date, users]) => ({ date, dau: users.size }));

      /* ── Session stats ── */
      const avgEventsPerUser = totalUsers > 0
        ? (totalEvents / totalUsers).toFixed(1)
        : 0;

      /* ── Error / issue events ── */
      const errorActions = new Set([
        'error', 'calculate_error', 'failed_transaction',
        'user_stuck', 'pdf_error', 'ai_error',
      ]);
      const issues = logs
        .filter(l => errorActions.has(l.action))
        .slice(0, 20);

      /* ── Calculate events (shows feature usage) ── */
      const calcEvents = logs.filter(l => l.action === 'calculate_budget');
      const pdfEvents  = logs.filter(l => l.action === 'download_pdf');
      const csvEvents  = logs.filter(l => l.action === 'export_csv');
      const aiEvents   = logs.filter(l => l.action === 'ai_advice_generated');

      res.json({
        meta: {
          since,
          limit,
          generatedAt: new Date().toISOString(),
        },
        metrics: {
          totalUsers,
          repeatUsers,
          oneTimeUsers,
          totalEvents,
          avgEventsPerUser,
          featureUsage: {
            calculate:   calcEvents.length,
            downloadPdf: pdfEvents.length,
            exportCsv:   csvEvents.length,
            aiAdvice:    aiEvents.length,
          },
          topActions,
          dailyActiveUsers,
        },
        issues,
        recentLogs: logs.slice(0, 100),
      });

    } catch (err) {
      console.error('[ADMIN]', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ════════════════════════════════════════════════════════════════════
   AI PROMPT BUILDER  (for Anthropic Claude)
════════════════════════════════════════════════════════════════════ */
function buildAIPrompt(ctx) {
  const c = ctx.currency || 'KES';
  const f = n => `${c} ${Math.round(n || 0).toLocaleString()}`;

  return `You are a friendly, practical Kenyan personal finance coach. A user has calculated their monthly budget using the Budget & Debt Coach app. Give them personalised advice.

THEIR BUDGET:
- Monthly salary: ${f(ctx.salary)}
- Household size: ${ctx.householdSize || 1} person(s)
- Savings allocated: ${f(ctx.adjSavings)} (${ctx.savingsPct}% of salary)
- Debt payments: ${f(ctx.adjDebt)} (${ctx.debtPct}%)
- Living expenses: ${f(ctx.adjExp)} (${ctx.expensesPct}%)
- Surplus this month: ${f(ctx.spareCash)}
- Monthly deficit: ${f(ctx.deficit)}
- Debt payoff — Snowball: ${ctx.snowball?.months || 0} months, interest paid: ${f(ctx.snowball?.interest)}
- Debt payoff — Avalanche: ${ctx.avalanche?.months || 0} months, interest paid: ${f(ctx.avalanche?.interest)}
- Emergency fund target: ${f(ctx.emergencyTarget)}
- Cumulative savings so far: ${f(ctx.currentSavings)}
- Recommended MMF: ${ctx.mmf?.name || 'Lofty-Corban MMF'} at ${ctx.mmf?.net || 16.92}% yield
- Recommended SACCO: ${ctx.sacco?.name || 'Tower Sacco'} at ${ctx.sacco?.dividend || 20}% dividend

Write 4 short, practical paragraphs of personalised advice for this Kenyan user. Rules:
- Use plain conversational English. No markdown, no bullet points, no headers.
- Reference their actual numbers (e.g. "your ${f(ctx.adjSavings)} monthly saving").
- Mention Kenyan-specific products where relevant: M-Pesa, Fuliza, SACCOs, CBK T-Bills, Hustler Fund, DhowCSD portal.
- Be encouraging but honest — if there is a deficit, say so clearly and give realistic options.
- Maximum 220 words total.`;
}

/* ════════════════════════════════════════════════════════════════════
   RULE-BASED ADVICE  (streamed when no Anthropic key is configured)
   Produces the same quality and structure as the AI prompt above.
   References real user numbers. Plain paragraphs, no markdown.
════════════════════════════════════════════════════════════════════ */
function buildRuleBasedAdvice(ctx) {
  const c   = ctx.currency || 'KES';
  const f   = n => `${c} ${Math.round(n || 0).toLocaleString()}`;
  const hs  = ctx.householdSize || 1;
  const mmf    = ctx.mmf   || { name: 'Lofty-Corban MMF', net: 16.92 };
  const sacco  = ctx.sacco || { name: 'Tower Sacco', dividend: 20 };
  const adjSav = ctx.adjSavings   || 0;
  const adjDbt = ctx.adjDebt      || 0;
  const adjExp = ctx.adjExp       || 0;
  const spare  = ctx.spareCash    || 0;
  const def    = ctx.deficit      || 0;
  const efTgt  = ctx.emergencyTarget  || 0;
  const curSav = ctx.currentSavings   || 0;
  const avaM   = ctx.avalanche?.months    || 0;
  const avaI   = ctx.avalanche?.interest  || 0;
  const snoM   = ctx.snowball?.months     || 0;
  const snoI   = ctx.snowball?.interest   || 0;
  const intSaving = snoI - avaI;
  const mthFaster = snoM - avaM;
  const efGap = Math.max(0, efTgt - curSav);
  const mthsToEf  = adjSav > 0 ? Math.ceil(efGap / adjSav) : '—';

  const paras = [];

  /* Para 1 — Savings */
  paras.push(
    `Your plan sets aside ${f(adjSav)} per month in savings — ${ctx.savingsPct || 10}% of your salary. ` +
    (ctx.savingsPct >= 10
      ? `That meets the recommended 10% minimum, which is a great foundation. `
      : `Aim to grow this toward 10% as your expenses come down. `) +
    `Transfer this amount to ${mmf.name} (${mmf.net}% yield per year) on the same day your salary arrives, before spending anything else. ` +
    `Automating the transfer removes the temptation to spend it.`
  );

  /* Para 2 — Debt */
  if (adjDbt > 0) {
    paras.push(
      `For your debt payments of ${f(adjDbt)} per month, use the Avalanche method — pay the minimum on every loan, then direct any extra money to your highest-interest loan first. ` +
      (intSaving > 0
        ? `Compared to the Snowball method, Avalanche clears your debt ${mthFaster} month${mthFaster !== 1 ? 's' : ''} sooner and saves you ${f(intSaving)} in interest charges over time. `
        : '') +
      `If you have Fuliza or Tala debt, clear those first — their effective annual rates can exceed 100% when calculated properly. ` +
      `Paying on time every month also protects your credit score for future borrowing.`
    );
  }

  /* Para 3 — Emergency fund */
  paras.push(
    `Your emergency fund target is ${f(efTgt)}, which covers three months of your living expenses for ${hs} person${hs > 1 ? 's' : ''}. ` +
    (efGap > 0
      ? `You currently have ${f(curSav)} saved, so you need ${f(efGap)} more. At ${f(adjSav)} per month it will take roughly ${mthsToEf} month${mthsToEf !== 1 ? 's' : ''} to reach this goal. `
      : `Your emergency fund is fully funded — excellent work! You can now redirect that energy toward wealth-building. `) +
    `Keep this fund in ${mmf.name} or a similar money market fund so it earns interest while remaining instantly accessible.`
  );

  /* Para 4 — Surplus, deficit, or Kenya tip */
  if (def > 0) {
    paras.push(
      `Your expenses currently exceed your salary by ${f(def)} per month. Practical steps: identify non-essential spending you can reduce, ` +
      `negotiate your rent or utilities, or add an income stream — tutoring, delivery work, or online freelancing can generate ${f(def)} extra per month more quickly than you might expect. ` +
      `The Hustler Fund charges only 8% per year and can bridge short-term gaps without the high cost of Fuliza. Review your plan next month as your situation improves.`
    );
  } else if (spare > 0) {
    paras.push(
      `You have ${f(spare)} left over after all allocations this month. Apply it first to your highest-rate debt to save interest, ` +
      `then to ${sacco.name} (${sacco.dividend}% dividend) once debt-free — SACCOs also let you borrow three times your savings at competitive rates, making them a powerful wealth-building tool. ` +
      `Treasury Bills through CBK's DhowCSD portal (364-day rate: 9.34%) are another excellent low-risk option for surplus funds.`
    );
  } else {
    paras.push(
      `Your budget is fully allocated with no surplus — that is fine for now. ` +
      `Once you reduce any non-essential expenses or clear a loan, the freed-up cash should go straight to ${sacco.name} or a 364-day Treasury Bill (9.34% p.a.) via CBK's DhowCSD portal. ` +
      `Small consistent steps build real wealth over time — you are already on the right path.`
    );
  }

  return paras.join('\n\n');
}

/* ════════════════════════════════════════════════════════════════════
   KEEP-ALIVE CRON
   Pings /health every 14 minutes to prevent Render free-tier sleep.
   Only runs in production when SELF_URL is set in environment vars.
════════════════════════════════════════════════════════════════════ */
if (process.env.NODE_ENV === 'production' && process.env.SELF_URL) {
  cron.schedule('*/14 * * * *', () => {
    const url = new URL('/health', process.env.SELF_URL);
    const lib = url.protocol === 'https:' ? https : http;
    lib.get(url.toString(), res => {
      console.log(`[CRON] Keep-alive → ${res.statusCode}`);
    }).on('error', err => {
      console.warn('[CRON] Keep-alive failed:', err.message);
    });
  });
  console.log('[CRON] Keep-alive scheduler started (every 14 min)');
}

/* ════════════════════════════════════════════════════════════════════
   404 + ERROR HANDLERS
════════════════════════════════════════════════════════════════════ */
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('[UNHANDLED]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ════════════════════════════════════════════════════════════════════
   START SERVER + GRACEFUL SHUTDOWN
════════════════════════════════════════════════════════════════════ */
const server = app.listen(PORT, () => {
  console.log(`\n[SERVER] Budget & Debt Coach API v2.0`);
  console.log(`[SERVER] Port      : ${PORT}`);
  console.log(`[SERVER] Env       : ${process.env.NODE_ENV || 'development'}`);
  console.log(`[SERVER] Frontend  : ${FRONTEND_ORIGIN}`);
  console.log(`[SERVER] DB        : ${process.env.MONGODB_URI ? 'configured' : 'NOT SET'}`);
  console.log(`[SERVER] AI        : ${process.env.ANTHROPIC_API_KEY ? 'Claude Haiku enabled' : 'rule-based fallback'}\n`);
});

const shutdown = signal => {
  console.log(`\n[SERVER] ${signal} — shutting down gracefully`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('[SERVER] DB closed. Exit.');
      process.exit(0);
    }).catch(() => process.exit(0));
  });
  setTimeout(() => {
    console.error('[SERVER] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* Catch uncaught errors so the server never crashes silently */
process.on('uncaughtException', err => {
  console.error('[UNCAUGHT]', err.message);
  // Don't exit — log and continue (Render will restart if truly fatal)
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
