import fs from "fs";
import path from "path";

const STATE_PATH = path.resolve("state/usage.json");

// Pricing per million tokens (USD)
const PRICING = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.0 },
};

let state = { date: today(), daily: 0, users: {} };

function today() {
  return new Date().toISOString().split("T")[0];
}

function load() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    state = JSON.parse(raw);
    if (state.date !== today()) {
      state = { date: today(), daily: 0, users: {} };
      save();
    }
  } catch {
    state = { date: today(), daily: 0, users: {} };
  }
}

function save() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function trackUsage(userId, inputTokens, outputTokens, model) {
  const pricing = PRICING[model] || PRICING["claude-sonnet-4-6"];
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  state.daily += cost;
  state.users[userId] = (state.users[userId] || 0) + cost;
  save();

  const dailyBudget = parseFloat(process.env.DAILY_BUDGET || "50");
  const perUserBudget = parseFloat(process.env.PER_USER_BUDGET || "10");

  console.log(
    `[cost] ${inputTokens}in/${outputTokens}out (${model}) = $${cost.toFixed(4)} | day: $${state.daily.toFixed(2)}/${dailyBudget} | user ${userId}: $${state.users[userId].toFixed(2)}/${perUserBudget}`
  );

  return { cost, dailyTotal: state.daily, userTotal: state.users[userId] };
}

export function checkBudget(userId) {
  if (state.date !== today()) {
    state = { date: today(), daily: 0, users: {} };
    save();
  }
  const dailyBudget = parseFloat(process.env.DAILY_BUDGET || "50");
  const perUserBudget = parseFloat(process.env.PER_USER_BUDGET || "10");

  if (state.daily >= dailyBudget) return { exceeded: true, reason: "daily" };
  if ((state.users[userId] || 0) >= perUserBudget)
    return { exceeded: true, reason: "user" };
  return { exceeded: false };
}

export function getUsageSummary() {
  return { ...state };
}

// Initialize on import
load();
