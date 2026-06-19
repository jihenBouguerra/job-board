/* ═══ HELPERS ═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9)  return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3)  return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(dec);
}
const fmtPct = (n, already = false) =>
  n == null ? 'N/A' : `${(already ? n : n * 100).toFixed(2)}%`;
const fmtUSD = n =>
  n == null ? 'N/A' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = ts => {
  if (!ts) return 'N/A';
  const d = typeof ts === 'number' ? new Date(ts < 1e10 ? ts * 1000 : ts) : new Date(ts);
  return isNaN(d) ? 'N/A' : d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' });
};
const raw = v => (typeof v === 'object' && v !== null) ? (v.raw ?? v) : v;
const na  = v => (v == null || v === '') ? 'N/A' : v;

function statusCls(value, good, bad, higherBetter = true) {
  if (value == null) return '';
  return higherBetter
    ? (value >= good ? 'green' : value <= bad ? 'red' : 'yellow')
    : (value <= good ? 'green' : value >= bad ? 'red' : 'yellow');
}
const icon = cls => cls === 'green' ? '🟢' : cls === 'red' ? '🔴' : cls === 'yellow' ? '🟡' : '⚪';

function gradeClass(g = '') {
  const gl = g.toLowerCase();
  if (['buy','strong buy','outperform','overweight','positive'].some(k => gl.includes(k))) return 'buy';
  if (['sell','underperform','underweight','negative','reduce'].some(k => gl.includes(k))) return 'sell';
  return 'hold';
}

/* ═══ STATE ═══════════════════════════════════════════════════════════════ */
let currentSymbol = null;

/* ═══ API ════════════════════════════════════════════════════════════════ */
async function analyzeStock(symbol, forceRefresh = false) {
  showState('loading');
  try {
    const res = await fetch('/api/stock/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, forceRefresh }),
    });
    const json = await res.json();
    if (res.status === 401) { $('loginGate').hidden = false; return null; }
    if (!res.ok) throw new Error(json.error || 'خطأ غير معروف');
    return json;
  } catch (e) {
    showState('error', e.message);
    return null;
  }
}

async function loadSavedList() {
  try {
    const res = await fetch('/api/stocks');
    const { stocks } = await res.json();
    renderSavedList(stocks || []);
  } catch (_) {}
}

async function deleteStock(symbol) {
  await fetch(`/api/stock/${symbol}`, { method: 'DELETE' });
  if (currentSymbol === symbol) { currentSymbol = null; showState('empty'); }
  loadSavedList();
}

/* ═══ SHOW/HIDE ══════════════════════════════════════════════════════════ */
function showState(which, msg = '') {
  $('loadingState').hidden   = which !== 'loading';
  $('errorState').hidden     = which !== 'error';
  $('analysisContent').hidden = which !== 'analysis';
  $('emptyState').hidden     = which !== 'empty';
  if (msg) $('errorMsg').textContent = msg;
}

/* ═══ SAVED LIST ═════════════════════════════════════════════════════════ */
function renderSavedList(stocks) {
  const el = $('savedList');
  if (!stocks.length) { el.innerHTML = '<p class="empty-saved">لا توجد أسهم محفوظة بعد</p>'; return; }
  el.innerHTML = stocks.map(s => `
    <div class="saved-item ${s.symbol === currentSymbol ? 'active' : ''}" data-sym="${s.symbol}">
      <span class="saved-sym">${s.symbol}</span>
      <div class="saved-info">
        <div class="saved-name">${s.name || s.symbol}</div>
        <div class="saved-date">${fmtDate(s.last_updated)}</div>
      </div>
      <button class="saved-del" data-del="${s.symbol}">×</button>
    </div>`).join('');

  el.querySelectorAll('.saved-item').forEach(item =>
    item.addEventListener('click', e => {
      if (e.target.closest('.saved-del')) return;
      closeSidebar(); loadAndShow(item.dataset.sym);
    }));
  el.querySelectorAll('.saved-del').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`حذف ${btn.dataset.del}؟`)) deleteStock(btn.dataset.del);
    }));
}

/* ═══ MAIN FLOW ══════════════════════════════════════════════════════════ */
async function loadAndShow(symbol, forceRefresh = false) {
  currentSymbol = symbol.toUpperCase();
  $('searchInput').value = currentSymbol;
  const result = await analyzeStock(currentSymbol, forceRefresh);
  if (!result) return;
  renderAnalysis(result);
  loadSavedList();
}

