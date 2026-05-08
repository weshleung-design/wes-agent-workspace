#!/usr/bin/env node

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dir, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const BASE = "https://api.ouraring.com/v2/usercollection";

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d); }
function fmtDuration(min) {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

export async function getOuraData() {
  const token = process.env.OURA_API_KEY;
  if (!token) throw new Error("OURA_API_KEY not set");

  async function get(path) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Oura API ${res.status}: ${path}`);
    return res.json();
  }

  const today = isoDate(new Date());
  const thirtyDaysAgo = daysAgo(30);

  // Yesterday in Pacific Time — used for targeted step lookup
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const [readiness, dailySleep, sleepSessions, activityDay, activityHistory] = await Promise.all([
    get(`/daily_readiness?start_date=${thirtyDaysAgo}&end_date=${today}`),
    get(`/daily_sleep?start_date=${thirtyDaysAgo}&end_date=${today}`),
    get(`/sleep?start_date=${thirtyDaysAgo}&end_date=${today}`),
    get(`/daily_activity?start_date=${dateStr}&end_date=${dateStr}`),
    get(`/daily_activity?start_date=${thirtyDaysAgo}&end_date=${today}`),
  ]);

  const r = readiness.data?.at(-1);
  const s = dailySleep.data?.at(-1);
  const reportDay = r?.day ?? s?.day ?? today;

  const session = sleepSessions.data
    .filter((d) => d.day === reportDay && d.type === "sleep")
    .at(-1);

  // One session per night (longest period = primary sleep)
  const sessionsByDay = new Map();
  for (const d of sleepSessions.data) {
    if (d.type !== "sleep") continue;
    if (!sessionsByDay.has(d.day) || d.period > sessionsByDay.get(d.day).period) {
      sessionsByDay.set(d.day, d);
    }
  }

  const hrvByDay = [...sessionsByDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({ day, hrv: d.average_hrv }))
    .filter((d) => d.hrv != null);

  const hrv30DayAvg =
    hrvByDay.length > 0
      ? Math.round(hrvByDay.reduce((a, b) => a + b.hrv, 0) / hrvByDay.length)
      : null;

  const todayHRV = session?.average_hrv ?? null;
  const hrvPercentChange =
    todayHRV != null && hrv30DayAvg != null
      ? Math.round(((todayHRV - hrv30DayAvg) / hrv30DayAvg) * 100)
      : null;

  // Count consecutive declining days (most recent first)
  let hrvStreakDays = 0;
  for (let i = hrvByDay.length - 1; i > 0; i--) {
    if (hrvByDay[i].hrv < hrvByDay[i - 1].hrv) {
      hrvStreakDays++;
    } else {
      break;
    }
  }

  const totalSleepMinutes =
    session?.total_sleep_duration != null
      ? Math.round(session.total_sleep_duration / 60)
      : null;

  // Steps — targeted single-day query for accuracy, separate history query for avg
  console.log("ACTIVITY DATE:", dateStr, "STEPS:", activityDay?.data?.[0]?.steps);

  const steps = activityDay?.data?.[0]?.steps ?? null;
  const activityData = activityHistory.data ?? [];
  const stepsHistory = activityData.filter(d => d.day !== dateStr && d.steps != null).map(d => d.steps);
  const steps30DayAvg = stepsHistory.length > 0
    ? Math.round(stepsHistory.reduce((a, b) => a + b, 0) / stepsHistory.length)
    : null;
  const stepsPercentChange = steps != null && steps30DayAvg != null
    ? Math.round(((steps - steps30DayAvg) / steps30DayAvg) * 100)
    : null;

  return {
    reportDay,
    isFallback: reportDay !== today,
    readinessScore: r?.score ?? null,
    sleepScore: s?.score ?? null,
    todayHRV,
    hrv30DayAvg,
    hrvPercentChange,
    totalSleepMinutes,
    hrvStreakDays,
    nightsOfData: hrvByDay.length,
    steps,
    steps30DayAvg,
    stepsPercentChange,
  };
}

// ── CLI mode ─────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.OURA_API_KEY) {
    console.error("Error: OURA_API_KEY not set. Add it to .env or export it.");
    process.exit(1);
  }
  (async () => {
    const d = await getOuraData();
    const label = (t) => t.padEnd(28);
    const fmt = (v, u = "") => (v == null ? "—" : `${v}${u}`);
    console.log();
    console.log("  OURA DAILY SUMMARY —", d.isFallback ? `${d.reportDay} (latest available)` : d.reportDay);
    console.log("  " + "─".repeat(38));
    console.log(`  ${label("Readiness score")}${fmt(d.readinessScore)}`);
    console.log(`  ${label("HRV average (last night)")}${fmt(d.todayHRV, " ms")}`);
    console.log(`  ${label("Sleep score")}${fmt(d.sleepScore)}`);
    console.log(`  ${label("Total sleep")}${fmtDuration(d.totalSleepMinutes)}`);
    console.log(`  ${label("Steps")}${fmt(d.steps)}`);
    console.log();
    console.log("  " + "─".repeat(38));
    console.log(`  ${label("30-day HRV average")}${fmt(d.hrv30DayAvg, " ms")}  (${d.nightsOfData} nights of data)`);
    console.log(`  ${label("30-day steps average")}${fmt(d.steps30DayAvg)}`);
    if (d.hrvStreakDays >= 3) {
      console.log(`  ⚠️  ${d.hrvStreakDays}-day HRV decline streak`);
    }
    console.log();
  })().catch((err) => { console.error("Error:", err.message); process.exit(1); });
}
