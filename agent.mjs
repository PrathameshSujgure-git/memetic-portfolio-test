// Demo: agent-changes branch test push
#!/usr/bin/env node

import "dotenv/config";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { initSlack, getSlack } from "./tools/slack.mjs";
import { initGitHub } from "./tools/github.mjs";
import { initBrowser } from "./tools/browser.mjs";
import { buildRegistry, getToolDefinitions, executeTool, requiresConfirmation } from "./tools/registry.mjs";
import { buildSystemPrompt, buildMessages, buildThreadContext, selectModel } from "./context/manager.mjs";
import { trackUsage, checkBudget, getUsageSummary } from "./cost.mjs";
import { trackThread, isActiveThread, getThread, audit, addPendingAction } from "./state.mjs";

// --- Config ---
const configPath = path.resolve("config/project.json");
if (!fs.existsSync(configPath)) {
  console.error("Run npm run setup first — config/project.json not found");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID;

if (!process.env.ANTHROPIC_API_KEY || !process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN || !BOT_USER_ID) {
  console.error("Missing required env vars. Copy .env.example to .env and fill in values.");
  process.exit(1);
}

// --- Init clients ---
const anthropic = new Anthropic();
const slack = initSlack();
initGitHub(config);
await initBrowser();
buildRegistry();

const systemPrompt = buildSystemPrompt(config);
const tools = getToolDefinitions();

console.log(`[agent] System prompt: ${systemPrompt.length} chars`);
console.log(`[agent] Tools: ${tools.length}`);
console.log(`[agent] Project: ${config.github.owner}/${config.github.repo}`);
console.log(`[agent] Channel: ${config.slack.channel}`);

// --- Message history per thread (in-memory sliding window) ---
const threadHistory = new Map(); // thread_ts → [{role, content}]

// --- Resolve channel ID ---
let channelId;
async function resolveChannel() {
  const result = await slack.conversations.list({ types: "public_channel,private_channel", limit: 200 });
  const ch = (result.channels || []).find((c) => c.name === config.slack.channel);
  if (!ch) {
    console.error(`[agent] Channel #${config.slack.channel} not found`);
    process.exit(1);
  }
  channelId = ch.id;
  console.log(`[agent] Channel #${config.slack.channel} → ${channelId}`);
}

// --- Agentic loop ---
const MAX_ITERATIONS = 20;

async function handleMessage(event) {
  const userId = event.user;
  const messageText = (event.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();
  const threadTs = event.thread_ts || event.ts;
  const channel = event.channel || channelId;

  // Budget check
  const budget = checkBudget(userId);
  if (budget.exceeded) {
    await slack.chat.postMessage({
      channel, thread_ts: threadTs,
      text: budget.reason === "daily"
        ? "Daily budget reached. I'll resume tomorrow."
        : "Your personal budget for today is reached. Try again tomorrow.",
    });
    return;
  }

  // Acknowledge
  try {
    await slack.reactions.add({ channel, timestamp: event.ts, name: "eyes" });
  } catch {}

  // Track thread
  trackThread(threadTs, channel, userId);

  // Build context
  let threadContext = "";
  try {
    // Try to read .slack-context/ from GitHub
    const { executeTool: ghExec } = await import("./tools/github.mjs");
    const ctxResult = await ghExec("read_file", { path: `.slack-context/${threadTs}.md` });
    const parsed = JSON.parse(ctxResult);
    if (parsed.content && !parsed.error) {
      threadContext = buildThreadContext(parsed.content);
    }
  } catch {}

  // Get or create message history for this thread
  if (!threadHistory.has(threadTs)) threadHistory.set(threadTs, []);
  const history = threadHistory.get(threadTs);

  // Select model
  const model = selectModel(messageText);

  // Build messages
  const messages = buildMessages(messageText, threadContext, history);

  console.log(`[agent] ${userId}: "${messageText.slice(0, 80)}" → ${model} (${messages.length} msgs)`);
  audit("message", userId, { text: messageText.slice(0, 200), model, threadTs });

  // Agentic tool loop
  let currentMessages = [...messages];
  let iterations = 0;
  let finalText = "";

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let response;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools,
      });
    } catch (err) {
      console.error(`[agent] API error:`, err.message);
      await slack.chat.postMessage({
        channel, thread_ts: threadTs,
        text: `Something went wrong: ${err.message.slice(0, 200)}`,
      });
      break;
    }

    // Track usage
    if (response.usage) {
      trackUsage(userId, response.usage.input_tokens, response.usage.output_tokens, model);
    }

    // Extract text blocks
    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");

    // If Claude is done (no tool calls), post final response
    if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join("\n");
      if (finalText.trim()) {
        await slack.chat.postMessage({
          channel, thread_ts: threadTs,
          text: finalText,
        });
      }
      break;
    }

    // Execute tool calls
    const toolResults = [];
    for (const toolCall of toolBlocks) {
      console.log(`[agent] Tool: ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`);

      // Check confirmation gate
      if (requiresConfirmation(toolCall.name)) {
        // Post intent and break the loop — resume on confirmation
        const intentText = textBlocks.map((b) => b.text).join("\n") || `I want to run ${toolCall.name}. React with :white_check_mark: to proceed.`;
        const intentMsg = await slack.chat.postMessage({
          channel, thread_ts: threadTs,
          text: intentText + "\n\nReact :white_check_mark: to proceed.",
        });

        // Store pending action for when user confirms
        addPendingAction(intentMsg.ts, {
          threadTs,
          channel,
          userId,
          toolCall,
          model,
          messages: currentMessages,
          assistantContent: response.content,
        });

        audit("confirmation_requested", userId, { tool: toolCall.name, threadTs });
        console.log(`[agent] Waiting for confirmation on ${toolCall.name}`);
        return; // Exit — will resume when reaction event fires
      }

      // Execute tool
      const result = await executeTool(toolCall.name, toolCall.input);
      audit("tool_executed", userId, { tool: toolCall.name, threadTs });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });
    }

    // Feed results back to Claude
    currentMessages.push({ role: "assistant", content: response.content });
    currentMessages.push({ role: "user", content: toolResults });
  }

  if (iterations >= MAX_ITERATIONS) {
    await slack.chat.postMessage({
      channel, thread_ts: threadTs,
      text: "This task needs too many steps for one go. Break it into smaller requests.",
    });
  }

  // Update message history (sliding window — keep last 6)
  history.push({ role: "user", content: messageText });
  if (finalText) history.push({ role: "assistant", content: finalText });
  while (history.length > 6) history.shift();
}

