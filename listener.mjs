#!/usr/bin/env node

/**
 * Memeticco — All 15 audit fixes applied.
 * Fix #1: per-project mutex, #3: input sandboxing, #4: watchdog cleanup,
 * #5: flush race, #6: session key, #7: negative thread cache,
 * #10: chunk long messages, #13: map cleanup, #14: graceful shutdown,
 * #15: post-sleep recovery
 */

import "dotenv/config";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import Anthropic from "@anthropic-ai/sdk";
import { createClaudeMemoryTool } from "@supermemory/tools/claude-memory";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";
import {
  loadAllProjects, resolveChannelIds, getProjectByChannel,
  getAllProjects, watchProjects, getUserRole, buildSystemPrompt, cleanRepo,
} from "./router.mjs";

const BOT_USER_ID = process.env.SLACK_BOT_USER_ID;
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN || !BOT_USER_ID || !process.env.ANTHROPIC_API_KEY) {
  console.error("Need: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID, ANTHROPIC_API_KEY");
  process.exit(1);
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const anthropic = new Anthropic();
const socket = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN, logLevel: "warn", clientPingTimeout: 30000, autoReconnectEnabled: true });

// Supermemory: stores context, message history, decisions, learnings
const HAS_SUPERMEMORY = !!process.env.SUPERMEMORY_API_KEY;
if (HAS_SUPERMEMORY) console.log("[memory] Supermemory connected");
else console.log("[memory] No SUPERMEMORY_API_KEY — using local logs only");

function getMemoryTool(projectId) {
  if (!HAS_SUPERMEMORY) return null;
  return createClaudeMemoryTool(process.env.SUPERMEMORY_API_KEY, {
    containerTags: [projectId],
  });
}

// Save to supermemory (non-blocking, fire-and-forget)
async function saveMemory(projectId, content, tags = []) {
  if (!HAS_SUPERMEMORY) return;
  try {
    const tool = getMemoryTool(projectId);
    // Use the tool's underlying API to store directly
    await fetch("https://api.supermemory.com/v1/memories", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SUPERMEMORY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        containerTags: [projectId, ...tags],
      }),
    });
  } catch (err) {
    console.error(`[memory] Save failed: ${err.message?.slice(0, 50)}`);
  }
}

loadAllProjects();

// --- Persistent activity log per project ---
// Tracks all interactions so Claude always has full context
const LOGS_DIR = path.resolve("logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

function appendLog(projectId, entry) {
  const logFile = path.join(LOGS_DIR, `${projectId}.md`);
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `\n[${timestamp}] ${entry}\n`;
  fs.appendFileSync(logFile, line);
}

function getRecentLog(projectId, maxChars = 4000) {
  const logFile = path.join(LOGS_DIR, `${projectId}.md`);
  try {
    const content = fs.readFileSync(logFile, "utf8");
    // Return last maxChars characters (most recent activity)
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch { return ""; }
}

// Archive threads older than 7 days into weekly md files
function archiveOldThreads(projectId) {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const toArchive = [];

  for (const [key, val] of activeThreads) {
    if (val.projectId === projectId && val.ts && now - val.ts > weekMs) {
      toArchive.push([key, val]);
    }
  }

  if (toArchive.length === 0) return;

  // Group by week
  const weeks = {};
  for (const [key, val] of toArchive) {
    const date = new Date(val.ts);
    const weekNum = `${date.getFullYear()}-W${String(Math.ceil((date.getDate() + new Date(date.getFullYear(), 0, 1).getDay()) / 7)).padStart(2, "0")}`;
    if (!weeks[weekNum]) weeks[weekNum] = [];
    weeks[weekNum].push({ key, ...val });
    activeThreads.delete(key);
  }

  // Write weekly archive files
  for (const [week, threads] of Object.entries(weeks)) {
    const archiveFile = path.join(LOGS_DIR, `${projectId}-threads-${week}.md`);
    const content = `# Thread Archive: ${projectId} — ${week}\n\n` +
      threads.map(t => `- ${t.key} (${new Date(t.ts).toISOString().slice(0, 10)})`).join("\n") + "\n";
    fs.appendFileSync(archiveFile, content);
  }

  saveActiveThreads();
  console.log(`[archive] ${projectId}: archived ${toArchive.length} threads`);
}

// --- Username cache (no TTL deletion, stored permanently) ---
const userNames = new Map();
async function userName(userId) {
  if (userNames.has(userId)) return userNames.get(userId);
  try {
    const res = await slack.users.info({ user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    userNames.set(userId, name);
    return name;
  } catch { return userId; }
}

// --- LLM-based routing (no hardcoded regex) ---
async function classifyIntent(userText) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: userText }],
      system: `You are a router. Reply with EXACTLY one word: "api" or "claude"

"api" = questions, reading code, analysis, audits, history, config viewing, greetings, status checks, SCREENSHOTS, previews, "show me", "what does X look like". The system has Puppeteer + local dev server for instant screenshots. No code change needed.

"claude" = code changes, git commits, deploying, approving previous plans ("yes", "do it", "go ahead"), merging, anything that needs to WRITE or EDIT files.

If the message asks for code changes AND screenshots, reply "claude" (screenshot happens automatically after push).
If the message ONLY asks for a screenshot/preview with no changes, reply "api".`,
    });
    const route = response.content[0]?.text?.trim().toLowerCase();
    if (route === "api" || route === "claude") return route;
    return "claude"; // fallback
  } catch {
    return "claude"; // fallback: Claude Code can do everything
  }
}

