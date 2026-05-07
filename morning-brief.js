#!/usr/bin/env node

import { getOuraData } from "./oura.js";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";

console.log("ENV CHECK:", !!process.env.ANTHROPIC_API_KEY);

const SEARCH_MODEL = "claude-haiku-4-5-20251001";
const BRIEF_MODEL  = "claude-sonnet-4-6";
const SEARCH_TOOL  = [{ type: "web_search_20250305", name: "web_search" }];

// Lazily created so the API key is definitely loaded before instantiation
let _client;
function client() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Run a prompt with web_search and return the final text response.
// Handles the agentic loop and retries on rate limits.
async function runSearch(prompt, maxTokens = 500) {
  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 65000; // 65s, then 130s — clear the 1-min rate limit window
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

// ── Step 2: Portfolio movers ──────────────────────────────────────────────────
async function fetchPortfolio() {
  const tickers = "BTC, MSTR, STRC, IREN, NVDA, AVGO, GOOG, CEG, SCHD";
  return runSearch(
    `Search for today's 24-hour price performance for these tickers: ${tickers}.

    Return ALL 9 tickers — every single one, no exceptions.
    For each ticker, one line: TICKER ↑/↓X.X% — one sentence on WHY (be specific: macro, sector move, ETF flows, earnings, news catalyst, or "quiet session, no catalyst" if flat).

    No preamble, no headers, just the 9 lines.`,
    500
  );
}

// ── Step 3: Market & crypto headlines ────────────────────────────────────────
async function fetchNews() {
  return runSearch(
    `Search for the 2-3 most important structural headlines from the last 24 hours in these areas:
    - Bitcoin and crypto regulation
    - BTC ETF flows
    - Institutional Bitcoin or crypto adoption
    - AI infrastructure (NVDA, AVGO, GOOG data centers, AI chips)
    - Energy / nuclear (CEG, data center power)
    - Bitcoin mining (IREN, hash rate, miner economics)

    Ignore: price predictions, analyst price targets, celebrity takes, Twitter drama, altcoin pumps unrelated to those sectors.

    For each headline: one line. Tag each with 🟢 (bullish for long BTC + AI infrastructure thesis), 🟡 (watch), or 🔴 (bearish).
    Format: - [headline summary] [tag]

    No preamble.`,
    500
  );
}

// ── Step 4: BTC on-chain signal ───────────────────────────────────────────────
async function fetchOnChain() {
  return runSearch(
    `Search Glassnode or CryptoQuant for ONE on-chain Bitcoin metric published in the last 24 hours.
    Priority order: exchange netflows, long-term holder supply, hash rate trend, miner behavior.

    Return exactly 1 line: the metric name, the current value or trend, and what it signals.
    No preamble, no source citation needed.`,
    200
  );
}

// ── Step 5: 7-day calendar lookahead ─────────────────────────────────────────
async function fetchHeadsUp() {
  const today = new Date().toISOString().slice(0, 10);
  return runSearch(
    `Today is ${today}. Search for any of these events in the next 7 days:

    1. Earnings dates for: NVDA, AVGO, GOOG, CEG, MSTR, IREN
       If found: "[TICKER] earnings: [Date] — [one line on what to watch]"

    2. Federal Reserve decision dates or CPI print dates
       If found: "Fed/CPI: [Date] — [one line on likely BTC impact]"

    If NOTHING from that list falls within the next 7 days, return exactly: "NOTHING"

    No preamble. Only include confirmed upcoming events.`,
    300
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Step 1: Oura
  console.log("[1/6] Fetching Oura data...");
  let oura;
  try {
    oura = await getOuraData();
    console.log("[1/6] Oura done.");
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
    console.log("[1/6] Oura unavailable, using fallback.");
  }

  // Steps 2–5: two parallel batches
  console.log("[2/6] Fetching portfolio + news in parallel...");
  const [portfolio, news] = await Promise.all([
    fetchPortfolio().catch(() => "Portfolio data unavailable."),
    fetchNews().catch(() => "News unavailable."),
  ]);
  console.log("[2/6] Portfolio + news done.");

  console.log("[3/6] Fetching on-chain + calendar in parallel...");
  const [onChain, headsUp] = await Promise.all([
    fetchOnChain().catch(() => "On-chain data unavailable."),
    fetchHeadsUp().catch(() => "NOTHING"),
  ]);
  console.log("[3/6] On-chain + calendar done.");

  const sleepHours =
    oura.totalSleepMinutes != null
      ? `${Math.floor(oura.totalSleepMinutes / 60)}h ${String(oura.totalSleepMinutes % 60).padStart(2, "0")}m`
      : "unknown";

  const hrvChangeStr =
    oura.hrvPercentChange != null
      ? `${oura.hrvPercentChange > 0 ? "+" : ""}${oura.hrvPercentChange}%`
      : "unknown";

  // Step 4: Generate brief
  console.log("[4/5] Generating brief...");
  const dataBlock = `
BODY DATA (from Oura Ring):
- Date: ${oura.reportDay}${oura.isFallback ? " (latest available, today not yet synced)" : ""}
- Readiness score: ${oura.readinessScore ?? "unavailable"}/100
- HRV last night: ${oura.todayHRV ?? "unavailable"} ms
- HRV 30-day average: ${oura.hrv30DayAvg ?? "unavailable"} ms
- HRV % vs 30-day avg: ${hrvChangeStr}
- HRV consecutive decline streak: ${oura.hrvStreakDays} days
- Sleep duration: ${sleepHours}
- Sleep score: ${oura.sleepScore ?? "unavailable"}/100

PORTFOLIO MOVERS (24h):
${portfolio}

MARKET & CRYPTO HEADLINES (last 24h):
${news}

BTC ON-CHAIN SIGNAL:
${onChain}

7-DAY CALENDAR LOOKAHEAD:
${headsUp === "NOTHING" ? "Nothing notable in the next 7 days." : headsUp}
`.trim();

  const brief = await client().messages.create({
    model: BRIEF_MODEL,
    max_tokens: 1500,
    system: `You are writing Wes's morning brief in the voice of Mike Alfred — Bitcoin conviction investor, calm authority, data-driven, institutional lens. Mike is a trusted friend who has been up since 5am and has already done the work so Wes doesn't have to. Direct, confident, zero hype.

Wes is crypto-native, works at Anchorage Digital, Type A INFJ, mid-30s SF Bay Area. DCA's BTC monthly, never times the market. BTC target $1M by 2030–2035. Tracks his body like an asset. Goals: glass skin, Oura crowns, FIRE, longevity, finding his person.

Voice rules:
- Open with: "Mike here. Been up since 5."
- Close with: "— Mike"
- Natural Mike Alfred phrases (use sparingly, only when they fit): "The signal is clear." / "Patient capital wins." / "The institutions aren't coming — they're already here."
- No hype, no padding, no financial advice framing
- Every sentence earns its place

Recovery tone scale (affects BODY and overall energy of the brief):
- Readiness 85+: high energy, aggressive
- Readiness 70-84: steady, strategic
- Readiness 55-69: recovery focus, no guilt
- Readiness below 55: rest is the move, keep it short

BODY: Concise reads only. HRV explained in one line as a nervous system recovery signal vs his 30-day baseline. Include one health fact framed as compounding ROI — longevity, glass skin, or cognitive edge. Then a punchy daily checklist.

Dip signal logic (only trigger if BTC is down >5% in 24h):
- Use on-chain data and headlines to evaluate cause and chain health.
- 🩸 DIP SIGNAL: noise — macro flush, leverage wipeout, fear spike, on-chain fundamentals intact. DCA thesis strengthened, consider accelerating monthly buy.
- ⚠️ WATCH: structural — regulatory crackdown, ETF outflow reversal, exchange failure, miner capitulation, LTH distribution. Thesis intact but needs monitoring.
- Default to 🩸 unless cause is concretely structural.

FORMAT:
🌅 GM Wes — [Weekday, Month Day] (Pacific Time)

Mike here. Been up since 5.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💤 BODY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Readiness: [X]/100 — [one-line read]
HRV: [X]ms [↑/↓X%] vs 30-day avg — [one line: nervous system recovery signal]
[ONLY if hrvStreakDays ≥ 3]: ⚠️ [X]-day HRV decline — [brief note]
Sleep: [Xh Xm] | Score: [X]/100
💊 [One health fact framed as compounding ROI — longevity, glass skin, or cognitive performance]

📋 To hit 100 tomorrow:
- Sleep: in bed by [specific time based on score — earlier if score low]
- Workout: [Heavy / Moderate / Light / Rest based on readiness]
- Steps: [8,000 standard / 5,000 on recovery days]
- Water: 8 glasses
[ONLY if HRV trending down]: - Recovery: [specific action — sauna, no alcohol, earlier bedtime, etc]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 PORTFOLIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BTC [↑/↓X.X%] — [one line why]
MSTR [↑/↓X.X%] — [one line why]
STRC [↑/↓X.X%] — [one line why]
IREN [↑/↓X.X%] — [one line why]
NVDA [↑/↓X.X%] — [one line why]
AVGO [↑/↓X.X%] — [one line why]
GOOG [↑/↓X.X%] — [one line why]
CEG [↑/↓X.X%] — [one line why]
SCHD [↑/↓X.X%] — [one line why]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🩸 DIP SIGNAL / ⚠️ WATCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Only if BTC down >5% in 24h]
Cause: [one line]
On-chain: [one line — exchange flows, LTH behavior, hash rate]
Read: [NOISE — monthly DCA as planned / STRUCTURAL — monitor before adding]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📰 SIGNAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- [headline] [🟢/🟡/🔴]
- [headline] [🟢/🟡/🔴]
- [headline if needed] [🟢/🟡/🔴]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⛓️ ON-CHAIN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1 line — most signal-rich BTC metric today]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧭 DCA THESIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: [STRENGTHENING / INTACT / WATCH / CHALLENGED]
Momentum: [X]/10
[1 sentence on what moved the needle today]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ HEADS UP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Only if earnings, Fed, or CPI within 7 days]
[TICKER] earnings: [Date] — [what to watch]
Fed/CPI: [Date] — [BTC impact in one line]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 EDGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1 line tied to today's data + Wes's goals]

— Mike`,
    messages: [{ role: "user", content: dataBlock }],
  });

  // Step 5: Print + Send
  const output = brief.content.find((b) => b.type === "text")?.text ?? "";
  console.log("\n--- BRIEF ---\n" + output + "\n--- END BRIEF ---\n");

  console.log("[5/5] Sending via Resend...");
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });
    const { error } = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "wes.h.leung@gmail.com",
      subject: `🌅 GM Wes — ${today}`,
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
