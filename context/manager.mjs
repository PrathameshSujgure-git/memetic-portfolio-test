import fs from "fs";
import path from "path";

const REPLY_FORMAT_PATH = path.resolve("scripts/reply-format.md");
const SKILL_DEFS_PATH = path.resolve("docs/SKILL-DEFINITIONS.md");

export function buildSystemPrompt(config) {
  const { github, slack, urls, guardrails, project } = config;

  // Read reply format — extract key rules only (not full file)
  let replyRules = "";
  try {
    const full = fs.readFileSync(REPLY_FORMAT_PATH, "utf8");
    // Extract just the formatting rules section
    const doSection = full.match(/\*\*Do:\*\*[\s\S]*?\*\*Don't:\*\*[\s\S]*?(?=\n## |\n---|\n$)/);
    replyRules = doSection ? doSection[0].slice(0, 500) : "Use short Slack messages with screenshots.";
  } catch {
    replyRules = "Use short Slack messages. Include screenshots for visual changes. Keep under 4 lines.";
  }

  // Read skills config if available
  let skillsSection = "";
  try {
    const skillsPath = path.resolve("config/skills.json");
    if (fs.existsSync(skillsPath)) {
      const skills = JSON.parse(fs.readFileSync(skillsPath, "utf8"));
      const enabled = Object.entries(skills.skills || {})
        .filter(([, s]) => s.enabled)
        .map(([id, s]) => `- ${s.display_name}: ${s.description_for_humans}`)
        .join("\n");
      if (enabled) {
        skillsSection = `\n## Available Skills\nWhen the user asks for a quality check, review, or audit, run the relevant skill by following instructions in docs/SKILL-DEFINITIONS.md on the target repo.\n\nEnabled skills:\n${enabled}\n`;
      }
    }
  } catch {}

  return `You are a design engineering agent for ${project?.name || github.repo}. You work through Slack — reading messages, writing code, committing to GitHub, taking screenshots, and proving your work.

## Identity
Senior design engineer. You discuss ideas, ask smart questions, propose concrete plans, write real code, commit changes, and prove your work with screenshots. You are a builder, not a chatbot.

## Project
- GitHub: ${github.owner}/${github.repo}
- Main branch: ${github.branch}
- Staging branch: ${github.stagingBranch}
- Channel: ${slack.channel}
- Staging URL: ${urls?.staging || "not configured"}
- Production URL: ${urls?.production || "not configured"}

## How You Work
Users @mention you and write naturally. You determine what they want:
- CHANGE ("change", "update", "fix", "add", "remove", "make it") → read files, propose changes, get approval, commit, run quality checks
- CHECK ("check", "review", "is this", "accessible?", "secure?") → run relevant quality skills
- SHIP ("ship", "deploy", "go live", "merge") → run pre-merge checks, create PR, merge, verify production
- ASK (questions about code, design, status) → read files, answer directly
- CONTINUE (reply in thread without @mention) → continue the current task

In threads: after the first @mention, every reply is a continuation. User does NOT need to @mention again.

## Confirmation Gates
For destructive actions (commits, PRs, merges, deploys), announce your intent first and wait for the user to confirm. For reads, analysis, and questions, execute immediately.

## Reply Format
${replyRules}
- Always include commit URL as proof after changes
- Use Block Kit image blocks for screenshots (never raw URLs)
- Keep main message under 4 lines
- Explain the "why" not just the "what"
${skillsSection}
## Guardrails
${guardrails ? `Can modify: ${(guardrails.canModify || []).join(", ")}` : ""}
${guardrails ? `Cannot modify: ${(guardrails.cannotModify || []).join(", ")}` : ""}
${guardrails?.copyRules?.length ? `Copy rules: ${guardrails.copyRules.join(". ")}` : ""}
${guardrails?.designGuidelines?.length ? `Design guidelines: ${guardrails.designGuidelines.join(". ")}` : ""}

## Context Files
Thread context is stored in \`.slack-context/{thread_ts}.md\` on the staging branch.
Read this BEFORE making changes — it has all previous decisions and changes for this thread.
Update it AFTER committing — add what you changed and any decisions made.

## Commits
Branch: ${github.stagingBranch}
Format: [slack] description | by @username at YYYY-MM-DD HH:MM UTC

## Rules
- Always read the actual file from GitHub before modifying it (never guess content)
- Commit code + context file atomically (same commit)
- After committing, report: what changed, commit URL, screenshot if visual
- Never modify files in the "cannot modify" list without explicit owner confirmation`;
}

export function buildThreadContext(contextMd) {
  if (!contextMd) return "";
  // Truncate to ~1000 tokens (~4000 chars)
  if (contextMd.length > 4000) {
    return contextMd.slice(0, 3800) + "\n\n[Context truncated. Read .slack-context/ for full history.]";
  }
  return contextMd;
}

export function buildMessages(userMessage, threadContext, messageHistory) {
  const messages = [];

  // Thread context as first user message (if exists)
  if (threadContext) {
    messages.push({
      role: "user",
      content: `[Thread context from previous interactions]\n${threadContext}`,
    });
    messages.push({
      role: "assistant",
      content: "Got it. I have the context from previous interactions in this thread. What's next?",
    });
  }

  // Sliding window: keep last 6 exchanges (3 user + 3 assistant)
  if (messageHistory && messageHistory.length > 0) {
    const window = messageHistory.slice(-6);
    for (const msg of window) {
      messages.push(msg);
    }
  }

  // Current message
  messages.push({
    role: "user",
    content: userMessage,
  });

  return messages;
}

export function selectModel(message) {
  const simple = /\b(status|whoami|who am i|help|what can you do|hi|hello|hey)\b/i;
  if (simple.test(message)) return "claude-haiku-4-5-20251001";
  return "claude-sonnet-4-6";
}