// --- LLM-generated status messages (no hardcoded text) ---
async function generateStatusMessage(userText, route) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      messages: [{ role: "user", content: `User request: "${userText}"\nRoute: ${route}` }],
      system: `Generate a brief casual Slack status message (1 line, max 15 words, italicized with underscores).
For "api" route: something quick like "_checking the code, one sec_" or "_pulling up that info_"
For "claude" route: something like "_this is a bigger task, will take a few mins_" or "_reading the codebase, hang tight_"
Be human and casual. Match the energy of the request. No emoji. Reply with ONLY the status text.`,
    });
    return response.content[0]?.text?.trim() || "_working on it..._";
  } catch {
    return route === "api" ? "_give me a sec_" : "_working on it, might take a few mins_";
  }
}

async function generateProgressUpdate(userText, minutesElapsed, lastActivity) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [{ role: "user", content: `Original request: "${userText}"\nRunning for: ${minutesElapsed} minutes\nLast activity: ${lastActivity || "processing"}` }],
      system: `Generate a brief progress update for Slack (1 line, max 12 words, italicized with underscores). Be casual and specific based on what's happening. No emoji. Reply with ONLY the update text.`,
    });
    return response.content[0]?.text?.trim() || "_still working..._";
  } catch {
    return "_still working on it..._";
  }
}

async function handleWithAPI(event, project) {
  const userText = (event.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();
  const threadTs = event.thread_ts || event.ts;
  const role = getUserRole(project, event.user);

  let contextParts = [];
  contextParts.push(`Project: ${project.github.owner}/${project.github.repo}. Channel: #${project.channel}.`);
  contextParts.push(`Production: ${project.urls?.production || "n/a"}. Staging: ${project.urls?.staging || "n/a"}.`);
  contextParts.push(`Roles: owners=${(project.roles?.users?.owners || []).join(",")}, editors=${(project.roles?.users?.editors || []).join(",")}`);

  // Tools for API path: read code files + read activity logs/archives
  const apiTools = [];
  if (project.localRepoPath) {
    apiTools.push({
      name: "read_file",
      description: "Read a file from the local project repo. Use for answering questions about code.",
      input_schema: { type: "object", properties: { path: { type: "string", description: "File path relative to repo root" } }, required: ["path"] },
    });
    apiTools.push({
      name: "list_files",
      description: "List files in a directory of the project repo.",
      input_schema: { type: "object", properties: { path: { type: "string", description: "Directory path" } }, required: ["path"] },
    });
  }
  // Screenshot tool (uses local dev server + Puppeteer)
  if (project.devPort && puppeteer) {
    apiTools.push({
      name: "take_screenshot",
      description: "Take a screenshot of a page from the local dev server. Use when user asks to 'show', 'screenshot', 'preview', or 'what does X look like'. Provide a page path like '/' or '/about' or '/writing'.",
      input_schema: { type: "object", properties: { page_path: { type: "string", description: "Page path like '/' or '/about' or '/writing'" } }, required: ["page_path"] },
    });
  }

  apiTools.push({
    name: "read_activity_log",
    description: "Read the project's activity log. Contains all user messages, bot responses, errors, and status updates. Use for questions like 'what changed today', 'what did Fathima do', 'recent activity'.",
    input_schema: { type: "object", properties: { max_chars: { type: "number", description: "How many chars to read from end of log (default 5000)" } } },
  });
  apiTools.push({
    name: "list_archives",
    description: "List all thread archive files for this project. Weekly archives of past conversations.",
    input_schema: { type: "object", properties: {} },
  });
  apiTools.push({
    name: "read_archive",
    description: "Read a specific thread archive file. Use for historical context ('what happened last week').",
    input_schema: { type: "object", properties: { filename: { type: "string", description: "Archive filename like portfolio-threads-2026-W14.md" } }, required: ["filename"] },
  });

  // Include recent activity log
  const recentLog = getRecentLog(project.id, 2000);

  const systemPrompt = `You are memeticco, an AI design engineer. Be concise. No em dashes. Slack mrkdwn format (*bold*, _italic_, \`code\`).
${contextParts.join(" ")}
User: ${event.user}, role: ${role}
${recentLog ? `\nRecent activity:\n${recentLog.slice(-1500)}` : ""}

You are in READ-ONLY mode. You can read files and answer questions but CANNOT make changes. If the user wants changes, tell them and they'll trigger the full editor.`;

  try {
    let messages = [{ role: "user", content: userText }];
    let iterations = 0;

    while (iterations < 6) {
      iterations++;
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: systemPrompt,
        messages,
        tools: apiTools.length > 0 ? apiTools : undefined,
      });

      const texts = response.content.filter(b => b.type === "text");
      const toolCalls = response.content.filter(b => b.type === "tool_use");

      if (response.stop_reason === "end_turn" || toolCalls.length === 0) {
        const reply = texts.map(b => b.text).join("\n");
        if (reply.trim()) await postToSlack(event.channel, threadTs, reply);
        return;
      }

      // Execute tool calls (local file reads only)
      const results = [];
      for (const tc of toolCalls) {
        if (tc.name === "take_screenshot") {
          const screenshotOk = await takeLocalScreenshot(project, tc.input.page_path || "/", event.channel, threadTs);
          results.push({ type: "tool_result", tool_use_id: tc.id, content: screenshotOk ? "Screenshot posted to Slack thread." : "Screenshot failed." });
        } else if (tc.name === "read_activity_log") {
          const maxChars = tc.input.max_chars || 5000;
          const content = getRecentLog(project.id, maxChars);
          results.push({ type: "tool_result", tool_use_id: tc.id, content: content || "No activity log yet." });
        } else if (tc.name === "list_archives") {
          try {
            const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith(project.id) && f.includes("threads"));
            results.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(files.length ? files : ["No archives yet"]) });
          } catch { results.push({ type: "tool_result", tool_use_id: tc.id, content: "No archives." }); }
        } else if (tc.name === "read_archive") {
          try {
            const content = fs.readFileSync(path.join(LOGS_DIR, tc.input.filename), "utf8");
            results.push({ type: "tool_result", tool_use_id: tc.id, content });
          } catch { results.push({ type: "tool_result", tool_use_id: tc.id, content: `Archive not found: ${tc.input.filename}` }); }
        } else if (tc.name === "read_file") {
          const filePath = path.join(project.localRepoPath, tc.input.path);
          try {
            const content = fs.readFileSync(filePath, "utf8");
            results.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify({ path: tc.input.path, content }) });
          } catch { results.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify({ error: `Not found: ${tc.input.path}` }) }); }
        } else if (tc.name === "list_files") {
          const dirPath = path.join(project.localRepoPath, tc.input.path || "");
          try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true }).filter(e => !e.name.startsWith(".")).map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
            results.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(entries) });
          } catch { results.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify({ error: `Not found: ${tc.input.path}` }) }); }
        }
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    await postToSlack(event.channel, threadTs, `Error: ${err.message.slice(0, 150)}`);
  }
}

