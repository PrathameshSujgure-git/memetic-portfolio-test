import { WebClient } from "@slack/web-api";

let slack;

export function initSlack() {
  slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  return slack;
}

export function getSlack() {
  return slack;
}

// Tool definitions for Claude
export const slackTools = [
  {
    name: "send_message",
    description:
      "Send a message to a Slack channel or thread. Use blocks for rich formatting (images, sections). Always include text as fallback.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        text: { type: "string", description: "Plain text fallback" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to reply in (omit for channel-level message)",
        },
        blocks: {
          type: "string",
          description: "Slack Block Kit JSON string for rich formatting",
        },
      },
      required: ["channel", "text"],
    },
    requires_confirmation: false,
    timeout_ms: 10000,
  },
  {
    name: "add_reaction",
    description: "Add an emoji reaction to a Slack message",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        timestamp: { type: "string", description: "Message timestamp" },
        emoji: {
          type: "string",
          description: "Emoji name without colons (e.g. 'eyes', 'white_check_mark')",
        },
      },
      required: ["channel", "timestamp", "emoji"],
    },
    requires_confirmation: false,
    timeout_ms: 5000,
  },
  {
    name: "read_thread",
    description:
      "Read messages from a Slack thread. Returns a compressed summary of the conversation.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        thread_ts: { type: "string", description: "Thread timestamp" },
        limit: {
          type: "number",
          description: "Max messages to fetch (default 20)",
        },
      },
      required: ["channel", "thread_ts"],
    },
    requires_confirmation: false,
    timeout_ms: 10000,
  },
];

// Tool executors
export async function executeTool(name, input) {
  switch (name) {
    case "send_message": {
      const args = { channel: input.channel, text: input.text };
      if (input.thread_ts) args.thread_ts = input.thread_ts;
      if (input.blocks) {
        try {
          args.blocks = JSON.parse(input.blocks);
        } catch {
          args.blocks = undefined;
        }
      }
      args.unfurl_media = true;
      const result = await slack.chat.postMessage(args);
      return JSON.stringify({ ok: result.ok, ts: result.ts });
    }

    case "add_reaction": {
      await slack.reactions.add({
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.emoji,
      });
      return JSON.stringify({ ok: true });
    }

    case "read_thread": {
      const result = await slack.conversations.replies({
        channel: input.channel,
        ts: input.thread_ts,
        limit: input.limit || 20,
      });
      const messages = (result.messages || []).map((m) => ({
        user: m.user || m.bot_id || "unknown",
        text: (m.text || "").slice(0, 500),
        ts: m.ts,
      }));
      return JSON.stringify(messages);
    }

    default:
      return JSON.stringify({ error: `Unknown slack tool: ${name}` });
  }
}
