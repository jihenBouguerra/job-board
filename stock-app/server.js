import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { saveStock, getStock, getAllStocks, deleteStock, updateNotes } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

// All available free modules from Yahoo Finance quoteSummary
const MODULES = [
  'assetProfile',
  'financialData',
  'defaultKeyStatistics',
  'summaryDetail',
  'price',
  'incomeStatementHistoryQuarterly',
  'cashflowStatementHistoryQuarterly',
  'balanceSheetHistoryQuarterly',
  'earningsHistory',
  'recommendationTrend',
  'upgradeDowngradeHistory',
  'majorHoldersBreakdown',
  'institutionOwnership',
  'insiderHolders',
  'insiderTransactions',
  'calendarEvents',
  'earningsTrend',
].join(',');

function raceTimeout(promise, ms = 10_000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Request timeout')), ms)),
  ]);
}

async function fetchStockData(symbol) {
  const sym = encodeURIComponent(symbol);

  const [chartRes, summaryRes] = await Promise.allSettled([
    raceTimeout(fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, { headers: YF_HEADERS })),
    raceTimeout(fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${MODULES}`, { headers: YF_HEADERS })),
  ]);

  let quote = null;
  if (chartRes.status === 'fulfilled' && chartRes.value.ok) {
    const json = await chartRes.value.json().catch(() => null);
    const meta = json?.chart?.result?.[0]?.meta;
    if (meta?.symbol) {
      quote = {
        symbol: meta.symbol,
        longName: meta.longName || meta.shortName || null,
        shortName: meta.shortName || null,
        regularMarketPrice: meta.regularMarketPrice ?? null,
        regularMarketChange: meta.chartPreviousClose != null
          ? (meta.regularMarketPrice - meta.chartPreviousClose)
          : null,
        regularMarketChangePercent: meta.chartPreviousClose
          ? (meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose
          : null,
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
    const status = chartRes.status === 'rejected' ? chartRes.reason?.message : 'HTTP Error';
    throw new Error(status === 'Request timeout' ? 'انتهت مهلة الاتصال بـ Yahoo Finance' : 'السهم غير موجود أو يتعذر الوصول إلى Yahoo Finance من هذه الشبكة');
  }

  return { quote, summary };
}

/* ═══ ROUTES ═══════════════════════════════════════════════════════════════ */

app.post('/api/stock/analyze', async (req, res) => {
  const { symbol, forceRefresh = false } = req.body;
  if (!symbol) return res.status(400).json({ error: 'رمز السهم مطلوب' });

  const sym = symbol.toUpperCase().trim();

  if (!forceRefresh) {
    const cached = getStock(sym);
    if (cached) {
      const ageH = (Date.now() - new Date(cached.last_updated)) / 3_600_000;
      if (ageH < 6) return res.json({ stock: cached, fromCache: true });
    }
  }

  try {
    const data = await fetchStockData(sym);
    const name = data.quote.longName || data.quote.shortName || sym;
    saveStock(sym, name, data);
    res.json({ stock: getStock(sym), fromCache: false });
  } catch (err) {
    const cached = getStock(sym);
    if (cached) return res.json({ stock: cached, fromCache: true, stale: true });
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/stocks',        (_q, res) => res.json({ stocks: getAllStocks() }));
app.get('/api/stock/:symbol', (req, res) => {
  const s = getStock(req.params.symbol);
  if (!s) return res.status(404).json({ error: 'السهم غير موجود' });
  res.json({ stock: s });
});
app.delete('/api/stock/:symbol', (req, res) => { deleteStock(req.params.symbol); res.json({ success: true }); });
app.put('/api/stock/:symbol/notes', (req, res) => { updateNotes(req.params.symbol, req.body.notes || ''); res.json({ success: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Stock Analyst App → http://localhost:${PORT}`));