// --- Fix #10: chunk long messages for Slack's 4000 char limit ---
async function postToSlack(channel, threadTs, text) {
  if (!text?.trim()) return;
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 3900) {
    // Find a good break point (newline near the limit)
    let breakAt = remaining.lastIndexOf("\n", 3900);
    if (breakAt < 2000) breakAt = 3900; // no good break, hard split
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await slack.chat.postMessage({ channel, thread_ts: threadTs, text: chunk, unfurl_media: true }).catch(err => {
      console.error(`[slack] postMessage failed: ${err.data?.error || err.message}`);
    });
  }
}

// --- Fix #1: per-PROJECT mutex (not per-thread) ---
const projectLocks = new Map(); // projectId → Promise chain
function withProjectLock(projectId, fn) {
  const prev = projectLocks.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn);
  projectLocks.set(projectId, next.catch(() => {}));
  return next;
}

// --- Claude Code spawner with session persistence ---
// Tracks which projects have had their first session (system prompt loaded)
const initializedProjects = new Set();

function spawnClaudeCode(instruction, project, { channel, threadTs }) {
  return new Promise((resolve, reject) => {
    const cwd = project.localRepoPath || path.resolve(".");
    const promptPath = path.join(project.dir, "system-prompt.md");
    const isFirstRun = !initializedProjects.has(project.id);

    // Clean repo before session (remove stale locks, uncommitted changes)
    cleanRepo(cwd);

    const args = ["-p", "--dangerously-skip-permissions"];

    if (isFirstRun) {
      // First message: load system prompt (one-time cost)
      if (fs.existsSync(promptPath)) args.push("--system-prompt-file", promptPath);
      console.log(`[${project.id}] Claude Code: first session (loading system prompt)`);
    } else {
      // Subsequent messages: --continue reuses previous context
      args.push("--continue");
      console.log(`[${project.id}] Claude Code: continuing session (warm)`);
    }

    args.push(instruction);
    initializedProjects.add(project.id);

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let buffer = "";
    let flushTimer = null;
    let settled = false;
    let flushing = false;
    let lastOutputTime = Date.now();
    let lastStderrLine = "";
    let statusMsgTs = null; // single status message that gets updated in place
    const startTime = Date.now();

    // Heartbeat: every 60s, generate a fresh progress update via Haiku
    // Updates the SAME message (chat.update) instead of posting new ones
    const heartbeat = setInterval(async () => {
      if (settled) return;
      const mins = Math.round((Date.now() - startTime) / 60000);
      if (mins < 1) return; // don't update in the first minute
      const update = await generateProgressUpdate(instruction.slice(0, 100), mins, lastStderrLine);
      if (statusMsgTs) {
        // Update existing status message in place
        try { await slack.chat.update({ channel, ts: statusMsgTs, text: update }); } catch {}
      } else {
        // Post first status
        try { const r = await slack.chat.postMessage({ channel, thread_ts: threadTs, text: update }); statusMsgTs = r.ts; } catch {}
      }
    }, 60000);

    async function flush() {
      if (flushing || !buffer.trim()) return;
      flushing = true;
      const text = buffer.trim();
      buffer = "";
      flushing = false;
      // Fix #11 (output filter): skip raw JSON tool output
      if (/^\s*[\[{]/.test(text) && text.includes('"type"')) return;
      await postToSlack(channel, threadTs, text);
    }

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;
      lastOutputTime = Date.now();
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => flush(), 2000);
    });

    child.stderr.on("data", (data) => {
      lastOutputTime = Date.now();
      const line = data.toString().trim();
      if (line && !line.includes("token") && !line.includes("cache") && !line.includes("warn") && !line.includes("DEBUG")) {
        lastStderrLine = line.slice(0, 80); // track for progress updates
        console.log(`  [${project.id}] ${line.slice(0, 120)}`);
      }
    });

    child.on("close", async (code) => {
      clearTimeout(flushTimer);
      clearInterval(heartbeat);
      // Delete the progress status message
      if (statusMsgTs) try { await slack.chat.delete({ channel, ts: statusMsgTs }); } catch {}
      if (settled) return;
      settled = true;
      await flush();
      if (code === 0) resolve(stdout);
      else reject(new Error(`Claude Code exited with code ${code}`));
    });

    child.on("error", (err) => {
      clearInterval(heartbeat);
      if (statusMsgTs) slack.chat.delete({ channel, ts: statusMsgTs }).catch(() => {});
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function handleWithClaudeCode(event, project) {
  const threadTs = event.thread_ts || event.ts;
  const channel = event.channel;
  const userText = (event.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();
  const role = getUserRole(project, event.user);
  const name = await userName(event.user);

  // Fix #18: empty message guard
  if (!userText) {
    await postToSlack(channel, threadTs, "What do you need?");
    return;
  }

  // Build thread context
  let threadContext = "";
  let sharedFiles = [];
  if (event.thread_ts) {
    try {
      const replies = await slack.conversations.replies({ channel, ts: event.thread_ts, limit: 30 });
      const msgs = (replies.messages || []).slice(-15);
      threadContext = msgs.map(m => {
        const who = (m.user === BOT_USER_ID || m.bot_id) ? "bot" : "user";
        let text = (m.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();
        if (m.files?.length) {
          for (const f of m.files) { sharedFiles.push({ name: f.name, type: f.mimetype, url: f.url_private }); text += ` [file: ${f.name}]`; }
        }
        return `${who}: ${text}`;
      }).join("\n");
    } catch {}
  }
  if (event.files?.length) {
    for (const f of event.files) sharedFiles.push({ name: f.name, type: f.mimetype, url: f.url_private });
  }

  const guardrails = project.guardrails || {};
  const gText = [
    guardrails.canModify?.length ? `Can modify: ${guardrails.canModify.join(", ")}` : "",
    guardrails.cannotModify?.length ? `Protected: ${guardrails.cannotModify.join(", ")}` : "",
    guardrails.copyRules?.length ? `Copy rules: ${guardrails.copyRules.join(". ")}` : "",
    guardrails.designGuidelines?.length ? `Design: ${guardrails.designGuidelines.join(". ")}` : "",
  ].filter(Boolean).join("\n");

  const isFirstRun = !initializedProjects.has(project.id);

  // First run: full context. Subsequent: lean instruction (Claude already has context)
  let instruction;

  const stagingUrl = project.urls?.staging || "not set";
  const productionUrl = project.urls?.production || "not set";

  const workflowRules = `
WORKFLOW (follow this exactly):

Step 1 — PLAN:
Read the relevant files. Then output a short plan:
*Plan:*
• File: \`path/to/file.tsx\`
• What changes: [specific before → after]
• Why: [one line reason]

Reply yes to proceed.

Step 2 — BUILD CHECK (before pushing):
• After editing files, run: npm run build
• If build fails: read the error, fix it, run build again
• Repeat until build passes
• Only proceed to push after a clean build
• Output: "Build passed." or "Build failed: [error]. Fixing..."

Step 3 — PUSH:
• git add the changed files
• git commit -m "[slack] description | by @${name}"
• git push origin ${project.github.branch}

Step 4 — SHARE RESULT:
Output:
*Done.* [one line summary]
\`commit-hash\` · Build passed. Screenshot incoming...

The system takes a screenshot automatically after you push (localhost dev server + Puppeteer). Do NOT take screenshots yourself. Do NOT use any browser/screenshot tool. The screenshot will appear in the thread within seconds.

SLACK FORMATTING (strict):
• Bold: *bold* (single asterisks). NEVER use **double**.
• Italic: _italic_ (underscores). NEVER use *single for italic*.
• Code: \`inline code\` or triple backticks for blocks
• Links: <${stagingUrl}|staging> NOT [staging](url)
• No headers (#). No markdown lists with dashes at root level — use bullet • instead.
• No em dashes. No oxford commas.
• Keep messages short. 2-4 lines max per message.

CRITICAL:
• NEVER use Rube SLACK tools. Your stdout IS the Slack message.
• NEVER use Rube Browser Tool or any screenshot/browser tool. Screenshots are handled by the system.
• NEVER ask the user to authorize Rube or open any URL.
• You are in the local repo. Read and edit files from disk.
• Read CODEBASE.md first if it exists.
• ${role !== "owner" ? "This user CANNOT merge. Staging only." : "This user CAN merge to main."}
• When done, STOP. Do not keep reading files or working.`;

  if (isFirstRun) {
    const recentLog = getRecentLog(project.id, 3000);
    instruction = `${name} (${role}) asks:

<user_message>
${userText}
</user_message>

PROJECT: ${project.github.owner}/${project.github.repo}
STAGING URL: ${stagingUrl}
PRODUCTION: ${productionUrl}
BRANCH: ${project.github.branch}
${gText ? `\nGUARDRAILS:\n${gText}` : ""}
${recentLog ? `\nRECENT ACTIVITY:\n${recentLog}` : ""}
${threadContext ? `\nTHREAD:\n${threadContext}` : ""}
${sharedFiles.length ? `\nFILES SHARED:\n${sharedFiles.map(f => `- ${f.name} (${f.type}): ${f.url}`).join("\n")}` : ""}
${workflowRules}`;
  } else {
    instruction = `${name} (${role}) says:
${threadContext ? `\nThread:\n${threadContext}\n` : ""}
${sharedFiles.length ? `Files shared: ${sharedFiles.map(f => f.name).join(", ")}\n` : ""}
<user_message>
${userText}
</user_message>

Staging: ${stagingUrl}
Branch: ${project.github.branch}
${workflowRules}`;
  }

  // NOTE: no withProjectLock here — the caller (enqueue) already holds the lock
  try {
    const output = await spawnClaudeCode(instruction, project, { channel, threadTs });

    // Log the response
    if (output?.trim()) {
      appendLog(project.id, `BOT: ${output.trim().slice(0, 500)}`);
    }

    // Check for new commits, screenshot the right page, poll staging
    if (project.localRepoPath) {
      // Bug 6: use existing spawnSync import (no dynamic import)
      const lastCommit = spawnSync("git", ["log", "-1", "--format=%h %s"], { cwd: project.localRepoPath, encoding: "utf8" });
      const commitLine = lastCommit.stdout?.trim();
      const hasNewCommit = commitLine && commitLine.includes("[slack]");

      if (hasNewCommit) {
        // Get changed files BEFORE screenshot (Bug 3)
        const filesChanged = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: project.localRepoPath, encoding: "utf8" });
        const files = filesChanged.stdout?.trim().split("\n").filter(Boolean);

        // Log commit
        appendLog(project.id, `COMMIT: ${commitLine}`);
        if (files.length) appendLog(project.id, `FILES: ${files.join(", ")}`);
        appendLog(project.id, `STAGING: ${project.urls?.staging || "not set"}`);

        // Bug 3: screenshot the page that was actually changed
        const pagePath = inferPagePath(files);

        // Bug 2: wait for hot reload instead of blind timer
        if (project.devPort) {
          console.log(`[screenshot] ${project.id}: waiting for recompile...`);
          await waitForRecompile(project, 15000);
          await takeLocalScreenshot(project, pagePath, channel, threadTs);
        }

        // Poll staging in background
        pollStagingDeploy(project, channel, threadTs);
      }

      // Bug 9C: if no commit but output mentions screenshot, take one anyway
      if (!hasNewCommit && output && /screenshot|preview|show/i.test(output) && project.devPort) {
        await takeLocalScreenshot(project, "/", channel, threadTs);
      }
    }
  } catch (err) {
    console.error(`[${project.id}] Claude Code error:`, err.message);
    appendLog(project.id, `ERROR: ${err.message.slice(0, 200)}`);
    await postToSlack(channel, threadTs, `Error: ${err.message.slice(0, 200)}`);
  }

  // Archive old threads periodically
  archiveOldThreads(project.id);
}

// --- Thread tracking (all threads stored, old ones archived to md) ---
const THREADS_FILE = path.resolve("state/active-threads.json");
const activeThreads = new Map();

function loadActiveThreads() {
  try {
    const data = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") activeThreads.set(k, { projectId: v, ts: Date.now() });
      else activeThreads.set(k, v);
    }
    console.log(`[threads] Loaded ${activeThreads.size}`);
  } catch {}
}
function saveActiveThreads() {
  try {
    fs.mkdirSync("state", { recursive: true });
    fs.writeFileSync(THREADS_FILE, JSON.stringify(Object.fromEntries(activeThreads), null, 2));
  } catch (err) {
    console.error(`[threads] Save failed: ${err.message}`);
  }
}
function trackThread(channelThreadKey, projectId) {
  activeThreads.set(channelThreadKey, { projectId, ts: Date.now() });
  saveActiveThreads();
}
loadActiveThreads();

// Fix #7: negative cache for threads where bot is NOT present
const notBotThreads = new Set(); // threads we've confirmed the bot isn't in

// --- Event handling ---
const runningSessions = new Set();

async function addReaction(ch, ts, name) {
  try { await slack.reactions.add({ channel: ch, timestamp: ts, name }); }
  catch (err) {
    // Fix #19: detect auth errors
    if (err.data?.error === "token_revoked" || err.data?.error === "invalid_auth") {
      console.error("[FATAL] Bot token invalid. Exiting.");
      process.exit(1);
    }
  }
}

// Status messages are now generated by LLM (generateStatusMessage)

async function handleEvent(event) {
  const threadTs = event.thread_ts || event.ts;
  // Fix #6: key on thread, not message
  const sessionKey = `${event.channel}:${threadTs}`;
  if (runningSessions.has(sessionKey)) return;
  runningSessions.add(sessionKey);

  const project = getProjectByChannel(event.channel);
  if (!project) { runningSessions.delete(sessionKey); return; }

  let ok = false;
  let statusTs = null;
  const userText = (event.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();
  const threadKey = `${event.channel}:${threadTs}`;
  const name = await userName(event.user);

  trackThread(threadKey, project.id);

  try {
    await addReaction(event.channel, event.ts, "eyes");

    // Remove queued indicator if present
    try { await slack.reactions.remove({ channel: event.channel, timestamp: event.ts, name: "hourglass_flowing_sand" }); } catch {}

    appendLog(project.id, `USER (${name}): ${userText}`);

    // LLM decides routing (no hardcoded patterns)
    const route = await classifyIntent(userText);
    console.log(`[${project.id}] ${name} [${route}]: "${userText.slice(0, 80)}"`);

    // LLM generates contextual status message
    const statusText = await generateStatusMessage(userText, route);
    try { const r = await slack.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: statusText }); statusTs = r.ts; } catch {}

    if (route === "api") {
      await handleWithAPI(event, project);
      appendLog(project.id, `BOT: [API reply sent]`);
    } else {
      await handleWithClaudeCode(event, project);
    }

    ok = true;
  } catch (err) {
    console.error(`[${project.id}] Error:`, err.message);
    try { await postToSlack(event.channel, threadTs, `Error: ${err.message.slice(0, 200)}`); } catch {}
  } finally {
    if (statusTs) try { await slack.chat.delete({ channel: event.channel, ts: statusTs }); } catch {}
    await addReaction(event.channel, event.ts, ok ? "white_check_mark" : "warning");
    runningSessions.delete(sessionKey);
  }
}

// --- Queue (per-project, not per-thread) ---
async function enqueue(event) {
  const project = getProjectByChannel(event.channel);
  if (!project) return;
  const userText = (event.text || "").replace(`<@${BOT_USER_ID}>`, "").trim();

  // Classify intent to decide if lock is needed
  const route = await classifyIntent(userText);
  if (route === "api") {
    // API queries don't need project lock (read-only), handle immediately
    handleEvent(event);
    return;
  }

  // If another task is running for this project, tell the user they're in queue
  if (runningSessions.size > 0) {
    const threadTs = event.thread_ts || event.ts;
    await addReaction(event.channel, event.ts, "hourglass_flowing_sand");
    // Log the queued message
    const name = await userName(event.user);
    appendLog(project.id, `QUEUED: ${name}: "${userText.slice(0, 100)}" (waiting for active task)`);
  }

  // Complex queries: queued per project (prevents concurrent repo access)
  withProjectLock(project.id, () => handleEvent(event));
}

// --- Socket events ---
socket.on("app_mention", async ({ event, ack }) => {
  await ack();
  const project = getProjectByChannel(event.channel);
  if (!project) return;
  const name = await userName(event.user);
  console.log(`[${project.id}] @mention from ${name}`);
  trackThread(`${event.channel}:${event.thread_ts || event.ts}`, project.id);
  await enqueue(event);
});

socket.on("message", async ({ event, ack }) => {
  await ack();
  if (!event.thread_ts || event.bot_id || event.user === BOT_USER_ID) return;
  const key = `${event.channel}:${event.thread_ts}`;
  const hasMention = (event.text || "").includes(`<@${BOT_USER_ID}>`);

  if (hasMention) {
    const project = getProjectByChannel(event.channel);
    if (!project) return;
    trackThread(key, project.id);
    await enqueue(event);
    return;
  }

  if (activeThreads.has(key)) {
    await enqueue(event);
    return;
  }

  // Fix #7: negative cache — skip threads we already know aren't ours
  if (notBotThreads.has(key)) return;

  // Fallback: check Slack (Fix #10: only once per thread, then cache result)
  try {
    const replies = await slack.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 10 });
    if ((replies.messages || []).some(m => m.bot_id || m.user === BOT_USER_ID)) {
      const project = getProjectByChannel(event.channel);
      if (project) { trackThread(key, project.id); await enqueue(event); }
    } else {
      notBotThreads.add(key); // Fix #7: negative cache
    }
  } catch {}
});