/* ═══ RENDER ═════════════════════════════════════════════════════════════ */
function renderAnalysis({ stock, fromCache, stale, isDemo }) {
  const d   = stock.data;
  const q   = d.quote   || {};
  const s   = d.summary || {};
  const eg  = d.edgar   || null;   // SEC EDGAR — may be null for non-US or unavailable
  const ap  = s.assetProfile  || {};
  const fd  = s.financialData || {};
  const ks  = s.defaultKeyStatistics || {};
  const sd  = s.summaryDetail || {};
  const pr  = s.price || {};
  const iq  = s.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  const cq  = s.cashflowStatementHistoryQuarterly?.cashflowStatements   || [];
  const bq  = s.balanceSheetHistoryQuarterly?.balanceSheetStatements    || [];
  const eh  = s.earningsHistory?.history || [];
  const rt  = s.recommendationTrend?.trend || [];
  const ug  = s.upgradeDowngradeHistory?.history || [];
  const mh  = s.majorHoldersBreakdown || {};
  const io  = s.institutionOwnership?.ownershipList || [];
  const ih  = s.insiderHolders?.holders || [];
  const it  = s.insiderTransactions?.transactions || [];
  const ce  = s.calendarEvents?.earnings || {};
  const et  = s.earningsTrend?.trend || [];

  const price    = q.regularMarketPrice ?? raw(pr.regularMarketPrice);
  const change   = q.regularMarketChange;
  const changePct= q.regularMarketChangePercent;
  const up       = (change ?? 0) >= 0;

  /* --- CACHE BADGE --- */
  let cacheBadge = '';
  if (isDemo) {
    cacheBadge = `<div class="cache-badge" style="background:rgba(99,102,241,0.15);color:#818cf8;border-color:rgba(99,102,241,0.3)">🧪 بيانات تجريبية — API محجوب في هذه البيئة، سيعمل على جهازك المحلي</div>`;
  } else if (stale) {
    cacheBadge = `<div class="cache-badge" style="background:rgba(239,68,68,0.12);color:#ef4444;border-color:rgba(239,68,68,0.3)">⚠️ بيانات قديمة — API غير متاح حالياً</div>`;
  } else if (fromCache) {
    const h = Math.round((Date.now() - new Date(stock.last_updated)) / 3_600_000);
    cacheBadge = `<div class="cache-badge">⏱ محفوظة · منذ ${h} ساعة${h === 0 ? ' (حديثة)' : ''}</div>`;
  }

  /* --- EDGAR BADGE --- */
  const edgarBadge = eg
    ? `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.25);border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700">🏛️ SEC EDGAR</span>`
    : '';

  /* --- HERO CARD --- */
  $('stockHero').innerHTML = `
    <div class="hero-top">
      <div class="hero-name">
        <h2>${stock.name || stock.symbol}</h2>
        <p>${stock.symbol} · ${na(ap.exchange || q.fullExchangeName)} · ${na(ap.sector || sd.sector)}</p>
        ${ap.website ? `<a href="${ap.website}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent)">${ap.website}</a>` : ''}
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${edgarBadge}</div>
      </div>
      <div class="hero-price-block">
        <div class="hero-price">${price != null ? fmtUSD(price) : 'N/A'}</div>
        <div class="hero-change ${up ? 'up' : 'down'}">
          ${up ? '▲' : '▼'} ${change != null ? Math.abs(change).toFixed(2) : 'N/A'} (${changePct != null ? (changePct * 100).toFixed(2) + '%' : 'N/A'})
        </div>
      </div>
    </div>
    <div class="hero-stats">
      ${heroStat('Market Cap',     `$${fmt(q.marketCap)}`)}
      ${heroStat('Volume',         fmt(q.regularMarketVolume, 0))}
      ${heroStat('Avg Vol (3M)',   fmt(q.averageDailyVolume3Month, 0))}
      ${heroStat('52W High',       fmtUSD(q.fiftyTwoWeekHigh), 'text-green')}
      ${heroStat('52W Low',        fmtUSD(q.fiftyTwoWeekLow), 'text-red')}
      ${heroStat('Beta',           ks.beta != null ? ks.beta.toFixed(2) : 'N/A')}
      ${heroStat('Currency',       q.currency || 'N/A')}
      ${heroStat('Exchange',       na(q.fullExchangeName))}
    </div>
    ${cacheBadge}`;

  /* --- NOTES --- */
  $('notesInput').value = stock.notes || '';

  /* --- 8 SECTIONS --- */
  $('sections').innerHTML = [
    sec1(ap, q, fd, sd, eg),
    sec2(mh, io, ih, it),
    sec3(iq, cq, bq, eg),
    sec4(fd, ks, sd, bq, cq, eg),
    sec5(q, ks, ug, eh, ce, et),
    sec6(rt, fd, q),
    sec7(fd, ks, q, sd),
    sec8(fd, ks, rt, q, eg),
  ].join('');

  addExpandListeners();
  showState('analysis');
}

function heroStat(label, val, cls = '') {
  return `<div class="hero-stat"><div class="hero-stat-label">${label}</div><div class="hero-stat-value ${cls}">${val}</div></div>`;
}

/* ─── SEC 1: Business Model & Moat ─────────────────────────────────────── */
function sec1(ap, q, fd, sd, eg) {
  const mcap = q.marketCap;
  const mcapCat = mcap >= 200e9 ? 'Mega Cap (>200B)' : mcap >= 10e9 ? 'Large Cap (10-200B)' : mcap >= 2e9 ? 'Mid Cap (2-10B)' : mcap ? 'Small Cap (<2B)' : 'N/A';
  const desc = ap.longBusinessSummary || ap.description || 'وصف غير متاح';

  // Prefer EDGAR TTM revenue if available (more official)
  const revTTM = eg?.ttmRevenue ?? raw(fd.totalRevenue);
  const fcf    = eg?.ttmFCF     ?? raw(fd.freeCashflow);
  const rndTTM = eg?.ttmRnD;

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">01</span> 🔍 نموذج العمل والتميز (The Moat)</h3>
    <div class="metric-grid" style="margin-bottom:14px">
      ${metric('Sector',            ap.sector)}
      ${metric('Industry',          ap.industry)}
      ${metric('Country',           ap.country)}
      ${metric('Employees',         ap.fullTimeEmployees ? ap.fullTimeEmployees.toLocaleString() : null)}
      ${metric('Market Cap Cat.',   mcapCat)}
      ${metric('Market Cap',        `$${fmt(q.marketCap)}`)}
      ${metric('Revenue TTM',       `$${fmt(revTTM)}`, '', eg?.ttmRevenue ? '🏛️ SEC EDGAR' : '')}
      ${metric('Gross Margin',      fmtPct(fd.grossMargins),     statusCls(fd.grossMargins, 0.4, 0.2))}
      ${metric('Operating Margin',  fmtPct(fd.operatingMargins), statusCls(fd.operatingMargins, 0.15, 0.05))}
      ${metric('Net Margin',        fmtPct(fd.profitMargins),    statusCls(fd.profitMargins, 0.15, 0.03))}
      ${metric('Free Cash Flow',    `$${fmt(fcf)}`, statusCls(fcf, 1, 0), eg?.ttmFCF ? '🏛️ SEC EDGAR' : '')}
      ${rndTTM ? metric('R&D Expense TTM', `$${fmt(rndTTM)}`, '', '🏛️ SEC EDGAR') : ''}
      ${metric('Current Ratio',     sd.currentRatio != null ? raw(sd.currentRatio).toFixed(2) : null, statusCls(raw(sd.currentRatio), 2, 1))}
    </div>
    <div class="collapsible">
      <div class="text-collapsed" data-full="${encodeURIComponent(desc)}">${desc}</div>
      <button class="expand-btn">▼ اقرأ وصف الشركة كاملاً</button>
    </div>
  </div>`;
}

/* ─── SEC 2: Alliances & Ownership ─────────────────────────────────────── */
function sec2(mh, io, ih, it) {
  const instPct = mh.institutionsPercentHeld;
  const insPct  = mh.insidersPercentHeld;
  const instCls = statusCls(instPct, 0.5, 0.1);
  const insCls  = statusCls(insPct, 0.05, 0.005);

  const topInst = io.slice(0, 6).map(o => `
    <tr>
      <td>${na(o.organization)}</td>
      <td>${fmtPct(raw(o.pctHeld))}</td>
      <td>$${fmt(raw(o.value))}</td>
      <td>${fmtDate(raw(o.reportDate ?? o.date))}</td>
    </tr>`).join('');

  const recentIT = it.slice(0, 4).map(t => `
    <div class="analyst-item">
      <div>
        <div style="font-weight:700;font-size:13px">${na(t.filerName)}</div>
        <div class="analyst-firm">${na(t.filerRelation)} · ${fmtDate(raw(t.startDate))}</div>
      </div>
      <span class="analyst-grade grade-${t.transactionText?.includes('Sale') || t.transactionText?.includes('Sell') ? 'sell' : 'buy'}" style="font-size:11px">${na(t.transactionText)?.split('(')[0]?.trim() || 'N/A'}</span>
    </div>`).join('');

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">02</span> 🤝 الملكية المؤسسية والداخلية</h3>
    <div class="metric-grid" style="margin-bottom:16px">
      ${metric('Institutional %',  fmtPct(instPct), instCls, icon(instCls) + ' ' + (instPct >= 0.5 ? 'ثقة مؤسسية عالية' : instPct >= 0.3 ? 'معتدلة' : 'منخفضة'))}
      ${metric('Insider %',        fmtPct(insPct),  insCls,  icon(insCls) + ' ' + (insPct >= 0.05 ? 'مشاركة الإدارة جيدة' : 'ملكية محدودة'))}
      ${metric('Institutions #',   mh.institutionsCount != null ? mh.institutionsCount.toLocaleString() : null)}
      ${metric('Float %',          mh.institutionsPercentHeld && mh.insidersPercentHeld ? fmtPct(1 - mh.institutionsPercentHeld - mh.insidersPercentHeld) : null)}
    </div>
    <p style="font-size:11px;color:var(--muted);margin-bottom:10px">💡 وفق دراسة ECB 2025 — ملكية الإدارة الداخلية >5% ترتبط بأداء أعلى +4.6% سنوياً</p>

    ${topInst ? `
    <p style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:8px">أكبر المساهمين المؤسسيين</p>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>المؤسسة</th><th>% الملكية</th><th>القيمة</th><th>آخر تحديث</th></tr></thead>
        <tbody>${topInst}</tbody>
      </table>
    </div>` : ''}

    ${recentIT ? `
    <p style="font-size:12px;font-weight:700;color:var(--accent);margin:14px 0 8px">آخر معاملات المطلعين (Insider Transactions)</p>
    <div class="analyst-list">${recentIT}</div>` : ''}
  </div>`;
}

