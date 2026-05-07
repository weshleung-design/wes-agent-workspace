#!/usr/bin/env node

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

async function fetchPortfolio() {
  const tickers = "BTC, MSTR, STRC, IREN, NVDA, AVGO, GOOG, CEG, SCHD";
  return runSearch(
    `Search for today's 24-hour price performance for these tickers: ${tickers}.

    Return ALL 9 tickers — every single one, no exceptions.
    For each ticker, one line: TICKER ↑/↓X.X% — one sentence on WHY (macro, sector move, ETF flows, earnings, news catalyst, or "quiet session, no catalyst" if flat).
    Flag any ticker that moved more than 3% with ⚡ at the start of the line.

    No preamble, no headers, just the 9 lines.`,
    600
  );
}

async function fetchNews() {
  return runSearch(
    `Search for the 2-3 most important structural headlines from the last 24 hours in:
    - Bitcoin and crypto regulation
    - BTC ETF flows
    - Institutional Bitcoin or crypto adoption
    - AI infrastructure (NVDA, AVGO, GOOG data centers, AI chips)
    - Energy / nuclear (CEG, data center power)
    - Bitcoin mining (IREN, hash rate, miner economics)

    Ignore: price predictions, analyst price targets, celebrity takes, Twitter drama, altcoin pumps unrelated to those sectors.

    Format each as one line. Tag 🟢 (bullish for BTC + AI infra thesis), 🟡 (watch), or 🔴 (bearish).
    Format: - [headline summary] [tag]

    No preamble.`,
    500
  );
}

async function fetchOnChain() {
  return runSearch(
    `Search Glassnode or CryptoQuant for the most important on-chain Bitcoin data published in the last 24 hours.
    Priority order: exchange netflows, long-term holder supply changes, hash rate trend, miner behavior.

    Return 2-3 lines covering the most signal-rich metrics. Each line: metric name, current value or trend, what it signals.
    No preamble, no source citations.`,
    300
  );
}

async function fetchHeadsUp() {
  const today = new Date().toISOString().slice(0, 10);
  return runSearch(
    `Today is ${today}. Search for any of these events in the next 7 days:

    1. Earnings dates for: NVDA, AVGO, GOOG, CEG, MSTR, IREN
       If found: "[TICKER] earnings: [Date] — [specific metric to watch]"

    2. Federal Reserve decision dates or CPI print dates
       If found: "Fed/CPI: [Date] — [precise likely BTC impact]"

    If NOTHING from that list falls within the next 7 days, return exactly: "NOTHING"

    No preamble. Only confirmed upcoming events.`,
    300
  );
}