// --- Health ---
let lastEventTime = Date.now();
socket.on("disconnected", () => console.log(`[${new Date().toISOString()}] Disconnected`));
socket.on("reconnecting", () => console.log(`[${new Date().toISOString()}] Reconnecting...`));
socket.on("slack_event", () => { lastEventTime = Date.now(); });

let startupDone = false;
let onlineMessages = [];
socket.on("connected", async () => {
  lastEventTime = Date.now();
  console.log(`[${new Date().toISOString()}] Socket connected`);
  if (!startupDone) {
    startupDone = true;
    // Sessions are already warmed at this point (warmUpSessions ran before socket.start)
    for (const p of getAllProjects()) {
      if (!p.channelId) continue;
      const ownerIds = p.roles?.users?.owners || [];
      const ownerMentions = ownerIds.map(id => `<@${id}>`).join(" or ");

      try {
        const r = await slack.chat.postMessage({
          channel: p.channelId,
          text: `:large_green_circle: *Ask Claude is online and ready*

_How to use:_
• \`@Ask Claude\` + your request in natural language
• Ask questions: "what does the navbar look like?"
• Request changes: "make the hero text bigger"
• Review: "check if the homepage is accessible"
• Approve: reply "yes" or "do it" in thread
• Deploy: "ship it" (owner only)
• History: "what changed today?" or "what did Fathima do?"

Replies in threads auto-continue. No commands to memorize.`,
        });
        onlineMessages.push({ channel: p.channelId, ts: r.ts, ownerMentions });
      } catch {}
    }
  }

  // Fix #15: post-sleep recovery — check for missed mentions
  try {
    for (const p of getAllProjects()) {
      if (!p.channelId) continue;
      const history = await slack.conversations.history({ channel: p.channelId, limit: 10 });
      for (const msg of (history.messages || [])) {
        if (!msg.text?.includes(`<@${BOT_USER_ID}>`)) continue;
        // Skip if older than 5 minutes (don't replay old history)
        const msgAge = Date.now() / 1000 - parseFloat(msg.ts);
        if (msgAge > 300) continue;
        // Skip if already has reactions (already processed)
        if (msg.reactions?.some(r => r.name === "eyes" || r.name === "white_check_mark")) continue;
        console.log(`[${p.id}] Recovering missed mention from ${msg.user}`);
        await enqueue({ ...msg, channel: p.channelId });
      }
    }
  } catch {}
});

