/**
 * SEC EDGAR data module
 * Free, official US government source — no API key needed.
 * Provides verified financial statement data for US-listed companies.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const TICKERS_CACHE = join(__dir, 'sec_tickers_cache.json');

// SEC requires a descriptive User-Agent with contact info
const SEC_UA = 'StockAnalystApp/1.0 (contact@stockanalyst.local)';
const SEC_HEADERS = { 'User-Agent': SEC_UA, 'Accept': 'application/json' };

function raceTimeout(p, ms = 12_000) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

// ─── Ticker → CIK mapping (cached locally 24h) ────────────────────────────
let _tickersMap = null;

async function loadTickersMap() {
  if (_tickersMap) return _tickersMap;

  if (existsSync(TICKERS_CACHE)) {
    try {
      const c = JSON.parse(readFileSync(TICKERS_CACHE, 'utf-8'));
      if (Date.now() - c.ts < 86_400_000) { _tickersMap = c.data; return _tickersMap; }
    } catch (_) {}
  }

  const res = await raceTimeout(
    fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS })
  );
  if (!res.ok) throw new Error(`SEC tickers: HTTP ${res.status}`);
  const json = await res.json();

  _tickersMap = {};
  for (const e of Object.values(json)) {
    _tickersMap[e.ticker.toUpperCase()] = String(e.cik_str).padStart(10, '0');
  }
  try { writeFileSync(TICKERS_CACHE, JSON.stringify({ ts: Date.now(), data: _tickersMap })); } catch (_) {}
  return _tickersMap;
}

export async function getCIK(symbol) {
  try {
    const map = await loadTickersMap();
    return map[symbol.toUpperCase()] ?? null;
  } catch { return null; }
}

// ─── Raw EDGAR concept reader ───────────────────────────────────────────────
function vals(gaap, concepts, unit = 'USD') {
  for (const c of [].concat(concepts)) {
    const v = gaap?.[c]?.units?.[unit];
    if (v?.length) return v;
  }
  return [];
}

/**
 * Extract individual quarters (3-month periods) from 10-Q filings.
 * EDGAR quarterly reports can be cumulative YTD; we filter by duration ≈90 days.
 */
function quarterly(data, n = 4) {
  const seen = new Set();
  return data
    .filter(d => {
      if (d.form !== '10-Q' && d.form !== '10-Q/A') return false;
      if (!d.start) return false;
      const days = (new Date(d.end) - new Date(d.start)) / 86_400_000;
      return days >= 55 && days <= 110;
    })
    .sort((a, b) => new Date(b.end) - new Date(a.end))
    .filter(d => { if (seen.has(d.end)) return false; seen.add(d.end); return true; })
    .slice(0, n);
}

/**
 * Get most recent balance sheet value (instant point-in-time, from 10-Q or 10-K).
 */
function latest(data) {
  return data
    .filter(d => ['10-Q','10-Q/A','10-K','10-K/A'].includes(d.form))
    .sort((a, b) => new Date(b.end) - new Date(a.end))[0]?.val ?? null;
}