/* ─── SEC 3: Financial Reports ──────────────────────────────────────────── */
function sec3(iq, cq, bq, eg) {
  /* Use SEC EDGAR quarterly data when available (official 10-Q filings) */
  const useEdgar = eg?.quarterlyRevenue?.length >= 2;
  const srcLabel = useEdgar
    ? `<span style="font-size:11px;font-weight:700;color:#22c55e">🏛️ المصدر: SEC EDGAR (تقارير 10-Q الرسمية)</span>`
    : `<span style="font-size:11px;color:var(--muted)">المصدر: Yahoo Finance</span>`;

  let incomeRows = '';
  let revTrend = '';

  if (useEdgar) {
    // Build table from EDGAR quarterly data (last 4 quarters)
    const edgarQtrs = eg.quarterlyRevenue.slice(0, 4);
    incomeRows = edgarQtrs.map((r, i) => {
      const ni  = eg.quarterlyNetIncome?.[i]?.value;
      const eps = eg.quarterlyEPS?.[i]?.value;
      const gp  = eg.quarterlyGrossProfit?.[i]?.value;
      const dateStr = r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A';
      const prevRev = edgarQtrs[i+1]?.value;
      const grw = r.value && prevRev ? ((r.value - prevRev) / Math.abs(prevRev) * 100) : null;
      const grwHtml = grw != null ? `<span class="${grw >= 0 ? 'text-green' : 'text-red'}" style="font-size:11px"> ${grw >= 0 ? '▲' : '▼'}${Math.abs(grw).toFixed(1)}%</span>` : '';
      const niCls = ni == null ? '' : ni >= 0 ? 'text-green' : 'text-red';
      const gpStr = gp != null ? `$${fmt(gp)}` : 'N/A';
      return `<tr><td>${dateStr}</td><td>$${fmt(r.value)}${grwHtml}</td><td>${gpStr}</td><td class="${niCls}">$${fmt(ni)}</td><td>${eps != null ? '$' + (+eps).toFixed(2) : 'N/A'}</td></tr>`;
    }).join('');

    const vals = edgarQtrs.map(r => r.value).filter(v => v != null);
    if (vals.length >= 2) revTrend = vals[0] > vals[vals.length-1] ? '🟢 نمو إيجابي في الإيرادات' : vals[0] < vals[vals.length-1] ? '🔴 تراجع في الإيرادات' : '🟡 إيرادات مستقرة';
  } else {
    // Fallback to Yahoo Finance
    const last3 = iq.slice(0, 3);
    if (!last3.length) return `
      <div class="card">
        <h3 class="card-title"><span class="section-num">03</span> 📊 التقارير المالية الثلاثة الأخيرة</h3>
        <p class="text-muted" style="font-size:13px">البيانات غير متاحة</p>
      </div>`;
    incomeRows = last3.map((q, i) => {
      const rev = raw(q.totalRevenue), ni = raw(q.netIncome), eps = raw(q.dilutedEps ?? q.basicEps);
      const date = q.endDate ? new Date(raw(q.endDate) * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A';
      const prevRev = i < last3.length - 1 ? raw(last3[i+1].totalRevenue) : null;
      const grw = rev && prevRev ? ((rev - prevRev) / Math.abs(prevRev) * 100) : null;
      const grwHtml = grw != null ? `<span class="${grw >= 0 ? 'text-green' : 'text-red'}" style="font-size:11px"> ${grw >= 0 ? '▲' : '▼'}${Math.abs(grw).toFixed(1)}%</span>` : '';
      const niCls = ni == null ? '' : ni >= 0 ? 'text-green' : 'text-red';
      return `<tr><td>${date}</td><td>$${fmt(rev)}${grwHtml}</td><td>N/A</td><td class="${niCls}">$${fmt(ni)}</td><td>${eps != null ? '$' + eps.toFixed(2) : 'N/A'}</td></tr>`;
    }).join('');
    const vals = last3.map(q => raw(q.totalRevenue)).filter(v => v != null);
    if (vals.length >= 2) revTrend = vals[0] > vals[vals.length-1] ? '🟢 نمو إيجابي في الإيرادات' : vals[0] < vals[vals.length-1] ? '🔴 تراجع في الإيرادات' : '🟡 إيرادات مستقرة';
  }

  /* Cash flow table — prefer EDGAR */
  let cfRows = '';
  if (eg?.quarterlyOCF?.length >= 2) {
    cfRows = eg.quarterlyOCF.slice(0, 4).map((ocf, i) => {
      const capex = eg.quarterlyCapex?.[i]?.value;
      const fcf   = ocf.value != null && capex != null ? ocf.value - capex : null;
      const dateStr = ocf.date ? new Date(ocf.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A';
      const fcfCls  = fcf == null ? '' : fcf >= 0 ? 'text-green' : 'text-red';
      const capexStr= capex != null ? `-$${fmt(capex)}` : 'N/A';
      return `<tr><td>${dateStr}</td><td>$${fmt(ocf.value)}</td><td>${capexStr}</td><td class="${fcfCls}">$${fcf != null ? fmt(fcf) : 'N/A'}</td></tr>`;
    }).join('');
  } else if (cq.length) {
    cfRows = cq.slice(0, 3).map(cf => {
      const date = cf.endDate ? new Date(raw(cf.endDate) * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A';
      const ops  = raw(cf.totalCashFromOperatingActivities ?? cf.operatingCashflow);
      const capex= raw(cf.capitalExpenditures);
      const fcf  = ops != null && capex != null ? ops + capex : null; // Yahoo: capex is negative
      const fcfCls = fcf == null ? '' : fcf >= 0 ? 'text-green' : 'text-red';
      return `<tr><td>${date}</td><td>$${fmt(ops)}</td><td>$${fmt(capex)}</td><td class="${fcfCls}">$${fcf != null ? fmt(fcf) : 'N/A'}</td></tr>`;
    }).join('');
  }

  /* Balance sheet snapshot from EDGAR */
  const bsHtml = eg ? `
    <p class="subsection-label" style="margin-top:14px">الميزانية العمومية (آخر تقرير) <span style="font-size:11px;color:#22c55e">🏛️ SEC EDGAR</span></p>
    <div class="metric-grid">
      ${metric('Total Assets',      `$${fmt(eg.totalAssets)}`)}
      ${metric('Total Liabilities', `$${fmt(eg.totalLiabilities)}`)}
      ${metric('Stockholders Eq.',  `$${fmt(eg.equity)}`, statusCls(eg.equity, 0, -1))}
      ${metric('Long-Term Debt',    `$${fmt(eg.longTermDebt)}`)}
      ${metric('Short-Term Debt',   `$${fmt(eg.shortTermDebt)}`)}
      ${metric('Cash & Equiv.',     `$${fmt(eg.cash)}`, 'green')}
      ${metric('Net Debt',          eg.netDebt != null ? `$${fmt(eg.netDebt)}` : null, statusCls(eg.netDebt, 0, eg.cash ?? 0, false))}
      ${metric('Goodwill',          eg.goodwill != null ? `$${fmt(eg.goodwill)}` : null)}
    </div>` : '';

  const colHeader = useEdgar
    ? `<thead><tr><th>الربع</th><th>الإيرادات</th><th>Gross Profit</th><th>صافي الربح</th><th>EPS</th></tr></thead>`
    : `<thead><tr><th>الربع</th><th>الإيرادات</th><th>Gross Profit</th><th>صافي الربح</th><th>EPS</th></tr></thead>`;

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">03</span> 📊 تحليل التقارير الربعية الأخيرة ${srcLabel}</h3>

    <div style="overflow-x:auto">
      <table class="data-table">
        ${colHeader}
        <tbody>${incomeRows}</tbody>
      </table>
    </div>
    ${revTrend ? `<p style="font-size:13px;font-weight:600;margin:10px 0">${revTrend}</p>` : ''}

    ${cfRows ? `
    <p class="subsection-label" style="margin-top:14px">التدفقات النقدية ${useEdgar ? '<span style="font-size:11px;color:#22c55e">🏛️ SEC EDGAR</span>' : ''}</p>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>الربع</th><th>التدفق التشغيلي</th><th>CapEx</th><th>Free Cash Flow</th></tr></thead>
        <tbody>${cfRows}</tbody>
      </table>
    </div>` : ''}

    ${bsHtml}
  </div>`;
}

/* ─── SEC 4: Financial Analysis + BAM ──────────────────────────────────── */
function sec4(fd, ks, sd, bq, cq, eg) {
  const pe    = raw(ks.trailingPE);
  const fwdPE = raw(ks.forwardPE ?? fd.forwardPE);
  const peg   = raw(ks.pegRatio);
  const beta  = raw(ks.beta);
  const de    = fd.debtToEquity != null ? fd.debtToEquity / 100 : null; // Yahoo gives ×100
  const roe   = fd.returnOnEquity;
  const roa   = fd.returnOnAssets;
  const pMgn  = fd.profitMargins;
  const gMgn  = fd.grossMargins;
  const oMgn  = fd.operatingMargins;
  const eps   = raw(ks.trailingEps);
  const pb    = raw(ks.priceToBook);
  const ev    = raw(ks.enterpriseValue);
  const ebitda= raw(ks.enterpriseToEbitda);     // EV/EBITDA
  const evRev = raw(ks.enterpriseToRevenue);

  /* Debt/EBITDA — prefer SEC EDGAR (official, calculated from actual filings) */
  let debtEbitda = null;
  let debtEbitdaSource = '';
  if (eg?.debtToEbitda != null) {
    debtEbitda = String(eg.debtToEbitda);
    debtEbitdaSource = '🏛️ SEC EDGAR';
  } else if (bq.length && fd.ebitda != null) {
    const totalDebt = raw(bq[0].totalDebt ?? bq[0].longTermDebt);
    debtEbitda = totalDebt != null && raw(fd.ebitda) ? (totalDebt / Math.abs(raw(fd.ebitda))).toFixed(2) : null;
    debtEbitdaSource = 'Yahoo Finance';
  }

  /* EDGAR-calculated ratios */
  const edgarROE = eg?.roeEdgar;
  const edgarDE  = eg?.debtToEquity;

  /* BAM score — prefer EDGAR data for accuracy */
  let bamScore = 0, bamMax = 0;
  const bamRows = [];

  // ROE — prefer EDGAR calculation (from official filings)
  const roeVal = edgarROE ?? roe;
  const roeSource = edgarROE != null ? ' 🏛️' : '';
  if (roeVal != null) {
    bamMax += 35;
    const roePct = roeVal * 100;
    const cls = roePct >= 15 ? 'green' : roePct >= 10 ? 'yellow' : 'red';
    bamScore += cls === 'green' ? 35 : cls === 'yellow' ? 18 : 0;
    bamRows.push({ key: `ROE (>15% ✓)${roeSource}`, val: `${roePct.toFixed(1)}%`, cls });
  }
  if (debtEbitda != null) {
    bamMax += 35;
    const v = parseFloat(debtEbitda);
    const cls = v < 2 ? 'green' : v < 4 ? 'yellow' : 'red';
    bamScore += cls === 'green' ? 35 : cls === 'yellow' ? 18 : 0;
    bamRows.push({ key: `Debt/EBITDA (<2x ✓) ${debtEbitdaSource}`, val: `${debtEbitda}x`, cls });
  } else if (de != null) {
    bamMax += 35;
    const cls = de < 0.5 ? 'green' : de < 1.5 ? 'yellow' : 'red';
    bamScore += cls === 'green' ? 35 : cls === 'yellow' ? 18 : 0;
    bamRows.push({ key: 'Debt/Equity (<0.5x ✓)', val: `${de.toFixed(2)}x`, cls });
  }
  if (eps != null) {
    bamMax += 30;
    const cls = eps > 2 ? 'green' : eps > 0 ? 'yellow' : 'red';
    bamScore += cls === 'green' ? 30 : cls === 'yellow' ? 15 : 0;
    bamRows.push({ key: 'EPS (إيجابي ومتنامٍ ✓)', val: `$${eps.toFixed(2)}`, cls });
  }

  const bamPct = bamMax > 0 ? Math.round(bamScore / bamMax * 100) : null;
  const bamCls = bamPct >= 70 ? 'green' : bamPct >= 40 ? 'yellow' : 'red';
  const bamLabel = bamPct >= 70 ? '✓ اجتازت معايير الجودة' : bamPct >= 40 ? '◐ جزئياً' : '✗ لم تجتز المعايير';

  /* CAPE/PE */
  let capeDesc = '', capeReturn = '', capeCls = '';
  if (pe != null) {
    if (pe < 9.6)        { capeCls = 'low';  capeDesc = '🟢 مقيّم بأقل من قيمته'; capeReturn = 'عائد تاريخي توقعي ~9.8% سنوياً'; }
    else if (pe <= 25.1) { capeCls = 'mid';  capeDesc = '🟡 تقييم معقول';          capeReturn = 'عائد تاريخي معتدل'; }
    else                 { capeCls = 'high'; capeDesc = '🔴 تقييم مرتفع — خطر تصحيح'; capeReturn = 'عائد تاريخي توقعي ~0.5% (B.A.M)'; }
  }

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">04</span> 📈 التحليل المالي والتقييم</h3>

    <p class="subsection-label">أ) المؤشرات التقليدية</p>
    <div class="metric-grid" style="margin-bottom:16px">
      ${metric('Trailing P/E',   pe != null ? pe.toFixed(1) : null,     statusCls(pe, 5, 35, false))}
      ${metric('Forward P/E',    fwdPE != null ? fwdPE.toFixed(1) : null, statusCls(fwdPE, 5, 30, false))}
      ${metric('PEG Ratio',      peg != null ? peg.toFixed(2) : null,   statusCls(peg, 0.5, 2, false))}
      ${metric('Price/Book',     pb != null ? pb.toFixed(2) : null)}
      ${metric('EV/EBITDA',      ebitda != null ? ebitda.toFixed(1) : null, statusCls(ebitda, 5, 20, false))}
      ${metric('EV/Revenue',     evRev != null ? evRev.toFixed(2) : null)}
      ${metric('Beta',           beta != null ? beta.toFixed(2) : null, statusCls(beta, 0, 1.5, false))}
      ${metric('Trailing EPS',   eps != null ? `$${eps.toFixed(2)}` : null, statusCls(eps, 2, 0))}
    </div>

    <p class="subsection-label">ب) منهجية B.A.M — الجودة التشغيلية</p>
    ${bamPct != null ? `
    <div class="bam-score-box">
      <div class="bam-circle ${bamCls}">
        <span class="bam-pct">${bamPct}%</span>
        <span class="bam-label">B.A.M</span>
      </div>
      <div class="bam-details">
        <h4>${icon(bamCls)} ${bamLabel}</h4>
        ${bamRows.map(r => `
          <div class="bam-row">
            <span class="bam-row-key">${r.key}</span>
            <span class="bam-row-val ${r.cls}">${icon(r.cls)} ${r.val}</span>
          </div>`).join('')}
      </div>
    </div>` : '<p class="text-muted" style="font-size:13px">بيانات B.A.M غير متاحة</p>'}

    <p class="subsection-label" style="margin-top:16px">ج) مؤشرات الخندق التنافسي</p>
    <div class="metric-grid" style="margin-bottom:16px">
      ${metric('Gross Margin',    fmtPct(gMgn),  statusCls(gMgn, 0.4, 0.2))}
      ${metric('Op. Margin',      fmtPct(oMgn),  statusCls(oMgn, 0.15, 0.05))}
      ${metric('Net Margin',      fmtPct(pMgn),  statusCls(pMgn, 0.15, 0.03))}
      ${metric('ROE', fmtPct(edgarROE ?? roe), statusCls(edgarROE ?? roe, 0.15, 0.08), edgarROE != null ? '🏛️ SEC EDGAR' : '')}
      ${metric('ROA',             fmtPct(roa),   statusCls(roa, 0.1, 0.03))}
      ${metric('Debt/Equity', edgarDE != null ? `${edgarDE.toFixed(2)}x` : de != null ? `${de.toFixed(2)}x` : null, statusCls(edgarDE ?? de, 0, 1.5, false), edgarDE != null ? '🏛️ SEC EDGAR' : '')}
      ${debtEbitda != null ? metric(`Debt/EBITDA ${debtEbitdaSource}`, `${debtEbitda}x`, statusCls(parseFloat(debtEbitda), 0, 4, false)) : ''}
      ${metric('Free Cash Flow', `$${fmt(eg?.ttmFCF ?? raw(fd.freeCashflow))}`, '', eg?.ttmFCF != null ? '🏛️ SEC EDGAR' : '')}
      ${eg?.ttmEbitda != null ? metric('EBITDA TTM 🏛️', `$${fmt(eg.ttmEbitda)}`) : ''}
    </div>

    <p class="subsection-label">د) تقييم P/E (وفق أعتاب B.A.M)</p>
    ${pe != null ? `
    <div class="cape-box">
      <div class="cape-value ${capeCls === 'low' ? 'text-green' : capeCls === 'high' ? 'text-red' : 'text-yellow'}">${pe.toFixed(1)}</div>
      <div class="cape-info">
        <div class="cape-title">Trailing P/E</div>
        <div class="cape-desc">${capeDesc}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${capeReturn}</div>
        <div class="cape-scale">
          <span class="cape-tier low">🟢 &lt;9.6 رخيص</span>
          <span class="cape-tier mid">🟡 9.6-25.1 معقول</span>
          <span class="cape-tier high">🔴 &gt;25.1 مرتفع</span>
        </div>
      </div>
    </div>` : '<p class="text-muted" style="font-size:13px">بيانات P/E غير متاحة</p>'}
  </div>`;
}

/* ─── SEC 5: Price Catalysts ────────────────────────────────────────────── */
function sec5(q, ks, ug, eh, ce, et) {
  const h52 = q.fiftyTwoWeekHigh ?? raw(ks.fiftyTwoWeekHigh);
  const l52 = q.fiftyTwoWeekLow  ?? raw(ks.fiftyTwoWeekLow);
  const px  = q.regularMarketPrice;

  let rangePct = null;
  if (px && h52 && l52 && h52 > l52) rangePct = ((px - l52) / (h52 - l52) * 100).toFixed(0);

  /* Upcoming earnings */
  const earnDates = (ce.earningsDate || []).map(d => fmtDate(raw(d)));
  const earnEps   = ce.earningsAverage != null ? fmtUSD(raw(ce.earningsAverage)) : null;

  /* EPS history vs estimates */
  const ehRows = eh.slice(0, 4).map(e => {
    const actual   = raw(e.epsActual);
    const estimate = raw(e.epsEstimate);
    const surprise = raw(e.surprisePercent);
    const qDate    = e.quarter ? fmtDate(raw(e.quarter)) : 'N/A';
    const supCls   = surprise == null ? '' : surprise >= 0 ? 'text-green' : 'text-red';
    return `<tr>
      <td>${qDate}</td>
      <td>${estimate != null ? '$' + estimate.toFixed(2) : 'N/A'}</td>
      <td>${actual != null ? '$' + actual.toFixed(2) : 'N/A'}</td>
      <td class="${supCls}">${surprise != null ? (surprise >= 0 ? '+' : '') + (surprise * 100).toFixed(1) + '%' : 'N/A'}</td>
    </tr>`;
  }).join('');

  /* Next quarter EPS estimate from earningsTrend */
  const nextQ = et.find(t => t.period === '+1q');
  const nextQeps = nextQ ? raw(nextQ.earningsEstimate?.avg) : null;

  const recentUg = ug.slice(0, 5);

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">05</span> ⏳ محفزات السعر والأحداث</h3>

    ${rangePct != null ? `
    <p style="font-size:12px;color:var(--muted);margin-bottom:4px">موقع السعر الحالي في النطاق السنوي</p>
    <div class="range-bar-wrap">
      <div class="range-bar-track">
        <div class="range-bar-fill" style="width:${rangePct}%"></div>
        <div class="range-bar-dot" style="right:${rangePct}%"></div>
      </div>
      <div class="range-bar-labels">
        <span>LOW $${fmt(l52)}</span>
        <span style="color:var(--accent);font-weight:700">${rangePct}% من القاع</span>
        <span>HIGH $${fmt(h52)}</span>
      </div>
    </div>` : ''}

    ${earnDates.length ? `
    <div style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2);border-radius:8px;padding:12px;margin-bottom:12px">
      <p style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:4px">📅 موعد الأرباح القادمة</p>
      <p style="font-size:15px;font-weight:700">${earnDates.join(' | ')}</p>
      ${earnEps ? `<p style="font-size:12px;color:var(--muted);margin-top:4px">توقع EPS: ${earnEps}</p>` : ''}
      ${nextQeps != null ? `<p style="font-size:12px;color:var(--muted)">توقع EPS الربع القادم: $${nextQeps.toFixed(2)}</p>` : ''}
    </div>` : ''}

    ${ehRows ? `
    <p class="subsection-label">تاريخ EPS الفعلي مقابل التوقعات</p>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>الربع</th><th>التوقع</th><th>الفعلي</th><th>المفاجأة</th></tr></thead>
        <tbody>${ehRows}</tbody>
      </table>
    </div>` : ''}

    ${recentUg.length ? `
    <p class="subsection-label" style="margin-top:14px">آخر تحركات المحللين</p>
    <div class="analyst-list">
      ${recentUg.map(u => {
        const gc = gradeClass(u.toGrade);
        return `<div class="analyst-item">
          <div>
            <div class="analyst-firm">${na(u.firm)} · ${fmtDate(u.epochGradeDate)}</div>
            <div style="font-size:12px;color:var(--muted)">${u.fromGrade ? u.fromGrade + ' ← ' : ''}${na(u.toGrade)}</div>
          </div>
          <span class="analyst-grade grade-${gc}">${gc === 'buy' ? '🟢 شراء' : gc === 'sell' ? '🔴 بيع' : '🟡 احتفاظ'}</span>
        </div>`;
      }).join('')}
    </div>` : ''}
  </div>`;
}

/* ─── SEC 6: Market Psychology & Risks ─────────────────────────────────── */
function sec6(rt, fd, q) {
  const latest = rt[0];
  const total  = latest ? (latest.strongBuy + latest.buy + latest.hold + latest.sell + latest.strongSell) : 0;
  const buys   = latest ? (latest.strongBuy + latest.buy) : 0;
  const holds  = latest ? latest.hold : 0;
  const sells  = latest ? (latest.sell + latest.strongSell) : 0;
  const buyPct  = total ? +(buys  / total * 100).toFixed(0) : 0;
  const holdPct = total ? +(holds / total * 100).toFixed(0) : 0;
  const sellPct = total ? +(sells / total * 100).toFixed(0) : 0;

  const targetMean = fd.targetMeanPrice;
  const targetMed  = fd.targetMedianPrice;
  const curr       = q.regularMarketPrice;
  const upside     = targetMean && curr ? ((targetMean - curr) / curr * 100).toFixed(1) : null;

  const mean = fd.recommendationMean;
  const consensus = mean == null ? '' :
    mean <= 1.5 ? '🟢 شراء قوي' : mean <= 2.5 ? '🟢 شراء' :
    mean <= 3.5 ? '🟡 احتفاظ' : mean <= 4.5 ? '🔴 بيع' : '🔴 بيع قوي';

  /* Risks computed from real data only */
  const risks = [];
  const beta = q.beta;
  if (beta > 1.5) risks.push({ cls: 'red', text: `Beta مرتفع (${beta?.toFixed(2)}) — تقلب عالٍ` });
  if (fd.debtToEquity > 150) risks.push({ cls: 'red', text: `Debt/Equity مرتفع (${(fd.debtToEquity/100).toFixed(2)}x)` });
  if (fd.profitMargins < 0) risks.push({ cls: 'red', text: 'هوامش ربح سلبية' });
  if (upside != null && parseFloat(upside) < -10) risks.push({ cls: 'red', text: `هدف المحللين أدنى من السعر الحالي بـ ${Math.abs(upside)}%` });
  if (fd.revenueGrowth < -0.05) risks.push({ cls: 'red', text: `تراجع الإيرادات ${fmtPct(fd.revenueGrowth)}` });
  if (!risks.length) risks.push({ cls: 'green', text: 'لا مخاطر رئيسية ظاهرة في البيانات المتاحة' });

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">06</span> ⚠️ سيكولوجية السوق والمخاطر</h3>

    ${total > 0 ? `
    <p class="subsection-label">توصيات ${total} محلل</p>
    <div class="rec-bar-container">
      <div class="rec-bar">
        <div class="rec-bar-buy"  style="width:${buyPct}%"></div>
        <div class="rec-bar-hold" style="width:${holdPct}%"></div>
        <div class="rec-bar-sell" style="width:${sellPct}%"></div>
      </div>
      <div class="rec-legend">
        <span><span class="rec-dot" style="background:var(--green)"></span>شراء ${buyPct}% (${buys})</span>
        <span><span class="rec-dot" style="background:var(--yellow)"></span>احتفاظ ${holdPct}% (${holds})</span>
        <span><span class="rec-dot" style="background:var(--red)"></span>بيع ${sellPct}% (${sells})</span>
      </div>
    </div>
    ${consensus ? `<p style="font-size:14px;font-weight:700;margin:8px 0">إجماع المحللين: ${consensus} (${mean?.toFixed(1)}/5)</p>` : ''}` : ''}

    ${targetMean != null ? `
    <div class="metric-grid" style="margin:12px 0">
      ${metric('Target Price (Mean)',   fmtUSD(targetMean), upside ? (parseFloat(upside) >= 0 ? 'green' : 'red') : '')}
      ${metric('Target Price (Median)', fmtUSD(targetMed))}
      ${metric('Upside / Downside',     upside != null ? (parseFloat(upside) >= 0 ? '+' : '') + upside + '%' : null, upside != null ? (parseFloat(upside) >= 0 ? 'green' : 'red') : '')}
      ${metric('Target Low',            fmtUSD(fd.targetLowPrice), 'red')}
      ${metric('Target High',           fmtUSD(fd.targetHighPrice), 'green')}
    </div>` : ''}

    <p class="subsection-label">أكبر المخاطر المحتملة</p>
    <div class="key-points">
      ${risks.slice(0, 3).map(r => `<div class="key-point"><span>${icon(r.cls)}</span><span>${r.text}</span></div>`).join('')}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
      <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:8px;padding:12px;text-align:center">
        <p style="font-size:11px;color:var(--muted)">سيناريو الثور 🟢</p>
        ${targetMean && curr ? `<p style="font-weight:700;font-size:16px;color:var(--green)">${fmtUSD(fd.targetHighPrice || targetMean)}</p>` : '<p style="color:var(--muted)">N/A</p>'}
      </div>
      <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:12px;text-align:center">
        <p style="font-size:11px;color:var(--muted)">سيناريو الدب 🔴</p>
        ${fd.targetLowPrice && curr ? `<p style="font-weight:700;font-size:16px;color:var(--red)">${fmtUSD(fd.targetLowPrice)}</p>` : '<p style="color:var(--muted)">N/A</p>'}
      </div>
    </div>
  </div>`;
}

/* ─── SEC 7: Investment Horizon ─────────────────────────────────────────── */
function sec7(fd, ks, q, sd) {
  const revGrw  = fd.revenueGrowth;
  const earGrw  = fd.earningsGrowth;
  const fwdPE   = raw(ks.forwardPE);
  const trailPE = raw(ks.trailingPE);
  const shortPct= raw(ks.sharesPercentSharesOut);
  const shortRat= raw(ks.shortRatio);
  const pEgr = (fwdPE && trailPE) ? (fwdPE < trailPE ? '🟢 السوق يتوقع نمو أرباح (Forward P/E أقل)' : '🔴 توقع ضغط على الأرباح') : '';
  const divYld  = raw(sd.dividendYield ?? ks.dividendYield);
  const fwdDivYld = raw(sd.dividendYield);
  const trailDivYld = raw(ks.trailingAnnualDividendYield);
  const payoutRatio = raw(ks.payoutRatio);

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">07</span> 🔮 الأفق الاستثماري وتقييم الفقاعة</h3>
    <div class="metric-grid" style="margin-bottom:14px">
      ${metric('Revenue Growth (YoY)',  fmtPct(revGrw),      statusCls(revGrw,  0.1, -0.05))}
      ${metric('Earnings Growth (YoY)', fmtPct(earGrw),      statusCls(earGrw,  0.1, -0.05))}
      ${metric('Trailing P/E',          trailPE != null ? trailPE.toFixed(1) : null)}
      ${metric('Forward P/E',           fwdPE != null ? fwdPE.toFixed(1) : null)}
      ${metric('Short % of Float',      fmtPct(shortPct),    statusCls(shortPct, 0, 0.1, false))}
      ${metric('Short Ratio (Days)',     shortRat != null ? shortRat.toFixed(1) + 'd' : null, statusCls(shortRat, 0, 5, false))}
      ${metric('Dividend Yield',        divYld != null ? fmtPct(divYld) : null)}
      ${metric('Payout Ratio',          payoutRatio != null ? fmtPct(raw(payoutRatio)) : null)}
    </div>
    ${pEgr ? `<p style="font-size:13px;font-weight:600;padding:10px;background:var(--card2);border-radius:8px">${pEgr}</p>` : ''}
    <p style="margin-top:12px;font-size:12px;color:var(--muted)">
      💡 Short Ratio &gt;5 أيام = ضغط بيعي مرتفع قد يؤدي لـ Short Squeeze إذا تحرك السهم صعوداً
    </p>
  </div>`;
}

/* ─── SEC 8: Final Summary ──────────────────────────────────────────────── */
function sec8(fd, ks, rt, q, eg) {
  let score = 0, max = 0;
  const add = (val, good, weight) => {
    max += weight;
    if (val == null) return;
    if (val >= good) score += weight;
    else if (val >= good / 2) score += weight * 0.5;
  };
  // Prefer EDGAR data where available
  add(eg?.roeEdgar ?? fd.returnOnEquity, 0.15, 20);
  add(fd.profitMargins,  0.15, 15);
  add(fd.revenueGrowth,  0.10, 15);
  add(fd.earningsGrowth, 0.10, 15);
  add(fd.grossMargins,   0.40, 10);

  const latest = rt[0];
  if (latest) {
    max += 15;
    const t = latest.strongBuy + latest.buy + latest.hold + latest.sell + latest.strongSell;
    const bRatio = t > 0 ? (latest.strongBuy + latest.buy) / t : 0;
    score += bRatio >= 0.6 ? 15 : bRatio >= 0.4 ? 8 : 0;
  }

  const pe = raw(ks.trailingPE);
  if (pe != null) {
    max += 10;
    score += pe < 15 ? 10 : pe < 25 ? 6 : pe < 40 ? 2 : 0;
  }

  const pct = max > 0 ? Math.round(score / max * 100) : null;
  let verdict, vcls, emoji;
  if (pct == null)    { verdict = 'بيانات غير كافية'; vcls = 'hold'; emoji = '⚪'; }
  else if (pct >= 70) { verdict = 'شراء 🟢';           vcls = 'buy';  emoji = '🚀'; }
  else if (pct >= 45) { verdict = 'احتفاظ / مراقبة 🟡'; vcls = 'hold'; emoji = '⏸️'; }
  else                { verdict = 'انتظار / حذر 🔴';   vcls = 'sell'; emoji = '⚠️'; }

  const strengths = [], risks2 = [];
  if (fd.returnOnEquity > 0.15)   strengths.push(`ROE مرتفع (${(fd.returnOnEquity*100).toFixed(0)}%) — كفاءة رأس المال ممتازة`);
  if (fd.profitMargins > 0.20)    strengths.push(`هامش صافي قوي (${(fd.profitMargins*100).toFixed(0)}%)`);
  if (fd.revenueGrowth > 0.15)    strengths.push(`نمو إيرادات قوي (${(fd.revenueGrowth*100).toFixed(0)}%)`);
  if (fd.debtToEquity < 50)       strengths.push('ميزانية عمومية خفيفة الديون');
  if (fd.grossMargins > 0.5)      strengths.push(`هامش إجمالي ممتاز (${(fd.grossMargins*100).toFixed(0)}%)`);
  if (fd.debtToEquity > 150)      risks2.push('مديونية مرتفعة قد تثقل النمو');
  if (pe > 35)                    risks2.push(`P/E مرتفع (${pe.toFixed(1)}) — توقعات مرتفعة مبنية في السعر`);
  if (fd.earningsGrowth < -0.05)  risks2.push('تراجع في الأرباح — راقب التقرير القادم');
  if (fd.profitMargins < 0)       risks2.push('خسارة صافية حالية');

  return `
  <div class="card">
    <h3 class="card-title"><span class="section-num">08</span> 🏁 خلاصة الرأي الاستثماري</h3>
    <div class="verdict-box ${vcls}">
      <div class="verdict-emoji">${emoji}</div>
      <div class="verdict-text ${vcls}">${verdict}</div>
      ${pct != null ? `<div style="font-size:13px;color:var(--muted)">نتيجة التقييم الشامل: <strong>${pct}/100</strong></div>` : ''}
    </div>

    ${strengths.length ? `
    <p style="font-size:12px;font-weight:700;color:var(--green);margin-bottom:8px">✅ نقاط القوة</p>
    <div class="key-points" style="margin-bottom:14px">
      ${strengths.map(s => `<div class="key-point"><span class="kp-icon">🟢</span><span>${s}</span></div>`).join('')}
    </div>` : ''}

    ${risks2.length ? `
    <p style="font-size:12px;font-weight:700;color:var(--red);margin-bottom:8px">⚠️ سيناريو محامي الشيطان</p>
    <div class="key-points">
      ${risks2.map(r => `<div class="key-point"><span class="kp-icon">🔴</span><span>${r}</span></div>`).join('')}
    </div>` : ''}

    <p style="margin-top:16px;font-size:12px;color:var(--muted);text-align:center;padding:10px;background:var(--card2);border-radius:8px">
      هل تريد مقارنة هذا السهم بمنافس محدد؟ — ابحث عن رمز السهم المنافس لتحليله أيضاً ومقارنتهما
    </p>
  </div>`;
}

/* ─── METRIC HELPER ─────────────────────────────────────────────────────── */
function metric(label, val, cls = '', note = '') {
  const display = (val == null || val === 'N/A' || val === '$N/A') ? 'N/A' : val;
  return `
  <div class="metric">
    <div class="metric-label">${label}</div>
    <div class="metric-value ${cls}">${display}</div>
    ${note ? `<div class="metric-note">${note}</div>` : ''}
  </div>`;
}

/* ─── COLLAPSE ──────────────────────────────────────────────────────────── */
function addExpandListeners() {
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const box = btn.previousElementSibling;
      const collapsed = box.classList.contains('text-collapsed');
      if (collapsed) {
        box.classList.replace('text-collapsed', 'text-expanded');
        box.textContent = decodeURIComponent(box.dataset.full);
        btn.textContent = '▲ تصغير';
      } else {
        box.classList.replace('text-expanded', 'text-collapsed');
        box.textContent = decodeURIComponent(box.dataset.full);
        btn.textContent = '▼ اقرأ كاملاً';
      }
    });
  });
}

/* ─── SIDEBAR ───────────────────────────────────────────────────────────── */
function openSidebar()  { $('sidebar').classList.add('open'); $('overlay').classList.add('show'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('show'); }

/* ─── EVENTS ────────────────────────────────────────────────────────────── */
$('menuBtn').addEventListener('click', openSidebar);
$('closeSidebar').addEventListener('click', closeSidebar);
$('overlay').addEventListener('click', closeSidebar);

$('searchBtn').addEventListener('click', () => {
  const sym = $('searchInput').value.trim();
  if (sym) loadAndShow(sym);
});
$('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const sym = $('searchInput').value.trim(); if (sym) loadAndShow(sym); }
});
document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => loadAndShow(btn.dataset.sym)));
$('retryBtn').addEventListener('click', () => { if (currentSymbol) loadAndShow(currentSymbol); });
$('refreshBtn').addEventListener('click', () => { if (currentSymbol) loadAndShow(currentSymbol, true); });
$('deleteBtn').addEventListener('click', () => {
  if (currentSymbol && confirm(`حذف ${currentSymbol}؟`)) deleteStock(currentSymbol);
});
$('saveNotesBtn').addEventListener('click', async () => {
  if (!currentSymbol) return;
  await fetch(`/api/stock/${currentSymbol}/notes`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: $('notesInput').value }),
  });
  const fb = $('saveFeedback');
  fb.textContent = '✓ تم الحفظ';
  setTimeout(() => fb.textContent = '', 2000);
});

/* ─── ADD MISSING CSS HELPERS ───────────────────────────────────────────── */
const style = document.createElement('style');
style.textContent = `.subsection-label{font-size:12px;font-weight:700;color:var(--accent);margin-bottom:8px;display:block}`;
document.head.appendChild(style);

/* ─── AUTH ──────────────────────────────────────────────────────────────── */
async function checkAuth() {
  const res = await fetch('/api/auth/check');
  const { authenticated } = await res.json();
  if (authenticated) {
    $('loginGate').hidden = true;
    showState('empty');
    loadSavedList();
  } else {
    $('loginGate').hidden = false;
  }
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const password = $('passwordInput').value;
  const err = $('loginError');
  err.hidden = true;
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    $('loginGate').hidden = true;
    showState('empty');
    loadSavedList();
  } else {
    err.textContent = 'كلمة المرور غير صحيحة';
    err.hidden = false;
    $('passwordInput').value = '';
    $('passwordInput').focus();
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  $('loginGate').hidden = false;
  $('passwordInput').value = '';
  showState('empty');
  currentSymbol = null;
});

/* ─── INIT ──────────────────────────────────────────────────────────────── */
checkAuth();