setInterval(async () => {
  const mins = (Date.now() - lastEventTime) / 60000;
  if (mins > 10 && runningSessions.size === 0) {
    console.log(`[${new Date().toISOString()}] Idle ${Math.round(mins)}min — reconnecting`);
    lastEventTime = Date.now();
    try { await socket.disconnect(); await socket.start(); } catch {}
  }
}, 60000);

// Periodic: cap negative cache (only thing that needs size limits)
setInterval(() => {
  if (notBotThreads.size > 1000) notBotThreads.clear();
}, 10 * 60 * 1000);

// --- Warm-up: pre-load Claude Code sessions per project ---
// --- Dev servers: one per project, different ports ---
const BASE_PORT = 9100;
let puppeteer = null;
try {
  puppeteer = (await import("puppeteer")).default;
  console.log("[screenshot] Puppeteer loaded");
} catch {
  console.log("[screenshot] Puppeteer not found — no local screenshots");
}

async function startDevServer(project, portIndex) {
  if (!project.localRepoPath) return;
  const port = BASE_PORT + portIndex + 1; // 9101, 9102, ...
  const cwd = project.localRepoPath;

  // Check if package.json has a dev script
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (!pkg.scripts?.dev) { console.log(`[dev] ${project.id}: no dev script, skipping`); return; }
  } catch { return; }

  // Install deps if needed
  if (!fs.existsSync(path.join(cwd, "node_modules"))) {
    console.log(`[dev] ${project.id}: installing dependencies...`);
    spawnSync("npm", ["install"], { cwd, stdio: "pipe" });
  }

  console.log(`[dev] ${project.id}: starting on port ${port}...`);
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" },
    detached: true,
  });

  child.stdout.on("data", () => {}); // drain
  child.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line.includes("Ready") || line.includes("ready") || line.includes("started")) {
      console.log(`[dev] ${project.id}: ready on http://localhost:${port}`);
    }
  });

  child.on("error", (err) => console.error(`[dev] ${project.id}: ${err.message}`));
  child.on("close", (code) => {
    if (!shuttingDown) console.log(`[dev] ${project.id}: dev server exited (code ${code})`);
  });

  project.devPort = port;
  project.devProcess = child;

  // Wait for server to be ready (max 30s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}`, (res) => { resolve(res.statusCode); });
        req.on("error", reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      console.log(`[dev] ${project.id}: confirmed running on port ${port}`);
      // Open in browser
      try { spawnSync("open", [`http://localhost:${port}`]); } catch {}
      return;
    } catch {}
  }
  // Bug 8: don't set devPort if server didn't respond
  project.devPort = null;
  console.log(`[dev] ${project.id}: server failed to start — screenshots disabled for this project`);
}

