#!/usr/bin/env node
// One-shot preview — run with: node preview.mjs

import { writeFileSync } from "fs";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function safeHtml(s) {
  return esc(s)
    .replace(/&lt;strong&gt;/g, "<strong>").replace(/&lt;\/strong&gt;/g, "</strong>")
    .replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>")
    .replace(/&lt;span class="metric-value"&gt;/g, '<span class="metric-value">')
    .replace(/&lt;\/span&gt;/g, "</span>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function briefToHtml(text, prices = {}) {
  const DIVIDER = /^━+$/;
  const TICKER_LINE = /^(⚡\s*)?([A-Z]{2,5})\s+[+\-↑↓][\d.]+%\s+[—–\-]\s+(.+)$/;
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let inPortfolio = false;
  let portfolioIntro = null;
  let portfolioRows = [];

  function maClass(val) { return val == null ? "neutral" : val >= 0 ? "positive" : "negative"; }
  function maStr(val)   { return val == null ? "—" : (val >= 0 ? "+" : "") + val.toFixed(1) + "%"; }

  function flushPortfolio() {
    const wasPortfolio = inPortfolio;
    inPortfolio = false;
    const rows = portfolioRows; const intro = portfolioIntro;
    portfolioRows = []; portfolioIntro = null;
    if (!rows.length) {
      if (wasPortfolio) out.push(`<p style="color:#9ca3af;font-style:italic;font-size:13px;">Portfolio data unavailable today — check your brokerage app for current prices.</p>`);
      return;
    }
    if (intro) out.push(`<p class="neutral" style="margin:0 0 12px;font-size:13px;font-style:italic;">${safeHtml(intro)}</p>`);
    const rowsHtml = rows.map(({ flagged, ticker, note }, idx) => {
      const pd = prices[ticker] ?? {};
      const pct24h = pd.pct24h ?? null; const v50 = pd.vs50d ?? null; const v200 = pd.vs200d ?? null;
      const isFlat = pct24h != null && Math.abs(pct24h) < 0.5;
      const pctClass = pct24h == null ? "neutral" : isFlat ? "neutral" : pct24h >= 0 ? "positive" : "negative";
      const pctStr = pct24h != null ? (pct24h >= 0 ? "↑" : "↓") + Math.abs(pct24h).toFixed(1) + "%" : "—";
      const showFlag = flagged || (pct24h != null && Math.abs(pct24h) >= 3);
      const rowClass = showFlag ? "flag-row" : idx % 2 !== 0 ? "row-alt" : "";
      const label = showFlag ? `⚡ ${ticker}` : ticker;
      return `<tr class="${rowClass}"><td class="col-ticker">${esc(label)}</td><td class="col-24h ${pctClass}">${esc(pctStr)}</td><td class="col-50d ${maClass(v50)}">${esc(maStr(v50))}</td><td class="col-200d ${maClass(v200)}">${esc(maStr(v200))}</td><td class="col-note">${safeHtml(note.trim())}</td></tr>`;
    }).join("");
    out.push(`<table class="portfolio-table"><thead><tr><th class="col-ticker">TICKER</th><th class="col-24h">24H</th><th class="col-50d">50D</th><th class="col-200d">200D</th><th>INTEL</th></tr></thead><tbody>${rowsHtml}</tbody></table>`);
  }

  while (i < lines.length) {
    const line = lines[i]; const trim = line.trim();
    if (DIVIDER.test(trim) && i + 2 < lines.length && DIVIDER.test(lines[i + 2].trim())) {
      flushPortfolio();
      const header = lines[i + 1].trim();
      out.push(`<hr class="divider"><p class="section-title">${esc(header)}</p>`);
      if (header.includes("📊") || header.toUpperCase().includes("PORTFOLIO")) inPortfolio = true;
      i += 3; continue;
    }
    if (DIVIDER.test(trim)) { flushPortfolio(); out.push(`<hr class="divider">`); i++; continue; }
    if (inPortfolio) {
      const cleanTrim = trim.replace(/\*\*/g, "").replace(/\s+/g, " ");
      const m = cleanTrim.match(TICKER_LINE);
      if (m) { const [, flagged, ticker, note] = m; portfolioRows.push({ flagged: !!flagged, ticker, note }); i++; continue; }
      if (!portfolioRows.length && trim) { portfolioIntro = trim; i++; continue; }
      if (!trim && portfolioRows.length) { flushPortfolio(); out.push("<br>"); i++; continue; }
    }
    if (!trim) { out.push("<br>"); i++; continue; }
    out.push(`<p>${safeHtml(trim)}</p>`);
    i++;
  }
  flushPortfolio();

  const CSS = `body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;max-width:600px;margin:0 auto;padding:16px}p{margin:4px 0}strong,b{color:#ffffff;font-weight:700}.metric-value{color:#ffffff;font-weight:600}.section-title{font-weight:700;font-size:13px;color:#9ca3af;letter-spacing:.05em;text-transform:uppercase;margin:10px 0}.divider{border:none;border-top:1px solid #333;margin:16px 0}.positive{color:#4ade80;font-weight:600}.negative{color:#f87171;font-weight:600}.neutral{color:#9ca3af}.portfolio-table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 16px}.portfolio-table th{font-size:11px;color:#6b7280;padding:6px 8px;text-align:left;border-bottom:1px solid #2a2a2a}.portfolio-table td{padding:8px 6px;font-size:13px;border-bottom:1px solid #1a1a1a;vertical-align:top;color:#e0e0e0}.col-ticker{width:55px;font-weight:600;color:#ffffff}.col-24h{width:55px;white-space:nowrap;text-align:right}.col-50d{width:55px;white-space:nowrap;text-align:right}.col-200d{width:55px;white-space:nowrap;text-align:right}.col-note{font-size:12px;color:#b0b0b0}.row-alt{background:#141414}.flag-row{background:#1a1500}.flag-row .col-ticker{color:#ffffff;font-weight:700}`;
  const bodyHtml = out.join("").replace(/<!--[\s\S]*?-->/g, "").trim();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${bodyHtml}</body></html>`;
}

// ── Sample prices ─────────────────────────────────────────────────────────────
const prices = {
  BTC:  { pct24h:  1.8,  vs50d:  8.4,  vs200d: 22.1 },
  MSTR: { pct24h:  2.4,  vs50d:  5.1,  vs200d: 18.6 },
  STRC: { pct24h:  0.3,  vs50d: -1.2,  vs200d:  3.4 },
  IREN: { pct24h:  4.2,  vs50d: 11.7,  vs200d: 31.2 },
  NVDA: { pct24h:  1.1,  vs50d:  6.2,  vs200d: 14.8 },
  TSLA: { pct24h: -1.3,  vs50d: -3.8,  vs200d: -6.2 },
  GOOG: { pct24h: -0.4,  vs50d: -2.8,  vs200d:  5.6 },
  CEG:  { pct24h:  2.1,  vs50d:  9.3,  vs200d: 27.4 },
  SCHD: { pct24h:  0.2,  vs50d:  1.1,  vs200d:  3.8 },
  COIN: { pct24h: -0.8,  vs50d: -4.3,  vs200d: -9.1 },
};

// ── Sample brief ──────────────────────────────────────────────────────────────
const SAMPLE = `\
🌅 GM Wes — Monday, May 11 8:30 AM PDT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mike here. A few things moving worth your attention.
ETF inflows back at $312M — largest single day since March. IREN flagged +4.2% on a 200MW power deal; that's a structural change, not a trade. Body is running well, readiness 81, HRV trending up on the 7-day window.

━━━━━━━━━━━━━━━━━━━━
💤 RECOVERY
━━━━━━━━━━━━━━━━━━━━
Readiness: <span class="metric-value">81/100</span> — Strong — body's saying go hard.

HRV: <span class="metric-value">58ms</span> (↑6% vs 30-day avg of <span class="metric-value">55ms</span>) — nervous system primed, 7-day trend still climbing.

Sleep: <span class="metric-value">7h 34m</span> | Score: <span class="metric-value">84/100</span> — deep sleep window solid, above your 7-day average.
🛌 Bed by 10:30pm: add 3-5 readiness points — every hour before midnight counts double.

👟 Yesterday: <span class="metric-value">9,247 steps</span> — Active (↑12% vs avg)
9,000 steps/day is where all-cause mortality risk starts meaningfully declining in large-cohort studies — you're above the line.

🔬 Readiness up, HRV above baseline, sleep strong — this is the compounding window, not just a good day.

━━━━━━━━━━━━━━━━━━━━
✅ THE CALL
━━━━━━━━━━━━━━━━━━━━
Add <strong>IREN</strong> before the next earnings print — today's infrastructure deal changes the capacity ceiling. This is the window.

━━━━━━━━━━━━━━━━━━━━
📊 PORTFOLIO
━━━━━━━━━━━━━━━━━━━━
ETF flows resumed, BTC structure intact. AI-energy nexus getting a broad bid.

BTC +1.8% — Holding above both MAs on resumed ETF inflows. Structure clean.
MSTR +2.4% — Tracking BTC with leverage intact. Treasury thesis playing out.
STRC +0.3% — Flat. Cash-equivalent holding steady, doing its job.
⚡ IREN +4.2% — 200MW power deal announced today. Long-cycle catalyst, not a trade.
NVDA +1.1% — AI capex narrative intact, broad market giving it a bid.
TSLA -1.3% — Macro pressure, no structural news today. Watching for physical AI catalyst.
GOOG -0.4% — Light drift. Antitrust noise, not a structural shift.
CEG +2.1% — Nuclear demand narrative accelerating. Data center power deals piling up.
SCHD +0.2% — Flat, collecting yield. Defensive anchor holding.
COIN -0.8% — Drifting with broader crypto sentiment. No stock-specific catalyst.

━━━━━━━━━━━━━━━━━━━━
📰 SIGNAL
━━━━━━━━━━━━━━━━━━━━
Macro backdrop clearing as trade noise fades. Three headlines that matter.
- Bitcoin ETF inflows hit $312M net — largest single-day since March, led by iShares and Fidelity. 🟢
- IREN signs 200MW data center power agreement with regional utility, capacity secured through 2029. 🟢
- Goldman Sachs cuts enterprise AI software revenue forecast citing slower enterprise procurement cycles. 🔴

━━━━━━━━━━━━━━━━━━━━
⛓️ ON-CHAIN
━━━━━━━━━━━━━━━━━━━━
Forget the price. Look at what the holders are doing.
Long-term holders added <strong>18,400 BTC</strong> to cold storage this week — the largest accumulation in 90 days — while exchange supply hit a 6-year low. Hash rate held at <strong>925 EH/s</strong>, signaling miner confidence in the post-halving cycle.
ETF Flows: $312M net inflow — institutional demand resuming, not speculative froth
Fear & Greed: 64/100 — Greed, elevated but not euphoric — room to run before sentiment becomes a headwind

━━━━━━━━━━━━━━━━━━━━
🧭 THESIS CHECK
━━━━━━━━━━━━━━━━━━━━
ETF inflows at 90-day highs while LTH accumulation hits multi-month peaks — the Bitcoin sovereign capital thesis is getting structural confirmation in real time.
Status: STRENGTHENING
Momentum: 8/10 ↑
✅ Supporting: LTH accumulation + ETF inflows converging at exchange supply lows is the setup the $1M thesis requires — patient, institutional, structural.
⚠️ Counter: Goldman cut enterprise AI revenue forecasts today citing slower procurement cycles — if that trend accelerates, the near-term revenue case for NVDA and GOOG is softer than consensus expects.

━━━━━━━━━━━━━━━━━━━━
⚡ HEADS UP
━━━━━━━━━━━━━━━━━━━━
IREN earnings: May 14 — watch power capacity guidance and hash rate exit rate.
CPI print: May 13 — hotter than expected would pressure risk assets and BTC short-term.

━━━━━━━━━━━━━━━━━━━━
💡 MIKE'S CLOSE
━━━━━━━━━━━━━━━━━━━━
Two signals converged today that don't often line up: ETF inflows resuming at scale while LTH supply hits multi-month highs. That's the setup, not the price.

💰 $300 today: BTC gets the anchor — $150 here while ETF demand is re-entering and exchange supply is at lows is the simplest high-conviction trade. IREN takes $100; today's power deal isn't priced in yet and earnings are two weeks out, which means the window is now, not after. The remaining $50 goes to CEG — nuclear power demand for data centers isn't a thesis anymore, it's a contract backlog.

📍 MIKE'S READ
🟢 BTC — Bullish: ETF inflows + LTH accumulation at exchange supply lows — structural bid intact.
🟢 IREN — Bullish: 200MW power deal changes the capacity ceiling heading into earnings.
🟡 GOOG — Neutral: Antitrust overhang limits upside; enterprise AI revenue softer near-term.
🔴 AI revenue — Watch: Goldman's enterprise AI forecast cut today is a signal worth tracking — if procurement slowdown widens, it hits the AI basket.

— Mike`;

const html = briefToHtml(SAMPLE, prices);
const minified = html.replace(/<!--[\s\S]*?-->/g, "").replace(/\n\s*\n/g, "\n").replace(/>\s+</g, "><").trim();
const outPath = new URL("./sample.html", import.meta.url).pathname;
writeFileSync(outPath, minified);
console.log(`Written: ${outPath}`);
console.log(`Size: ${Math.round(Buffer.byteLength(minified, "utf8") / 1024)} KB`);
