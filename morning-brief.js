#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { getOuraData } from "./oura.js";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";

console.log("ENV CHECK:", !!process.env.ANTHROPIC_API_KEY);

const SEARCH_MODEL = "claude-haiku-4-5-20251001";
const BRIEF_MODEL  = "claude-sonnet-4-6";
const SEARCH_TOOL  = [{ type: "web_search_20250305", name: "web_search" }];

let _client;
function client() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runSearch(prompt, maxTokens = 500) {
  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 65000;
      process.stderr.write(`rate limited, retrying in ${wait / 1000}s...\n`);
      await sleep(wait);
    }
    try {
      for (let i = 0; i < 6; i++) {
        const res = await client().messages.create({
          model: SEARCH_MODEL,
          max_tokens: maxTokens,
          tools: SEARCH_TOOL,
          messages,
        });
        const text = res.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (res.stop_reason === "end_turn") return text;
        if (res.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: res.content });
          const toolResults = res.content
            .filter((b) => b.type === "tool_use")
            .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "" }));
          messages.push({ role: "user", content: toolResults });
          if (text) return text;
          continue;
        }
        return text;
      }
      return "";
    } catch (err) {
      if (attempt === 2 || !err.message?.includes("429")) throw err;
    }
  }
  return "";
}

// Fetch price, 24h%, 50D MA%, 200D MA% from free APIs
async function fetchPrices() {
  const STOCKS = ["MSTR", "STRC", "IREN", "NVDA", "AVGO", "GOOG", "CEG", "SCHD", "COIN"];
  const headers = { "User-Agent": "Mozilla/5.0", "Accept": "application/json" };

  function ma(closes, n) {
    const slice = closes.slice(-n);
    return slice.length === n ? slice.reduce((a, b) => a + b, 0) / n : null;
  }

  const fetchStock = async (ticker) => {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=200d`,
      { headers }
    );
    const data  = await res.json();
    const result = data?.chart?.result?.[0];
    const meta   = result?.meta;
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(c => c != null);
    if (!meta?.regularMarketPrice) return null;
    const price    = meta.regularMarketPrice;
    const prevClose = meta.regularMarketPreviousClose ?? closes.at(-2) ?? null;
    if (!prevClose) return null;
    const pct24h = (price - prevClose) / prevClose * 100;
    const ma50   = ma(closes, 50);
    const ma200  = ma(closes, 200);
    return {
      price,
      pct24h,
      vs50d:  ma50  ? (price - ma50)  / ma50  * 100 : null,
      vs200d: ma200 ? (price - ma200) / ma200 * 100 : null,
    };
  };

  const [btcChart, ...stockResults] = await Promise.all([
    fetch("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=200&interval=daily", { headers }).then(r => r.json()),
    ...STOCKS.map(t => fetchStock(t).catch(() => null)),
  ]);

  const prices = {};
  const btcCloses = (btcChart?.prices ?? []).map(p => p[1]).filter(Boolean);
  const btcPrice  = btcCloses.at(-1);
  const btcPrev   = btcCloses.at(-2);
  const ma50      = ma(btcCloses, 50);
  const ma200     = ma(btcCloses, 200);
  if (btcPrice) {
    prices["BTC"] = {
      price:  Math.round(btcPrice),
      pct24h: btcPrev ? (btcPrice - btcPrev) / btcPrev * 100 : null,
      vs50d:  ma50  ? (btcPrice - ma50)  / ma50  * 100 : null,
      vs200d: ma200 ? (btcPrice - ma200) / ma200 * 100 : null,
    };
  }
  STOCKS.forEach((t, i) => { if (stockResults[i]) prices[t] = stockResults[i]; });

  return prices;
}

// Combined news + on-chain in one search call to halve web search API usage
async function fetchNewsAndOnChain() {
  const raw = await runSearch(
    `Do two searches and return both results clearly separated.

    SEARCH 1 — HEADLINES: Find the 2-3 most important structural headlines from the last 24 hours in:
    - Bitcoin and crypto regulation
    - BTC ETF flows
    - Institutional Bitcoin or crypto adoption
    - AI infrastructure (NVDA, AVGO, GOOG data centers, AI chips)
    - Energy / nuclear (CEG, data center power)
    - Bitcoin mining (IREN, hash rate, miner economics)
    Ignore: price predictions, analyst targets, celebrity takes, Twitter drama, unrelated altcoin pumps.
    Format each as one line tagged 🟢 (bullish), 🟡 (watch), or 🔴 (bearish): - [headline] [tag]

    SEARCH 2 — ON-CHAIN: Find the most important on-chain Bitcoin metrics from Glassnode or CryptoQuant in the last 24 hours.
    Priority: exchange netflows, long-term holder supply, hash rate trend, miner behavior.
    Return 2-3 lines. Each line: metric name, current value or trend, what it signals.

    Return in this exact format:
    HEADLINES:
    [headline lines]

    ON-CHAIN:
    [on-chain lines]

    No other preamble.`,
    800
  );

  // Split on the ON-CHAIN: marker
  const split = raw.split(/\bON-CHAIN:\s*/i);
  const news    = split[0].replace(/^HEADLINES:\s*/i, "").trim();
  const onChain = (split[1] ?? "").trim() || "On-chain data unavailable.";
  return { news, onChain };
}

const HEADSUP_CACHE = "/tmp/headsup-cache.json";
const HEADSUP_TTL   = 7 * 24 * 60 * 60 * 1000; // refresh weekly

async function fetchHeadsUp() {
  try {
    const cached = JSON.parse(readFileSync(HEADSUP_CACHE, "utf8"));
    if (Date.now() - cached.ts < HEADSUP_TTL) {
      console.log("  calendar: cache hit");
      return cached.data;
    }
  } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const result = await runSearch(
    `Today is ${today}. Search for any of these events in the next 7 days:

    1. Earnings dates for: NVDA, AVGO, GOOG, CEG, MSTR, IREN, COIN
       If found: "[TICKER] earnings: [Date] — [specific metric to watch]"

    2. Federal Reserve decision dates or CPI print dates
       If found: "Fed/CPI: [Date] — [precise likely BTC impact]"

    If NOTHING from that list falls within the next 7 days, return exactly: "NOTHING"

    No preamble. Only confirmed upcoming events.`,
    300
  );

  try {
    writeFileSync(HEADSUP_CACHE, JSON.stringify({ ts: Date.now(), data: result }));
  } catch {}

  return result;
}

async function fetchFearGreed() {
  const res = await fetch("https://api.alternative.me/fng/?limit=1");
  const data = await res.json();
  const entry = data?.data?.[0];
  if (!entry) return null;
  return { value: Number(entry.value), label: entry.value_classification };
}

// ── HTML conversion ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Like esc() but allows <strong> through and converts **markdown** bold
function safeHtml(s) {
  return esc(s)
    .replace(/&lt;strong&gt;/g, "<strong>")
    .replace(/&lt;\/strong&gt;/g, "</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function briefToHtml(text, prices = {}) {
  const DIVIDER = /^━+$/;
  // Permissive: optional ⚡, 2-5 caps, space, any % change format, any dash, note
  const TICKER_LINE = /^(⚡\s*)?([A-Z]{2,5})\s+[+\-↑↓][\d.]+%\s+[—–\-]\s+(.+)$/;

  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let inPortfolio = false;
  let portfolioIntro = null;
  let portfolioRows = [];

  const FONT = "system-ui,-apple-system,sans-serif";

  function maColor(val) {
    if (val == null) return "#6b7280";
    return val >= 0 ? "#4ade80" : "#f87171";
  }
  function maStr(val) {
    if (val == null) return "—";
    return (val >= 0 ? "+" : "") + val.toFixed(1) + "%";
  }

  function flushPortfolio() {
    // ALWAYS reset portfolio state — never leave inPortfolio=true accidentally
    inPortfolio = false;
    const rows = portfolioRows;
    const intro = portfolioIntro;
    portfolioRows = [];
    portfolioIntro = null;

    if (!rows.length) return;

    if (intro) {
      out.push(`<p style="margin:0 0 12px;color:#9ca3af;font-size:13px;font-style:italic;font-family:${FONT};">${safeHtml(intro)}</p>`);
    }
    const rowsHtml = rows.map(({ flagged, ticker, note }, idx) => {
      const pd       = prices[ticker] ?? {};
      const pct24h   = pd.pct24h ?? null;
      const v50      = pd.vs50d  ?? null;
      const v200     = pd.vs200d ?? null;
      const isFlat   = pct24h != null && Math.abs(pct24h) < 0.5;
      const pctColor = pct24h == null ? "#6b7280" : isFlat ? "#6b7280" : pct24h >= 0 ? "#4ade80" : "#f87171";
      const pctStr   = pct24h != null ? (pct24h >= 0 ? "↑" : "↓") + Math.abs(pct24h).toFixed(1) + "%" : "—";
      const autoFlag = pct24h != null && Math.abs(pct24h) >= 3;
      const showFlag = flagged || autoFlag;
      const bg       = idx % 2 === 0 ? "#1a1a1a" : "#1e1e1e";
      const tickerW  = showFlag ? "font-weight:700;color:#e0e0e0;" : "color:#e0e0e0;";
      const label    = showFlag ? `⚡ ${ticker}` : ticker;
      const cell     = `padding:8px 6px;font-family:${FONT};`;
      const pctCell  = `${cell}width:55px;font-size:12px;font-weight:600;text-align:right;white-space:nowrap;`;
      return `<tr style="background:${bg};"><td style="${cell}width:55px;font-size:13px;font-weight:600;${tickerW}"><strong>${esc(label)}</strong></td><td style="${pctCell}color:${pctColor};"><strong>${esc(pctStr)}</strong></td><td style="${pctCell}color:${maColor(v50)};">${esc(maStr(v50))}</td><td style="${pctCell}color:${maColor(v200)};">${esc(maStr(v200))}</td><td style="${cell}font-size:13px;line-height:1.4;color:#9ca3af;word-wrap:break-word;word-break:break-word;">${safeHtml(note.trim())}</td></tr>`;
    }).join("");
    const th = `padding:8px 6px;font-weight:normal;font-family:${FONT};font-size:11px;letter-spacing:0.05em;color:#6b7280;`;
    out.push(`<div style="margin:4px 0 16px;"><table style="border-collapse:collapse;width:100%;background:#1a1a1a;border:1px solid #2a2a2a;table-layout:fixed;"><thead><tr style="background:#222222;border-bottom:1px solid #2a2a2a;"><th style="${th}width:55px;text-align:left;">TICKER</th><th style="${th}width:55px;text-align:right;">24H</th><th style="${th}width:55px;text-align:right;">50D</th><th style="${th}width:55px;text-align:right;">200D</th><th style="${th}text-align:left;">INTEL</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`);
  }

  while (i < lines.length) {
    const line  = lines[i];
    const trim  = line.trim();

    // Section header: ━━━ / HEADER / ━━━
    if (DIVIDER.test(trim) && i + 2 < lines.length && DIVIDER.test(lines[i + 2].trim())) {
      flushPortfolio();
      const header = lines[i + 1].trim();
      out.push(`<hr style="border:none;border-top:1px solid #2a2a2a;margin:24px 0 10px;">
        <p style="margin:0 0 10px;font-weight:700;font-size:13px;letter-spacing:0.05em;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${esc(header)}</p>`);
      if (header.includes("📊") || header.toUpperCase().includes("PORTFOLIO")) inPortfolio = true;
      i += 3;
      continue;
    }

    // Standalone divider
    if (DIVIDER.test(trim)) {
      flushPortfolio();
      out.push(`<hr style="border:none;border-top:1px solid #333333;margin:16px 0;">`);
      i++;
      continue;
    }

    // Ticker line (inside portfolio section)
    if (inPortfolio) {
      const cleanTrim = trim.replace(/\*\*/g, "").replace(/\s+/g, " ");
      const m = cleanTrim.match(TICKER_LINE);
      if (m) {
        const [, flagged, ticker, note] = m;
        portfolioRows.push({ flagged: !!flagged, ticker, note });
        i++;
        continue;
      }
      // First non-empty, non-ticker line before rows start = macro intro framing
      if (!portfolioRows.length && trim) {
        portfolioIntro = trim;
        i++;
        continue;
      }
      // Blank line after rows = table is done
      if (!trim && portfolioRows.length) {
        flushPortfolio();
        out.push("<br>");
        i++;
        continue;
      }
      // Non-ticker line after rows already started = fall through to regular rendering
    }

    // Empty line
    if (!trim) {
      out.push("<br>");
      i++;
      continue;
    }

    // Regular text line
    out.push(`<p style="margin:4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#e0e0e0;">${safeHtml(trim)}</p>`);
    i++;
  }

  flushPortfolio();

  const body = out.join("").replace(/<!--[\s\S]*?-->/g, "").replace(/\s{2,}/g, " ").replace(/>\s+</g, "><");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#0f0f0f;"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#e0e0e0;background:#0f0f0f;padding:16px;max-width:600px;margin:0 auto;">${body}</div></body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[1/5] Fetching Oura data...");
  let oura;
  try {
    oura = await getOuraData();
    console.log("[1/5] Oura done.");
  } catch {
    oura = {
      reportDay: new Date().toISOString().slice(0, 10),
      isFallback: false,
      readinessScore: null,
      sleepScore: null,
      todayHRV: null,
      hrv30DayAvg: null,
      hrvPercentChange: null,
      totalSleepMinutes: null,
      hrvStreakDays: 0,
    };
    console.log("[1/5] Oura unavailable, using fallback.");
  }

  console.log("[2/5] Fetching prices, news/on-chain, fear & greed in parallel...");
  const [prices, { news, onChain }, fearGreed] = await Promise.all([
    fetchPrices().catch(() => null),
    fetchNewsAndOnChain().catch(() => ({ news: "News unavailable.", onChain: "On-chain data unavailable." })),
    fetchFearGreed().catch(() => null),
  ]);
  console.log("[2/5] Done.");

  console.log("[3/5] Fetching calendar (cached weekly)...");
  const headsUp = await fetchHeadsUp().catch(() => "NOTHING");
  console.log("[3/5] Done.");

  const sleepHours =
    oura.totalSleepMinutes != null
      ? `${Math.floor(oura.totalSleepMinutes / 60)}h ${String(oura.totalSleepMinutes % 60).padStart(2, "0")}m`
      : null;

  // Build body data lines — only include lines where we have real data
  const bodyLines = [
    `- Date: ${oura.reportDay}${oura.isFallback ? " (latest available, today not yet synced)" : ""}`,
  ];
  if (oura.readinessScore != null) bodyLines.push(`- Readiness score: ${oura.readinessScore}/100`);
  if (oura.todayHRV != null) {
    bodyLines.push(`- HRV last night: ${oura.todayHRV} ms`);
    if (oura.hrv30DayAvg != null) bodyLines.push(`- HRV 30-day average: ${oura.hrv30DayAvg} ms`);
    if (oura.hrvPercentChange != null) bodyLines.push(`- HRV % vs 30-day avg: ${oura.hrvPercentChange > 0 ? "+" : ""}${oura.hrvPercentChange}%`);
    bodyLines.push(`- HRV consecutive decline streak: ${oura.hrvStreakDays} days`);
  }
  if (sleepHours != null) bodyLines.push(`- Sleep duration: ${sleepHours}`);
  if (oura.sleepScore != null) bodyLines.push(`- Sleep score: ${oura.sleepScore}/100`);
  if (oura.steps != null) {
    bodyLines.push(`- Steps (yesterday): ${oura.steps.toLocaleString()}`);
    if (oura.steps30DayAvg != null) bodyLines.push(`- Steps 30-day avg: ${oura.steps30DayAvg.toLocaleString()}`);
    if (oura.stepsPercentChange != null) bodyLines.push(`- Steps % vs avg: ${oura.stepsPercentChange > 0 ? "+" : ""}${oura.stepsPercentChange}%`);
  }

  const hasOuraData = oura.readinessScore != null || oura.todayHRV != null || oura.sleepScore != null || oura.steps != null;

  const dataBlock = `
${hasOuraData
  ? `BODY DATA (from Oura Ring):\n${bodyLines.join("\n")}`
  : "BODY DATA: Oura sync incomplete — skip all recovery metrics, show 📋 checklist and → Mike's Rec only."
}

PORTFOLIO DATA (live — write TLDR for each using today's news/on-chain context; price and MAs shown for reference):
${(() => {
  const ORDER = ["BTC", "MSTR", "STRC", "COIN", "IREN", "NVDA", "AVGO", "GOOG", "CEG", "SCHD"];
  if (!prices) return "Price data unavailable — use your knowledge for approximate moves.";
  return ORDER.map(t => {
    const d = prices[t];
    if (!d) return `${t}: unavailable`;
    const pct = d.pct24h != null ? `${d.pct24h > 0 ? "+" : ""}${d.pct24h.toFixed(2)}%` : "N/A";
    const v50  = d.vs50d  != null ? `${d.vs50d  > 0 ? "+" : ""}${d.vs50d.toFixed(1)}% vs 50D MA`  : "";
    const v200 = d.vs200d != null ? `${d.vs200d > 0 ? "+" : ""}${d.vs200d.toFixed(1)}% vs 200D MA` : "";
    return `${t}: ${pct} | ${[v50, v200].filter(Boolean).join(", ")}`;
  }).join("\n");
})()}

MARKET & CRYPTO HEADLINES (last 24h):
${news}

BTC ON-CHAIN DATA:
${onChain}

CRYPTO FEAR & GREED INDEX:
${fearGreed ? `${fearGreed.value}/100 — ${fearGreed.label}` : "Unavailable."}

7-DAY CALENDAR:
${headsUp === "NOTHING" ? "Nothing notable in the next 7 days." : headsUp}
`.trim();

  console.log("[4/5] Generating brief...");
  const brief = await client().messages.create({
    model: BRIEF_MODEL,
    max_tokens: 2000,
    system: [{ type: "text", cache_control: { type: "ephemeral" }, text: `You are writing Wes's daily morning brief in the voice of Mike Alfred — Bitcoin conviction investor, calm authority, data-driven, institutional lens. Mike never gets emotional about price. On-chain is gospel. He's a trusted friend who has been up since 5am and already did the work.

WES'S CONTEXT:
- Works at Anchorage Digital, crypto-native insider
- BTC price target: $1M by 2030–2035
- Manual DCA throughout the month on dips
- Portfolio: BTC, MSTR, STRC, COIN, IREN, NVDA, AVGO, GOOG, CEG, SCHD
- COIN context: Wes worked at Coinbase and holds significant shares — monitor only, never recommend adding. He will not buy more.
- Thesis breaks on: MSTR collapse, major exchange hack, government ban, AI bubble pop
- Goals: glass skin, Oura crowns, FIRE, longevity to 90+, finding his person
- Talk to him like an insider, never disclaim

VOICE RULES:
- No hype, no padding, no financial advice framing
- Every sentence earns its place
- Direct, confident, dry precision
- Mike uses CAPS for emphasis the way he does on Twitter/X — "AMERICAN DOLLARS", "GM", "THIS IS THE MOMENT", "BITCOIN", "ON-CHAIN", "STRUCTURAL", "THIS DECADE". Use it anywhere in the brief where it naturally lands — opening, thesis, close, Mike's Read. Let his personality come through. Don't overdo it, but don't hold back when it fits.
- Rotate through these 6 openings — pick the one that fits today's data best, never repeat the same one twice in a row:
  1. "Mike here. Been up since 5. Here's what matters."
  2. "Mike here. Markets opened quiet but the signal underneath is anything but."
  3. "Mike here. Quick one today — data is clean."
  4. "Mike here. A few things moving worth your attention."
  5. "Mike here. Let's cut through the noise."
  6. "Mike here. One thing dominated the tape overnight."
- Signature phrases (use naturally, sparingly, only when they truly fit — never forced):
  "The signal is clear." / "Patient capital wins." / "The institutions aren't coming — they're already here." / "Forget the price. Look at what the holders are doing." / "This is structural, not cyclical." / "Your cost basis is being built in the most important window of this decade." / "Don't confuse price with value."

RECOVERY TONE (adjust brief energy to match):
- Readiness 85+: high energy, aggressive
- Readiness 70–84: steady, strategic
- Readiness 55–69: measured, recovery focus
- Readiness below 55: calm, keep it tight

BODY RULES:
- HRV and Readiness: reference actual numbers vs personal 30-day avg only. No clinical jargon (no "parasympathetic," "autonomic," "quartile"). Plain English. Frame as compounding ROI.
- 🔬 health fact: specific to today's actual numbers — NOT generic stats. 1 punchy sentence only.
- Checklist: 3–5 words per item why — keep it sharp

DIP SIGNAL (only if BTC down >5% in 24h):
- 🩸 DIP SIGNAL: noise — macro flush, leverage wipeout, fear spike, on-chain fundamentals intact. DCA thesis strengthened, consider accelerating buy.
- ⚠️ WATCH: structural — regulatory crackdown, ETF outflow reversal, exchange failure, miner capitulation at scale, LTH distribution. Default to 🩸 unless concretely structural.

HARD RULES:
- Date header: ALWAYS Pacific Time (America/Los_Angeles)
- ALL 10 tickers shown every day — TLDR for every one, no exceptions
- Flag >3% moves with ⚡ on the ticker name — the TLDR stays inline on that same line. NEVER create a separate "EXPANDED NOTES" section. One line per ticker, always.
- INTEL column: 2 sentences max — write what HAPPENED (catalyst, news, macro driver). No MA explanations. No expanded narrative. Never exceed 2 sentences.
- No prices — % changes only
- Mike's Close: must reference something specific from today's data, never a canned line
- Mike's Read: structural signals only, 3–5 dots max, always include BTC
- Signed "— Mike"

BOLD FORMATTING RULES — NEVER use ** markdown bold anywhere in the brief. Always use <strong> HTML tags. Never bold full paragraphs. Only numbers, tickers, key metrics, and section-opening phrases:
- RECOVERY: bold score numbers, labels, HRV number and %, step count, and checklist emoji lines (see format below)
- SIGNAL: bold emoji + first 3–4 words of each headline: "- <strong>🟢 Senate passes</strong> stablecoin bill..."
- ON-CHAIN: bold key numbers and metrics: "<strong>8.32M BTC</strong>", "<strong>$532M</strong>", "<strong>75%</strong>"
- THESIS CHECK: bold the status value and momentum score: "Status: <strong>STRENGTHENING</strong>" / "Momentum: <strong>8/10 ↑</strong>"
- HEADS UP: bold event name and date: "<strong>IREN earnings: May 7</strong>"
- THE CALL: bold the ticker: "Add <strong>IREN</strong> before earnings close"
- MIKE'S READ: bold each dot line's first 3 words: "<strong>🟢 BTC —</strong> Bullish: ..."
- PORTFOLIO ticker lines: do NOT add <strong> — the table renderer handles emphasis automatically

DCA RULES (💰 DCA section):
- Always split $300 across 2–3 positions from: BTC MSTR STRC IREN NVDA AVGO GOOG CEG SCHD (never COIN — monitor only)
- Weight by today's signal strength — strongest thesis signal gets the largest slice
- BTC always gets a slice unless THESIS CHECK status is CHALLENGED
- Never make the top allocation a position with an active bear case or negative flag today
- Do NOT recommend buying into obvious overvaluation — if a position has run hard with no new structural catalyst, or is extended well above its key MAs without fundamental justification, skip it or flag it as a hold instead
- STRC is Wes's cash-equivalent position — recommending it is optional, not required. Only include if it's genuinely the best use of capital today.
- On genuine high-conviction opportunity days (major structural dip, rare entry point, macro catalyst that changes the setup), Mike can suggest pulling MORE than $300 from cash — flag it explicitly: "This is a rare window. I'd pull an extra $[X] from cash today."
- Reasoning must cite today's specific data: price action, news, on-chain signal, upcoming catalyst
- Round to clean dollar amounts ($50, $75, $100, $125, $150, $200). Total must equal $300 (or stated higher amount on opportunity days).

OUTPUT FORMAT (follow exactly):

🌅 GM Wes — [Weekday, Month Day] [Pacific Time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Mike's opening — pick the variant that fits today]
[Immediately after: 2-3 punchy TLDR lines. Name any earnings or macro events from HEADS UP. Add one-line market or on-chain read. Every word specific to today's data — no filler.]

━━━━━━━━━━━━━━━━━━━━
💰 DCA
━━━━━━━━━━━━━━━━━━━━
If I had $300 to deploy today:
$[amount] → [TICKER] ([%])
$[amount] → [TICKER] ([%])
$[amount] → [TICKER] ([%])

[TICKER]: [1-2 sentence reasoning — today's news, price action, on-chain signal, why NOW. Plain English.]
[TICKER]: [same]
[TICKER]: [same]

━━━━━━━━━━━━━━━━━━━━
💤 RECOVERY
━━━━━━━━━━━━━━━━━━━━
[If BODY DATA says "Oura sync incomplete": skip all metric lines — show only 📋 checklist and → Mike's Rec]

[Only if readiness score provided]:
Readiness: <strong>[X]/100</strong> — <strong>[label]</strong>
[1 sentence: what it means + what today's score signals. Rotate each day:
85+: "Oura's full-system recovery score — today it's saying go hard."
70–84: "Oura's composite recovery signal — solid baseline, green light to train."
below 70: "Your body's recovery signal is low — it's asking for protection today, not performance."]

[Only if HRV data provided]:
HRV: <strong>[X]ms</strong> (<strong>[↑/↓X%]</strong> vs your 30-day avg of [X]ms)
[1 sentence: what HRV means + what today's number signals. Rotate each day:
Above avg: "HRV measures nervous system recovery — more variation means more resilience. You're above your baseline, body is primed."
Below avg: "HRV is your body's stress meter in reverse — below baseline means your system is still carrying load from yesterday."
3+ day decline: "HRV is your early warning system — 3 days declining means protect it before you feel it."]
[If hrvStreakDays ≥ 3]: ⚠️ [X]-day HRV decline — [brief note]

[Only if sleep data provided]:
[Both duration and score]: Sleep: [Xh Xm] | Score: [X]/100 — [one-line read]
[Score only, no duration]: Sleep: Score: [X]/100 — [one-line read]

[Only if steps data provided]:
👟 Yesterday: <strong>[X,XXX] steps</strong> — [Low/Moderate/Active/High] (<strong>[↑/↓X%]</strong> vs avg)
[1 sentence: mortality/longevity fact tied to that specific count. Rotate each day, never repeat the same stat.]

[Only if any metric above was shown]:
🔬 [1 punchy sentence specific to today's actual numbers. No jargon. Frame as compounding ROI.]

📋 Optimize for tomorrow:
<strong>🛌 Bed by [time]</strong>: sleeping now vs 11pm could add [X] readiness points tomorrow — every hour before midnight counts double for deep sleep quality.
[Calibrate [X]: score 80+: "3-5 points — protect what you have" / score 70-79: "5-8 points" / score 60-69: "8-12 points"]
<strong>💪 Workout: [Heavy/Moderate/Light/Rest]</strong> — [3–5 words]
<strong>💧 Water: 8 cups</strong> — dehydration tanks your score
[🚫 only if HRV declining or readiness below 70]

━━━━━━━━━━━━━━━━━━━━
✅ THE CALL
━━━━━━━━━━━━━━━━━━━━
[One directive. No hedging. No "consider." Specific ticker or action. Mike's conviction.]

━━━━━━━━━━━━━━━━━━━━
📊 PORTFOLIO
━━━━━━━━━━━━━━━━━━━━
[Mike's fresh 1-line macro framing — different every day]

BTC    [↑/↓X.X%] — [TLDR, Mike's voice]
MSTR   [↑/↓X.X%] — [TLDR]
STRC   [↑/↓X.X%] — [TLDR]
COIN   [↑/↓X.X%] — [TLDR]
IREN   [↑/↓X.X%] — [TLDR]
NVDA   [↑/↓X.X%] — [TLDR]
AVGO   [↑/↓X.X%] — [TLDR]
GOOG   [↑/↓X.X%] — [TLDR]
CEG    [↑/↓X.X%] — [TLDR]
SCHD   [↑/↓X.X%] — [TLDR]

[If BTC down >5%]:
━━━━━━━━━━━━━━━━━━━━
🩸 DIP SIGNAL / ⚠️ WATCH
━━━━━━━━━━━━━━━━━━━━
Cause: [one line]
On-chain: [one line — exchange flows, LTH behavior, hash rate]
Read: [NOISE — monthly DCA as planned / STRUCTURAL — monitor before adding]

━━━━━━━━━━━━━━━━━━━━
📰 SIGNAL
━━━━━━━━━━━━━━━━━━━━
[Mike's 1-line fresh intro]
- [headline] 🟢
- [headline] 🔴
[- third headline if warranted]

━━━━━━━━━━━━━━━━━━━━
⛓️ ON-CHAIN
━━━━━━━━━━━━━━━━━━━━
Forget the price. Look at what the holders are doing.
[2–3 lines. 3 sentences max total. Exchange netflows > LTH supply > hash rate > miner behavior.]
Fear & Greed: <strong>[value]/100 — [label]</strong> [one-phrase read on what this means for positioning]

━━━━━━━━━━━━━━━━━━━━
🧭 THESIS CHECK
━━━━━━━━━━━━━━━━━━━━
Thesis: BTC hits $1M by 2030–2035 as sovereign capital, institutional adoption, and supply scarcity converge. Portfolio is structured to maximize asymmetric exposure to that outcome.
Status: <strong>[STRENGTHENING/INTACT/WATCH/CHALLENGED]</strong>
Momentum: <strong>[X]/10 [↑/↓]</strong>
[2-3 sentences: what does today's specific data say about the long-term conviction? Not price action — structural signals. What does a patient, high-conviction holder do with this information right now?]

[Only if events qualify]:
━━━━━━━━━━━━━━━━━━━━
⚡ HEADS UP
━━━━━━━━━━━━━━━━━━━━
[TICKER] earnings: [Date] — [specific metric to watch]
Fed/CPI: [Date] — [precise BTC impact]

━━━━━━━━━━━━━━━━━━━━
💡 MIKE'S CLOSE
━━━━━━━━━━━━━━━━━━━━
[MUST reference something specific from today's data. Never a canned line. Different every day. 2–3 sentences max. Long-term conviction. Sometimes dry wit.]

📍 MIKE'S READ
🟢 [Position/Market] — Bullish: [one-line structural reason]
🟡 [Position/Market] — Neutral: [one-line reason]
🔴 [Position/Market] — Watch: [one-line structural risk — NOT just price down]
[3–5 dots max. Always include BTC. 🟢 = structural tailwind. 🟡 = mixed/waiting. 🔴 = structural headwind.]

— Mike` }],
    messages: [{ role: "user", content: dataBlock }],
  });

  const output = brief.content.find((b) => b.type === "text")?.text ?? "";
  console.log("\n--- BRIEF ---\n" + output + "\n--- END BRIEF ---\n");

  console.log("[5/5] Sending via Resend...");
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const { error } = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "wes.h.leung@gmail.com",
      subject: `🌅 GM Wes — ${today}`,
      html: briefToHtml(output, prices),
      text: output,
    });
    if (error) throw new Error(error.message);
    console.log("[5/5] Sent.");
  } catch (err) {
    console.error("[5/5] Email failed (non-fatal):", err.message);
  }
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