async function startAllDevServers() {
  const projects = getAllProjects();
  console.log(`[dev] Starting ${projects.length} dev server(s)...`);
  await Promise.all(projects.map((p, i) => startDevServer(p, i)));
}

function killAllDevServers() {
  for (const p of getAllProjects()) {
    if (p.devProcess && !p.devProcess.killed) {
      try { process.kill(-p.devProcess.pid, "SIGTERM"); } catch {}
      try { p.devProcess.kill("SIGTERM"); } catch {}
    }
  }
}

// --- Screenshot from localhost via Puppeteer ---
// Bug 3: infer which page to screenshot from changed files
function inferPagePath(files) {
  for (const f of files) {
    // app/pricing/page.tsx → /pricing
    const appMatch = f.match(/^app\/(.+)\/page\.(tsx?|jsx?)$/);
    if (appMatch) return "/" + appMatch[1];
    // app/page.tsx → /
    if (f.match(/^app\/page\.(tsx?|jsx?)$/)) return "/";
    // pages/about.tsx → /about
    const pagesMatch = f.match(/^pages\/(.+)\.(tsx?|jsx?)$/);
    if (pagesMatch) return "/" + pagesMatch[1].replace(/\/index$/, "");
    // components that are clearly page-level
    if (f.includes("404") || f.includes("not-found")) return "/not-found-test";
  }
  return "/";
}