// ─── Extract structured data from raw EDGAR company facts ──────────────────
function extract(facts) {
  const gaap = facts?.['us-gaap'];
  if (!gaap) return null;

  // Income statement
  const revData = vals(gaap, [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueGoodsNet',
  ]);
  const niData  = vals(gaap, ['NetIncomeLoss']);
  const epsData = vals(gaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], 'USD/shares');
  const gpData  = vals(gaap, ['GrossProfit']);
  const oiData  = vals(gaap, ['OperatingIncomeLoss']);

  // Cash flow
  const ocfData  = vals(gaap, ['NetCashProvidedByUsedInOperatingActivities']);
  const capexData= vals(gaap, ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpendituresIncurredButNotYetPaid']);
  const daData   = vals(gaap, ['DepreciationDepletionAndAmortization', 'Depreciation', 'DepreciationAndAmortization']);

  // Balance sheet (instant values)
  const debtData  = vals(gaap, ['LongTermDebt', 'LongTermDebtNoncurrent', 'DebtAndCapitalLeaseObligations', 'LongTermDebtAndCapitalLeaseObligations']);
  const stdData   = vals(gaap, ['ShortTermBorrowings', 'NotesPayableCurrent', 'CommercialPaper']);
  const cashData  = vals(gaap, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsAndShortTermInvestments', 'Cash']);
  const eqData    = vals(gaap, ['StockholdersEquity', 'StockholdersEquityAttributableToParent']);
  const assetData = vals(gaap, ['Assets']);
  const liabData  = vals(gaap, ['Liabilities']);
  const intData   = vals(gaap, ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet']);
  const goodwData = vals(gaap, ['Goodwill']);
  const rdData    = vals(gaap, ['ResearchAndDevelopmentExpense']);
  const taxData   = vals(gaap, ['IncomeTaxExpenseBenefit']);
  const intExpData= vals(gaap, ['InterestExpense', 'InterestAndDebtExpense']);
  const divData   = vals(gaap, ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends']);
  const sharesData= vals(gaap, ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'], 'shares');

  // Quarterly extractions
  const qRev  = quarterly(revData);
  const qNI   = quarterly(niData);
  const qEPS  = quarterly(epsData);
  const qGP   = quarterly(gpData);
  const qOI   = quarterly(oiData);
  const qOCF  = quarterly(ocfData);
  const qCapex= quarterly(capexData);
  const qDA   = quarterly(daData);
  const qRD   = quarterly(rdData);
  const qTax  = quarterly(taxData);
  const qIntEx= quarterly(intExpData);

  // Balance sheet latest
  const ltDebt   = latest(debtData);
  const stDebt   = latest(stdData);
  const totalDebt= (ltDebt ?? 0) + (stDebt ?? 0) || ltDebt;
  const cash     = latest(cashData);
  const equity   = latest(eqData);
  const assets   = latest(assetData);
  const liabs    = latest(liabData);
  const intangibles = latest(intData);
  const goodwill = latest(goodwData);
  const shares   = latest(sharesData);
  const divPaid  = latest(divData);

  // TTM EBITDA = TTM Operating Income + TTM D&A
  const ttmOI = qOI.length >= 4 ? qOI.slice(0,4).reduce((s,q) => s + q.val, 0) : null;
  const ttmDA = qDA.length >= 4 ? qDA.slice(0,4).reduce((s,q) => s + q.val, 0) : null;
  const ebitda = ttmOI != null && ttmDA != null ? ttmOI + ttmDA : null;

  // TTM FCF = TTM OCF - TTM CapEx
  const ttmOCF   = qOCF.length  >= 4 ? qOCF.slice(0,4).reduce((s,q) => s + q.val, 0) : null;
  const ttmCapex = qCapex.length >= 4 ? qCapex.slice(0,4).reduce((s,q) => s + q.val, 0) : null;
  const fcf = ttmOCF != null && ttmCapex != null ? ttmOCF - ttmCapex : null;

  // TTM Revenue, Net Income, R&D, Interest Expense
  const ttmRev   = qRev.length  >= 4 ? qRev.slice(0,4).reduce((s,q) => s + q.val, 0) : null;
  const ttmNI    = qNI.length   >= 4 ? qNI.slice(0,4).reduce((s,q) => s + q.val, 0)  : null;
  const ttmRD    = qRD.length   >= 4 ? qRD.slice(0,4).reduce((s,q) => s + q.val, 0)  : null;
  const ttmIntEx = qIntEx.length>= 4 ? qIntEx.slice(0,4).reduce((s,q) => s + q.val, 0): null;

  return {
    source: 'SEC EDGAR',
    cik: facts.cik,
    entityName: facts.entityName,

    // Quarterly income statement (last 4 quarters, individual)
    quarterlyRevenue:  qRev.map(d => ({ date: d.end, value: d.val, filed: d.filed })),
    quarterlyNetIncome:qNI.map(d => ({ date: d.end, value: d.val })),
    quarterlyEPS:      qEPS.map(d => ({ date: d.end, value: d.val })),
    quarterlyGrossProfit: qGP.map(d => ({ date: d.end, value: d.val })),
    quarterlyOpIncome: qOI.map(d => ({ date: d.end, value: d.val })),
    quarterlyOCF:      qOCF.map(d => ({ date: d.end, value: d.val })),
    quarterlyCapex:    qCapex.map(d => ({ date: d.end, value: d.val })),

    // TTM aggregates
    ttmRevenue: ttmRev,
    ttmNetIncome: ttmNI,
    ttmEbitda: ebitda,
    ttmOCF,
    ttmCapex,
    ttmFCF: fcf,
    ttmRnD: ttmRD,
    ttmInterestExpense: ttmIntEx,

    // Balance sheet (latest available)
    totalDebt,
    longTermDebt: ltDebt,
    shortTermDebt: stDebt,
    cash,
    netDebt: totalDebt != null && cash != null ? totalDebt - cash : null,
    equity,
    totalAssets: assets,
    totalLiabilities: liabs,
    intangibles,
    goodwill,
    sharesOutstanding: shares,
    dividendsPaid: divPaid,

    // Derived ratios from EDGAR data
    debtToEbitda: totalDebt != null && ebitda != null && ebitda > 0 ? +(totalDebt / ebitda).toFixed(2) : null,
    debtToEquity: totalDebt != null && equity != null && equity > 0 ? +(totalDebt / equity).toFixed(2) : null,
    roeEdgar: ttmNI != null && equity != null && equity > 0 ? +(ttmNI / equity).toFixed(4) : null,
    netMarginEdgar: ttmNI != null && ttmRev != null && ttmRev > 0 ? +(ttmNI / ttmRev).toFixed(4) : null,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────
export async function getEDGARData(symbol) {
  try {
    const cik = await getCIK(symbol);
    if (!cik) return null;

    const res = await raceTimeout(
      fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_HEADERS }),
      15_000
    );
    if (!res.ok) return null;

    const facts = await res.json();
    return extract(facts);
  } catch (err) {
    console.warn(`[EDGAR] ${symbol}: ${err.message}`);
    return null;
  }
}