// ── HTML conversion ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function briefToHtml(text) {
  const DIVIDER = /^━+$/;
  const TICKER  = /^(⚡\s*)?([A-Z]{2,5})\s+(↑|↓)(\d+\.?\d*)%\s+—\s+(.+)$/;

  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let inPortfolio = false;
  let portfolioIntro = null;
  let portfolioRows = [];

  function flushPortfolio() {
    if (!portfolioRows.length) return;
    if (portfolioIntro) {
      out.push(`<p style="margin:0 0 10px;color:#888;font-size:12px;font-style:italic;">${esc(portfolioIntro)}</p>`);
    }
    const rowsHtml = portfolioRows.map(({ flagged, ticker, dir, pct, note }, idx) => {
      const isFlat = pct < 0.5;
      const pctColor = isFlat ? "#6b7280" : dir === "↑" ? "#4ade80" : "#f87171";
      const bg = idx % 2 === 0 ? "#1a1a1a" : "#222222";
      const bold = flagged ? "font-weight:bold;" : "";
      const label = flagged ? `⚡ ${ticker}` : ticker;
      return `<tr style="${bold}background:${bg};">
        <td style="padding:5px 10px;color:#e0e0e0;width:70px;">${esc(label)}</td>
        <td style="padding:5px 10px;color:${pctColor};text-align:right;width:70px;">${esc(dir + pct.toFixed(1) + "%")}</td>
        <td style="padding:5px 10px;color:#e0e0e0;">${esc(note.trim())}</td>
      </tr>`;
    }).join("");
    out.push(`<table style="width:100%;border-collapse:collapse;font-size:12px;margin:4px 0 8px;background:#1a1a1a;border:1px solid #333333;">
      <thead><tr style="background:#2a2a2a;border-bottom:1px solid #333333;">
        <th style="padding:5px 10px;text-align:left;color:#6b7280;font-weight:normal;">TICKER</th>
        <th style="padding:5px 10px;text-align:right;color:#6b7280;font-weight:normal;">24H</th>
        <th style="padding:5px 10px;text-align:left;color:#6b7280;font-weight:normal;">NOTE</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`);
    portfolioRows = [];
    portfolioIntro = null;
    inPortfolio = false;
  }

  while (i < lines.length) {
    const line  = lines[i];
    const trim  = line.trim();

    // Section header: ━━━ / HEADER / ━━━
    if (DIVIDER.test(trim) && i + 2 < lines.length && DIVIDER.test(lines[i + 2].trim())) {
      flushPortfolio();
      const header = lines[i + 1].trim();
      out.push(`<hr style="border:none;border-top:1px solid #333333;margin:22px 0 8px;">
        <p style="margin:0 0 10px;font-weight:bold;font-size:12px;letter-spacing:0.07em;color:#ffffff;">${esc(header)}</p>`);
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
      const m = trim.match(TICKER);
      if (m) {
        const [, flagged, ticker, dir, pct, note] = m;
        portfolioRows.push({ flagged: !!flagged, ticker, dir, pct: parseFloat(pct), note });
        i++;
        continue;
      }
      // First non-empty non-ticker line before any rows = intro framing
      if (!portfolioRows.length && trim) {
        portfolioIntro = trim;
        i++;
        continue;
      }
      // Blank line after rows = end of portfolio block
      if (!trim && portfolioRows.length) {
        flushPortfolio();
        out.push("<br>");
        i++;
        continue;
      }
    }

    // Empty line
    if (!trim) {
      out.push("<br>");
      i++;
      continue;
    }

    // Regular text line
    out.push(`<p style="margin:2px 0;">${esc(trim)}</p>`);
    i++;
  }

  flushPortfolio();

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="margin:0;padding:0;background:#0f0f0f;">
  <div style="font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.75;color:#e0e0e0;background:#0f0f0f;padding:28px 32px;max-width:640px;margin:0 auto;">
  ${out.join("\n")}
  </div></body></html>`;
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

  console.log("[2/5] Fetching portfolio + news in parallel...");
  const [portfolio, news] = await Promise.all([
    fetchPortfolio().catch(() => "Portfolio data unavailable."),
    fetchNews().catch(() => "News unavailable."),
  ]);
  console.log("[2/5] Done.");

  console.log("[3/5] Fetching on-chain + calendar in parallel...");
  const [onChain, headsUp] = await Promise.all([
    fetchOnChain().catch(() => "On-chain data unavailable."),
    fetchHeadsUp().catch(() => "NOTHING"),
  ]);
  console.log("[3/5] Done.");

  const sleepHours =
    oura.totalSleepMinutes != null
      ? `${Math.floor(oura.totalSleepMinutes / 60)}h ${String(oura.totalSleepMinutes % 60).padStart(2, "0")}m`
      : "unknown";

  const hrvChangeStr =
    oura.hrvPercentChange != null
      ? `${oura.hrvPercentChange > 0 ? "+" : ""}${oura.hrvPercentChange}%`
      : "unknown";

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

PORTFOLIO (24h):
${portfolio}

MARKET & CRYPTO HEADLINES (last 24h):
${news}

BTC ON-CHAIN DATA:
${onChain}

7-DAY CALENDAR:
${headsUp === "NOTHING" ? "Nothing notable in the next 7 days." : headsUp}
`.trim();

  console.log("[4/5] Generating brief...");
  const brief = await client().messages.create({
    model: BRIEF_MODEL,
    max_tokens: 2000,
    system: `You are writing Wes's daily morning brief in the voice of Mike Alfred — Bitcoin conviction investor, calm authority, data-driven, institutional lens. Mike never gets emotional about price. On-chain is gospel. He's a trusted friend who has been up since 5am and already did the work.

WES'S CONTEXT:
- Works at Anchorage Digital, crypto-native insider
- BTC price target: $1M by 2030–2035
- Manual DCA throughout the month on dips
- Portfolio: BTC, MSTR, STRC, IREN, NVDA, AVGO, GOOG, CEG, SCHD
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
- HRV fact must reference his actual numbers vs his personal 30-day avg
- Health fact: specific to his data that day — NOT generic stats. Plain English, no clinical jargon (no "parasympathetic," "autonomic," "quartile"). Write like texting a friend. Frame as compounding ROI — longevity, glass skin, cognitive edge. Max 2 sentences.
- Checklist: include the WHY briefly for each item so Wes knows what lever he's pulling

DIP SIGNAL (only if BTC down >5% in 24h):
- 🩸 DIP SIGNAL: noise — macro flush, leverage wipeout, fear spike, on-chain fundamentals intact. DCA thesis strengthened, consider accelerating buy.
- ⚠️ WATCH: structural — regulatory crackdown, ETF outflow reversal, exchange failure, miner capitulation at scale, LTH distribution. Default to 🩸 unless concretely structural.

HARD RULES:
- Date header: ALWAYS Pacific Time (America/Los_Angeles)
- ALL 9 tickers shown every day — TLDR for every one, no exceptions
- Flag >3% moves with ⚡ and give an expanded note
- No prices — % changes only
- Mike's Close: must reference something specific from today's data, never a canned line
- Mike's Read: structural signals only, 3–5 dots max, always include BTC
- Signed "— Mike"

OUTPUT FORMAT (follow exactly):

🌅 GM Wes — [Weekday, Month Day] [Pacific Time]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Mike's opening — pick the variant that fits today]

━━━━━━━━━━━━━━━━━━━━
💤 RECOVERY
━━━━━━━━━━━━━━━━━━━━
Readiness: [X]/100 — [Optimal/Solid/Moderate/Low]
HRV: [X]ms ([↑/↓X%] vs your 30-day average of [X]ms) — [one-line plain English read]
Sleep: [Xh Xm] | Score: [X]/100 — [one-line read]
[If hrvStreakDays ≥ 3]: ⚠️ [X]-day HRV decline — [brief note]

🔬 [One health fact — specific to his actual HRV/readiness numbers today. Plain English. No jargon. Frame as compounding ROI. Max 2 sentences.]

📋 Optimize for tomorrow:
🛌 Bed by [specific time]: [one-line why, tied to his score]
💪 Workout: [Heavy/Moderate/Light/Rest] — [reason tied to readiness]
👟 Steps: [8,000 or 5,000 on recovery days] — [one-line why]
💧 Water: 64oz — dehydration raises resting heart rate, which directly tanks your readiness score
[🚫 Only if HRV declining or score <70: specific recovery action with brief why]

→ Mike's Rec: [One dry, precise line. Mike's conviction.]

━━━━━━━━━━━━━━━━━━━━
📊 PORTFOLIO
━━━━━━━━━━━━━━━━━━━━
[Mike's fresh 1-line macro framing — different every day]

BTC    [↑/↓X.X%] — [TLDR, Mike's voice]
MSTR   [↑/↓X.X%] — [TLDR]
STRC   [↑/↓X.X%] — [TLDR]
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
[2–3 lines. Exchange netflows > LTH supply > hash rate > miner behavior. Mike's specialty — don't shortchange it.]

━━━━━━━━━━━━━━━━━━━━
🧭 THESIS CHECK
━━━━━━━━━━━━━━━━━━━━
Status: [STRENGTHENING/INTACT/WATCH/CHALLENGED]
Momentum: [X]/10 [↑/↓]
[Mike's 2–3 sentences referencing today's specific data. $1M thesis lens. Never canned. Mike recommends which position from the DCA list he'd be adding to today and why.]

[Only if events qualify]:
━━━━━━━━━━━━━━━━━━━━
⚡ HEADS UP
━━━━━━━━━━━━━━━━━━━━
[TICKER] earnings: [Date] — [specific metric to watch]
Fed/CPI: [Date] — [precise BTC impact]

━━━━━━━━━━━━━━━━━━━━
✅ THE CALL
━━━━━━━━━━━━━━━━━━━━
[One directive. No hedging. No "consider." Specific ticker or action. Mike's conviction.]

━━━━━━━━━━━━━━━━━━━━
💡 MIKE'S CLOSE
━━━━━━━━━━━━━━━━━━━━
[MUST reference something specific from today's data. Never a canned line. Different every day. 2–4 sentences. Long-term conviction. Sometimes dry wit.]

📍 MIKE'S READ
🟢 [Position/Market] — Bullish: [one-line structural reason]
🟡 [Position/Market] — Neutral: [one-line reason]
🔴 [Position/Market] — Watch: [one-line structural risk — NOT just price down]
[3–5 dots max. Always include BTC. 🟢 = structural tailwind. 🟡 = mixed/waiting. 🔴 = structural headwind.]

— Mike`,
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
      html: briefToHtml(output),
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