// Bug 2: wait for dev server to recompile instead of blind timer
async function waitForRecompile(project, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await fetch(`http://localhost:${project.devPort}/`, { method: "HEAD" });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

async function takeLocalScreenshot(project, pagePath, channel, threadTs) {
  if (!puppeteer || !project.devPort) {
    console.log(`[screenshot] ${project.id}: skipped (puppeteer=${!!puppeteer}, port=${project.devPort})`);
    return null;
  }
  const url = `http://localhost:${project.devPort}${pagePath || "/"}`;
  console.log(`[screenshot] ${project.id}: capturing ${url}...`);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();

    // Bug 5: detect client-side errors
    const jsErrors = [];
    page.on("console", msg => { if (msg.type() === "error") jsErrors.push(msg.text()); });
    page.on("pageerror", err => jsErrors.push(err.message));

    await page.setViewport({ width: 1440, height: 900 });

    // Bug 1: use domcontentloaded (networkidle2 hangs on Next.js HMR websocket)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000)); // wait for hydration + fonts

    // Dismiss modals
    try { await page.evaluate(() => { document.querySelectorAll('[role="dialog"],.modal,.popup,.overlay').forEach(el => el.style.display = "none"); }); } catch {}

    const rawBuf = await page.screenshot({ fullPage: true });
    const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
    await browser.close();

    // Write to temp file, upload via filesUploadV2
    const tmpFile = `/tmp/memeticco-${Date.now()}.png`;
    fs.writeFileSync(tmpFile, buf);
    console.log(`[screenshot] ${project.id}: uploading ${buf.length} bytes...`);

    try {
      await slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: tmpFile,
        filename: `screenshot-${(pagePath || "home").replace(/\//g, "-")}.png`,
        title: `Preview: ${pagePath || "/"}`,
      });
      console.log(`[screenshot] ${project.id}: uploaded`);
    } catch (uploadErr) {
      console.error(`[screenshot] Upload failed: ${uploadErr.data?.error || uploadErr.message}`);
      if (uploadErr.data?.error === "missing_scope") {
        await postToSlack(channel, threadTs, `_Screenshot captured but bot needs \`files:write\` scope. Add it at api.slack.com/apps → OAuth & Permissions → Bot Token Scopes → files:write → Reinstall._`);
      } else {
        await postToSlack(channel, threadTs, `_Screenshot captured but upload failed: ${uploadErr.data?.error || "unknown error"}_`);
      }
      return null;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    // Bug 5: warn if JS errors detected
    if (jsErrors.length) {
      await postToSlack(channel, threadTs, `_Warning: page had ${jsErrors.length} JS error(s): ${jsErrors[0]?.slice(0, 150)}_`);
    }

    return true;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[screenshot] ${project.id}: ${err.message}`);
    await postToSlack(channel, threadTs, `_Screenshot failed: ${err.message?.slice(0, 100)}_`);
    return null;
  }
}

// --- Vercel deploy polling ---
async function pollStagingDeploy(project, channel, threadTs) {
  const stagingUrl = project.urls?.staging;
  if (!stagingUrl) return;

  console.log(`[deploy] ${project.id}: polling ${stagingUrl}...`);

  for (let i = 0; i < 20; i++) { // max 5 minutes (20 * 15s)
    await new Promise(r => setTimeout(r, 15000));
    try {
      const res = await fetch(stagingUrl, { method: "HEAD", redirect: "follow" });
      if (res.ok) {
        await postToSlack(channel, threadTs, `_Staging is live:_ <${stagingUrl}|preview>`);
        console.log(`[deploy] ${project.id}: staging live`);
        return;
      }
    } catch {}
  }
  console.log(`[deploy] ${project.id}: staging poll timed out`);
}

let shuttingDown = false;

async function warmUpSession(p) {
  if (!p.localRepoPath) return;
  const cwd = p.localRepoPath;
  const promptPath = path.join(p.dir, "system-prompt.md");

  try {
    const args = ["-p", "--dangerously-skip-permissions"];
    if (fs.existsSync(promptPath)) args.push("--system-prompt-file", promptPath);
    args.push(`You are initialized for project ${p.github.owner}/${p.github.repo}. Read CODEBASE.md if it exists. Reply with "ready" only.`);

    console.log(`[warmup] ${p.id}: loading...`);
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd, env: { ...process.env, FORCE_COLOR: "0" } });

    await new Promise((resolve) => {
      let done = false;
      const timeout = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(); } }, 120000);
      child.on("close", () => { if (!done) { done = true; clearTimeout(timeout); resolve(); } });
      child.on("error", () => { if (!done) { done = true; clearTimeout(timeout); resolve(); } });
    });

    initializedProjects.add(p.id);
    console.log(`[warmup] ${p.id}: ready`);
    appendLog(p.id, `SERVER: Session warmed up.`);
  } catch (err) {
    console.error(`[warmup] ${p.id}: failed — ${err.message?.slice(0, 50)}`);
  }
}

async function warmUpSessions() {
  const projects = getAllProjects();
  console.log(`[warmup] Warming ${projects.length} project(s) in parallel...`);
  // All projects warm up at the same time
  await Promise.all(projects.map(p => warmUpSession(p)));
  console.log(`[warmup] All sessions ready`);
}

// --- Start ---
await resolveChannelIds(slack);
watchProjects(slack);

// Start dev servers + warm up Claude sessions in parallel
await Promise.all([
  startAllDevServers(),
  warmUpSessions(),
]);

// Now connect socket and go live
await socket.start();

const projects = getAllProjects();
console.log(`
╔════════════════════════════════════════════════════════╗
║              MEMETICCO — Production Mode                ║
╠════════════════════════════════════════════════════════╣
║                                                        ║
║  Simple: Haiku API (1-2s) | Complex: Claude Code       ║
║  Projects: ${String(projects.length).padEnd(45)}║
${projects.map(p => `║    #${p.channel.padEnd(20)} → ${(p.github.owner + "/" + p.github.repo).slice(0, 25).padEnd(25)}  ║`).join("\n")}
║                                                        ║
║  Sessions: pre-warmed | Per-project mutex               ║
║  Bot: @Ask Claude (${BOT_USER_ID.padEnd(36)})║
║                                                        ║
╚════════════════════════════════════════════════════════╝
`);

// --- Shutdown: post offline, kill dev servers, log, exit ---
function shutdown(sig) {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] ${sig} — shutting down`);

  killAllDevServers();
  for (const p of getAllProjects()) {
    try { appendLog(p.id, `SERVER: Killed (${runningSessions.size} sessions aborted).`); } catch {}
  }

  // Post offline message to each channel
  const activeProjects = getAllProjects().filter(p => p.channelId);
  console.log(`[shutdown] Posting offline to ${activeProjects.length} channel(s)...`);
  const posts = activeProjects.map(p => {
      const ownerMentions = (p.roles?.users?.owners || []).map(id => `<@${id}>`).join(" or ");
      return slack.chat.postMessage({
        channel: p.channelId,
        text: `:red_circle: *Ask Claude is offline*\n\nNeed the bot? Ask ${ownerMentions || "the project owner"} to start the server.`,
      }).catch(err => console.error(`[shutdown] Failed to post offline: ${err.message?.slice(0, 50)}`));
    });

  Promise.all(posts)
    .finally(() => {
      try { socket.disconnect(); } catch {}
      console.log("[shutdown] Done");
      process.exit(0);
    });

  setTimeout(() => { console.log("[shutdown] Forced exit"); process.exit(0); }, 5000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
