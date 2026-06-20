import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { saveStock, getStock, getAllStocks, deleteStock, updateNotes } from './database.js';
import { getEDGARData } from './edgar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ─── Auth ────────────────────────────────────────────────────────────────────
const PASSWORD = process.env.APP_PASSWORD || 'bam2024';
const SESSIONS = new Set();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

function requireAuth(req, res, next) {
  const { session } = parseCookies(req);
  if (session && SESSIONS.has(session)) return next();
  res.status(401).json({ error: 'غير مصرح' });
}

app.post('/api/auth/login', (req, res) => {
  if (req.body.password !== PASSWORD) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
  const token = randomUUID();
  SESSIONS.add(token);
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const { session } = parseCookies(req);
  if (session) SESSIONS.delete(session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  const { session } = parseCookies(req);
  res.json({ authenticated: !!(session && SESSIONS.has(session)) });
});

app.use(express.static(join(__dirname, 'public')));

// ─── Yahoo Finance ──────────────────────────────────────────────────────────
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

const YF_MODULES = [
  'assetProfile', 'financialData', 'defaultKeyStatistics', 'summaryDetail', 'price',
  'incomeStatementHistoryQuarterly', 'cashflowStatementHistoryQuarterly',
  'balanceSheetHistoryQuarterly', 'earningsHistory', 'recommendationTrend',
  'upgradeDowngradeHistory', 'majorHoldersBreakdown', 'institutionOwnership',
  'insiderHolders', 'insiderTransactions', 'calendarEvents', 'earningsTrend',
].join(',');

function timeout(ms) {
  return new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms));
}

async function fetchYahoo(symbol) {
  const sym = encodeURIComponent(symbol);

  const [chartRes, summaryRes] = await Promise.allSettled([
    Promise.race([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, { headers: YF_HEADERS }),
      timeout(10_000),
    ]),
    Promise.race([
      fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${YF_MODULES}`, { headers: YF_HEADERS }),
      timeout(10_000),
    ]),
  ]);

  let quote = null;
  if (chartRes.status === 'fulfilled' && chartRes.value.ok) {
    const json = await chartRes.value.json().catch(() => null);
    const meta = json?.chart?.result?.[0]?.meta;
    if (meta?.symbol) {
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      quote = {
        symbol: meta.symbol,
        longName: meta.longName || meta.shortName || null,
        shortName: meta.shortName || null,
        regularMarketPrice: meta.regularMarketPrice ?? null,
        regularMarketChange: prev != null && meta.regularMarketPrice != null ? meta.regularMarketPrice - prev : null,
        regularMarketChangePercent: prev ? (meta.regularMarketPrice - prev) / prev : null,
        regularMarketVolume: meta.regularMarketVolume ?? null,
        averageDailyVolume3Month: meta.averageDailyVolume3Month ?? null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
        marketCap: meta.marketCap ?? null,
        currency: meta.currency || 'USD',
        fullExchangeName: meta.fullExchangeName || meta.exchangeName || null,
      };
    }
  }

  let summary = {};
  if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
    const json = await summaryRes.value.json().catch(() => null);
    summary = json?.quoteSummary?.result?.[0] ?? {};
  }

  if (!quote?.symbol) {
    const reason = chartRes.status === 'rejected' ? chartRes.reason?.message : `HTTP ${chartRes.value?.status}`;
    throw new Error(`Yahoo Finance غير متاح (${reason}). تأكد من الاتصال بالإنترنت.`);
  }

  return { quote, summary };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.post('/api/stock/analyze', requireAuth, async (req, res) => {
  const { symbol, forceRefresh = false } = req.body;
  if (!symbol) return res.status(400).json({ error: 'رمز السهم مطلوب' });

  const sym = symbol.toUpperCase().trim();

  // Return cache if fresh (< 6 hours)
  if (!forceRefresh) {
    const cached = getStock(sym);
    if (cached) {
      const ageH = (Date.now() - new Date(cached.last_updated)) / 3_600_000;
      if (ageH < 6) return res.json({ stock: cached, fromCache: true });
    }
  }

  // Fetch Yahoo Finance + SEC EDGAR in parallel
  let yahooData, edgarData;

  try {
    [yahooData, edgarData] = await Promise.all([
      fetchYahoo(sym),
      getEDGARData(sym),   // returns null if unavailable — non-blocking
    ]);
  } catch (err) {
    // Yahoo failed — serve stale cache if available
    const cached = getStock(sym);
    if (cached) return res.json({ stock: cached, fromCache: true, stale: true });
    return res.status(503).json({ error: err.message });
  }

  const name = yahooData.quote.longName || yahooData.quote.shortName || sym;
  saveStock(sym, name, { quote: yahooData.quote, summary: yahooData.summary, edgar: edgarData });

  res.json({ stock: getStock(sym), fromCache: false });
});

app.get('/api/stocks',        requireAuth, (_q, r) => r.json({ stocks: getAllStocks() }));
app.get('/api/stock/:symbol', requireAuth, (req, res) => {
  const s = getStock(req.params.symbol);
  if (!s) return res.status(404).json({ error: 'السهم غير موجود' });
  res.json({ stock: s });
});
app.delete('/api/stock/:symbol', requireAuth, (req, res) => { deleteStock(req.params.symbol); res.json({ success: true }); });
app.put('/api/stock/:symbol/notes', requireAuth, (req, res) => { updateNotes(req.params.symbol, req.body.notes || ''); res.json({ success: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Stock Analyst → http://localhost:${PORT}`));
