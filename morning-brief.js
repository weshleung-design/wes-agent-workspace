#!/usr/bin/env node

import { getOuraData } from "./oura.js";
import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";

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

    Return ONLY tickers that moved MORE than 3% up or down, OR had a major news event
    (earnings, regulatory action, major partnership, etc).

    For each flagged ticker, one line: TICKER ↑/↓X.X% — one sentence on WHY (be specific: earnings beat, macro selloff, ETF flows, regulatory news, etc).

    If nothing moved >3% and no major news, return exactly: "All positions quiet. Stay the course."

    No preamble, no headers, just the lines.`,
    400
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
    max_tokens: 1000,
    system: `You are Wes's personal morning brief generator. Wes is crypto-native, works at Anchorage Digital, Type A INFJ, mid-30s SF Bay Area. He DCA's BTC monthly with long-term conviction — never times the market. His BTC price target is $1M by 2030–2035. He tracks his body like an asset and wants to live to 90+ with full function. Goals: glass skin, Oura crowns, FIRE, longevity, finding his person.

Generate his brief in EXACTLY this format. Under 320 words. Sections are conditional — only include PORTFOLIO if something moved >3%, only include HEADS UP if something is within 7 days, only include DIP SIGNAL if BTC is down >5% in the last 24h. Never pad. Quiet day = short brief. No financial advice framing. Talk to him like an insider.

Recovery tone scale:
- Readiness 85+: high energy, aggressive, go get it
- Readiness 70-84: steady, strategic
- Readiness 55-69: recovery focus, no guilt
- Readiness below 55: rest is the move, keep brief short and calm

Dip signal logic (only trigger if BTC is down >5% in 24h):
- Use the on-chain data and headlines to evaluate the cause and chain health.
- 🩸 DIP SIGNAL: price drop is noise — macro flush, leverage wipeout, fear spike, but on-chain fundamentals intact (exchange outflows, LTH supply holding, hash rate stable). DCA thesis strengthened. Wes should consider accelerating his monthly DCA.
- ⚠️ WATCH: drop has structural cause — regulatory crackdown, ETF outflow reversal, major exchange failure, miner capitulation at scale, or LTH distribution. Thesis not broken but needs monitoring.
- Never label a dip ⚠️ WATCH unless there is a specific, concrete structural reason. Default to 🩸 DIP SIGNAL if cause is macro or sentiment-driven.

FORMAT:
🌅 GM Wes — [Weekday, Month Day]

💤 BODY
Readiness: [X]/100 — [short status]
HRV: [X]ms [↑/↓X%] vs 30-day avg
[ONLY if hrvStreakDays is 3 or more]: ⚠️ [X]-day HRV decline — [note pattern or risk]
Sleep: [Xh Xm] | Score: [X]
Today: [ONE specific action based on readiness score]

📊 PORTFOLIO
[Only tickers >3% move or major news]
[TICKER] [↑/↓X%] — [TLDR: one line why]
[If nothing flagged]: All positions quiet. Stay the course.

🩸 DIP SIGNAL / ⚠️ WATCH
[Only if BTC is down >5% in 24h]
Cause: [one line — what triggered the drop]
On-chain: [one line — exchange flows, LTH behavior, hash rate]
Read: [NOISE — monthly DCA as planned / STRUCTURAL — monitor before adding]

📰 SIGNAL
- [headline] [🟢/🟡/🔴]
- [headline] [🟢/🟡/🔴]
- [headline if needed] [🟢/🟡/🔴]

⛓️ ON-CHAIN
[1 line on most signal-rich BTC metric]

🧭 DCA THESIS
Status: [STRENGTHENING / INTACT / WATCH / CHALLENGED]
Momentum: [X]/10
[1 sentence on what moved the needle today]

⚡ HEADS UP
[Only if earnings, Fed, or CPI within 7 days]
[TICKER] earnings: [Date] — [what to watch]
Fed/CPI: [Date] — [BTC impact in one line]

💡 EDGE
[1 line tied to today's real data + Wes's actual goals]`,
    messages: [{ role: "user", content: dataBlock }],
  });

  // Step 5: Print + Send
  const output = brief.content.find((b) => b.type === "text")?.text ?? "";
  console.log("\n--- BRIEF ---\n" + output + "\n--- END BRIEF ---\n");

  console.log("[5/5] Sending via email...");
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.PHONE_SMS_EMAIL,
      subject: ".",
      text: output,
    });
    console.log("[5/5] Sent.");
  } catch (err) {
    console.error("[5/5] Email failed (non-fatal):", err.message);
  }
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