// --- Handle confirmation (reaction_added event) ---
async function handleConfirmation(event) {
  if (event.reaction !== "white_check_mark") return;

  const { getPendingAction, removePendingAction } = await import("./state.mjs");
  const pending = getPendingAction(event.item.ts);
  if (!pending) return;

  console.log(`[agent] Confirmation received for ${pending.toolCall.name}`);
  removePendingAction(event.item.ts);
  audit("confirmation_received", pending.userId, { tool: pending.toolCall.name });

  // Resume execution
  const result = await executeTool(pending.toolCall.name, pending.toolCall.input);
  audit("tool_executed", pending.userId, { tool: pending.toolCall.name });

  // Continue the agentic loop with the tool result
  const messages = [
    ...pending.messages,
    { role: "assistant", content: pending.assistantContent },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: pending.toolCall.id,
        content: result,
      }],
    },
  ];

  // Re-enter the loop
  let iterations = 0;
  let currentMessages = messages;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: pending.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
      tools,
    });

    if (response.usage) {
      trackUsage(pending.userId, response.usage.input_tokens, response.usage.output_tokens, pending.model);
    }

    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");

    if (response.stop_reason === "end_turn" || toolBlocks.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join("\n");
      if (finalText.trim()) {
        await slack.chat.postMessage({
          channel: pending.channel,
          thread_ts: pending.threadTs,
          text: finalText,
        });
      }
      break;
    }

    const toolResults = [];
    for (const toolCall of toolBlocks) {
      if (requiresConfirmation(toolCall.name)) {
        const intentText = textBlocks.map((b) => b.text).join("\n") || `I want to run ${toolCall.name}.`;
        const intentMsg = await getSlack().chat.postMessage({
          channel: pending.channel,
          thread_ts: pending.threadTs,
          text: intentText + "\n\nReact :white_check_mark: to proceed.",
        });
        addPendingAction(intentMsg.ts, {
          ...pending,
          toolCall,
          messages: currentMessages,
          assistantContent: response.content,
        });
        return;
      }

      const r = await executeTool(toolCall.name, toolCall.input);
      toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: r });
    }

    currentMessages.push({ role: "assistant", content: response.content });
    currentMessages.push({ role: "user", content: toolResults });
  }
}

// --- Socket Mode connection ---
const socketClient = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN });

socketClient.on("app_mention", async ({ event, ack }) => {
  await ack();
  try {
    await handleMessage(event);
  } catch (err) {
    console.error("[agent] Error handling mention:", err);
    try {
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: `Error: ${err.message.slice(0, 200)}`,
      });
    } catch {}
  }
});

socketClient.on("message", async ({ event, ack }) => {
  await ack();
  // Only handle thread replies in active threads (not from the bot itself)
  if (!event.thread_ts) return;
  if (event.bot_id || event.user === BOT_USER_ID) return;
  if (!isActiveThread(event.thread_ts)) return;

  try {
    await handleMessage(event);
  } catch (err) {
    console.error("[agent] Error handling thread reply:", err);
  }
});

socketClient.on("reaction_added", async ({ event, ack }) => {
  await ack();
  try {
    await handleConfirmation(event);
  } catch (err) {
    console.error("[agent] Error handling confirmation:", err);
  }
});

// --- Start ---
await resolveChannel();
await socketClient.start();

console.log(`
╔══════════════════════════════════════════════╗
║         THE MEMETIC AGENT — Running          ║
╠══════════════════════════════════════════════╣
║                                              ║
║  Listening on: #${config.slack.channel.padEnd(31)}║
║  Project: ${(config.github.owner + "/" + config.github.repo).padEnd(36)}║
║  Model: claude-sonnet-4-6 (+ haiku)         ║
║                                              ║
║  @mention the bot in Slack to start.         ║
║                                              ║
╚══════════════════════════════════════════════╝
`);
