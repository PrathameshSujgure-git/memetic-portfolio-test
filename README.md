# Memeticco — The Memetic Agent

An AI design engineer that lives in Slack. @mention it, talk naturally, and it writes real code, commits to GitHub, takes screenshots, runs quality checks, and proves its work. No terminal needed. No commands to memorize.

Plug it into any project. It runs independently — talks to GitHub via API, never touches local files.

---

## For AI Agents / LLMs

If you are an LLM or AI agent tasked with setting up, operating, or extending this system — this section is your complete reference.

### What This System Is

A Socket Mode listener that watches for @mentions in real-time. When someone @mentions the bot, it spawns a Claude Code session that handles the request and exits. Zero idle cost.

1. User @mentions the bot in Slack and writes naturally
2. Listener spawns a Claude Code session with Rube MCP access
3. Claude reads/writes code via GitHub, takes screenshots via Browser Tool
4. Claude outputs its response to stdout
5. Listener posts the response to Slack as the bot
6. Session exits — tokens stop flowing

No polling. No ! commands for users. The bot understands natural language and figures out the intent (change code, check quality, ship, answer questions). Skills are structured prompts the agent follows — some upgrade with real CLI tools when available.

### Architecture

```
the-memetic-agent/              ← THIS REPO (you run from here)
├── listener.mjs                ← Socket Mode listener, spawns Claude per @mention
├── scripts/setup.mjs           ← interactive setup, generates all config
├── scripts/reply-format.md     ← how to format every Slack message
├── scripts/generate-context.md ← prompt for scanning a repo to generate CODEBASE.md
├── config/skills.json.template ← 26 skills, 7 packs, skill router, tool detection
├── config/pipeline.json.template
├── config/roles.json.template
├── docs/SKILL-DEFINITIONS.md   ← execution instructions for all 26 skills
├── docs/SKILLS-GUIDE.md        ← dual-audience skill documentation
├── dashboard/index.html        ← web dashboard for monitoring
│
│   ↓ npm run setup             ← generates project-specific config
│   ↓ npm run start             ← starts Socket Mode listener
│   ↓ on @mention → spawn claude ← Claude Code session with Rube MCP
│   ↓ uses Rube MCP tools       ← GitHub read/write, Browser screenshots
│
target-project-repo/            ← THE PROJECT (on GitHub, not local)
├── CODEBASE.md                 ← architecture overview (agent reads on startup)
├── CODEBASE-DEEP.md            ← code patterns (agent reads on startup)
├── config/roles.json           ← who can do what (checked on EVERY command)
├── config/pipeline.json        ← quality gates (prompt + skill steps)
├── config/skills.json          ← enabled skills, triggers, NL map, tool detection
├── docs/SKILL-DEFINITIONS.md   ← how to execute each skill
├── scripts/reply-format.md     ← reply format guide
├── .slack-context/             ← per-thread context files (agent reads/writes)
├── .slack-context/_skills/     ← skill run results (JSON per run)
└── .slack-context/_learnings.md ← institutional memory (Learn skill writes)
```

### Setup (step by step)

1. Clone: `git clone https://github.com/PrathameshSujgure-git/the-memetic-agent.git && cd the-memetic-agent`
2. Run: `node scripts/setup.mjs` — answers: GitHub URL, Slack channel, URLs, stack, roles, skill packs, pipeline
3. Setup generates: `config/project.json`, `config/roles.json`, `config/pipeline.json`, `config/skills.json`, `scripts/agent-system-generated.md`
4. Copy to target repo and commit:
   - `config/roles.json`, `config/pipeline.json`, `config/skills.json`
   - `docs/SKILL-DEFINITIONS.md`, `scripts/reply-format.md`
5. If existing project: run `npm run generate-context` to auto-generate `CODEBASE.md` + `CODEBASE-DEEP.md`
6. Run: `npm run start` (launches agent + dashboard)

### Event Flow (listener.mjs)

```
listener.mjs (Socket Mode, always running, zero idle cost)
│
├─ @mention arrives (real-time via WebSocket)
│  ├─ Add 👀 reaction (acknowledgment)
│  ├─ Track as active thread
│  └─ Spawn: claude -p --system-prompt-file agent-system.md "handle this message..."
│     │
│     └─ Claude Code session (has Rube MCP):
│        ├─ Reads thread context (.slack-context/) from GitHub
│        ├─ Determines intent: change / check / ship / ask
│        ├─ Executes via Rube (GitHub read/write, Browser screenshots)
│        ├─ Outputs response to stdout
│        └─ Exits
│  ├─ Listener posts Claude's output to Slack as the bot
│  └─ Done — zero tokens until next @mention
│
├─ Thread reply (no @mention needed, active thread)
│  └─ Same flow as above
│
└─ Idle → zero cost
```

### Conversation Flow (natural language, no commands)

```
User: @memeticco make the hero heading bigger
  ↓
Claude: reads files from GitHub, proposes change, outputs to stdout
Listener: posts proposal in thread as bot
  ↓
User: yes do it (reply in thread, no @mention needed)
  ↓
Claude: reads files, commits to staging branch, runs quality pipeline, outputs result
Listener: posts commit URL + skill findings as bot
  ↓
User: ship it
  ↓
Claude: creates PR, merges to main, outputs confirmation
Listener: posts to thread + channel as bot
```

### How Users Talk to the Bot

No commands to memorize. Users @mention and talk naturally. The bot detects intent from the message:

| User says | Intent | What the bot does | Min Role |
|-----------|--------|-------------------|----------|
| "@bot change the headline to X" | CHANGE | Read files, propose, commit on approval | editor |
| "@bot make the hero bigger" | CHANGE | Same — natural language triggers intent | editor |
| "@bot is this accessible?" | CHECK | Run matching skill (design-audit) | editor |
| "@bot check security" | CHECK | Run security-scan skill | editor |
| "@bot review the code" | CHECK | Run code-review skill | editor |
| "@bot what does the navbar look like?" | ASK | Read files, answer directly | viewer |
| "@bot what's the status?" | ASK | Dashboard summary | viewer |
| "@bot ship it" / "@bot deploy" | SHIP | Pre-merge checks, PR, merge, canary | owner |
| "yes do it" (thread reply) | CONFIRM | Execute the proposed change | editor |
| "make it bolder" (thread reply) | CONTINUE | Iterate on current task | editor |
| "skip that" (thread reply) | SKIP | Dismiss skill findings, continue | contributor |

Thread replies don't need @mention — after the first @mention, the bot keeps listening in that thread automatically.

### Skills System (26 skills, 7 packs)

Skills are deep analysis capabilities the agent executes. They are NOT installed software — they are structured instruction sets in `docs/SKILL-DEFINITIONS.md` that the agent follows. Some skills upgrade with real CLI tools when available.

#### How skills get selected (Skill Router)

After every commit, the agent reads the diff and context, then auto-picks skills:

| What happened | Skills that run | Why |
|--------------|----------------|-----|
| CSS/layout files changed | Design Audit | Visual changes need visual review |
| .ts/.tsx logic changed | Code Review | Correctness check |
| Auth/password/token in diff | Security Scan (escalated) | Security-sensitive code |
| package.json/lock files changed | Security Scan | New dependencies = new attack surface |
| 3+ iterations on same files | Design Audit | Quality drift check |
| 10+ files or 200+ lines | Code Review + QA | Big changes need deeper review |
| User reports bug ("broken", "error") | Root Cause | Investigate before fixing |
| Pure content edit (.json, .md) | Nothing | Safe, just ship |
| User says "ship it" / "deploy" | QA + Security | Gate before production |
| After successful merge | Canary Monitor + Release Notes | Verify production health |
| Thread wrapping up | Learn | Extract institutional memory |

No hard limits — the agent uses judgment. A typo fix needs nothing. A big refactor before merge might need five skills.

#### All 26 Skills

**Quality Pack** (ON by default)
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Design Audit | auto on visual changes | 80-point checklist: typography, spacing, colors, accessibility, responsiveness. With `axe`: real WCAG data |
| Code Review | auto on code changes | Staff-engineer review: N+1 queries, race conditions, trust boundaries. With `eslint`+`tsc`: real lint + type errors |
| QA Check | suggested before merge | 4 modes: quick/full/diff-aware/regression. Visits pages, checks console errors. With `playwright`: runs real test suites |
| Root Cause | auto on bug reports | Iron rule: no fix without root cause. Reproduce → narrow → explain why → then fix. 3-strike escalation |

**Security Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Security Scan | auto on auth/API code | OWASP Top 10 + STRIDE threat model. With `npm audit`+`semgrep`: real CVE lookup + SAST rules |
| Safety Guard | auto pre-commit | Blocks commits to protected files (migrations, auth, payments, .env). Asks confirmation |

**Shipping Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Ship Check | suggested before merge | PR readiness: test coverage, review gate, PR description, changelog |
| Land & Deploy | manual | Full deploy flow: PR → CI wait → merge → deploy wait → canary → announce |
| Canary Monitor | auto post-deploy | Visits production routes, checks HTTP status, console errors, visual regressions |
| Release Notes | suggested post-deploy | Auto-generates changelog from thread context + commits |
| Performance Check | manual | Load time, bundle sizes, CWV estimates. With `lighthouse`: real scores (0-100) |
| Setup Deploy | manual | One-time: detects Vercel/Netlify/Railway, configures deploy timing |

**Planning Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Product Review | manual | YC partner session: 6 forcing questions, challenges assumptions |
| CEO Review | manual | Brian Chesky mode: find the 10-star experience, challenge scope |
| Eng Review | suggested | Architecture assessment, risk matrix, test strategy, readiness dashboard |
| Design Pre-Review | suggested | 7-pass review before code: user flow, hierarchy, accessibility, edge cases, AI slop detection |
| Design Direction | manual | Strategic consultation: landscape research, creative risks, generates DESIGN.md |
| Full Review | manual | CEO + Design + Eng in one pass, synthesized recommendation |

**Creative Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Design Variants | manual | 3 approaches: Safe, Bold, Experimental. User picks, agent builds |
| Design to Code | manual | Production code from design description/screenshot. Uses project's stack + components |

**Meta Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Weekly Retro | manual | Per-person breakdown, shipping streak, quality metrics, patterns, suggestions |
| Learn | auto after commits | Extracts codebase/preference/project learnings. Compounds across sessions |
| Second Opinion | manual | 3 modes: Review (fresh eyes), Challenge (try to break it), Consult (genuine pros/cons) |

**Browser Pack**
| Skill | Trigger | What it does |
|-------|---------|-------------|
| Browse | manual | Persistent headless browser: navigate, click, fill, inspect, screenshot |
| Browser Cookies | manual | Import cookies for authenticated page testing |
| Connect Browser | manual | Headed Chrome for CAPTCHAs and complex OAuth flows |

#### Hybrid Execution (Tools + Prompts)

On startup, the agent checks which CLI tools are available. Skills upgrade when tools exist, fall back to prompt-only when they don't.

| Tool | Install | What it upgrades |
|------|---------|-----------------|
| `eslint` | `npm i -D eslint` | Code Review → real lint errors + autofix |
| `tsc` | `npm i -D typescript` | Code Review + QA → real type checking |
| `lighthouse` | `npm i -g lighthouse` | Performance → real CWV scores (LCP, CLS, TBT) |
| `npm audit` | built-in | Security → real CVE database lookup |
| `semgrep` | `pip install semgrep` | Security → SAST pattern rules |
| `playwright` | `npm i -D @playwright/test` | QA + Browse → real browser test execution |
| `axe` | `npm i -D @axe-core/cli` | Design Audit → real WCAG compliance data |

The agent posts a one-time summary on startup: which tools are detected, which skills are upgraded.

### Config Formats

#### roles.json
```json
{
  "permissions": {
    "owner": ["!full-access", "!copy", "!and", "!merge", "!review", "!pipeline", "!role", "!check", "!skip", "!skills", "!status", "!whoami"],
    "editor": ["!full-access", "!copy", "!and", "!review", "!check", "!skip", "!status", "!whoami"],
    "contributor": ["!copy", "!and", "!skip", "!status", "!whoami"],
    "viewer": ["!review", "!status", "!whoami"]
  },
  "users": {
    "owners": ["U_SLACK_ID"],
    "editors": [],
    "contributors": [],
    "viewers": []
  }
}
```

#### pipeline.json
Two types of steps:
```json
{
  "steps": [
    {
      "name": "design-check",
      "prompt": "Review the visual change against CODEBASE.md guidelines.",
      "required": true,
      "autofix": false
    },
    {
      "name": "code-review",
      "skill": "code-review",
      "required": true,
      "autofix": true,
      "run_when": "code-change"
    }
  ]
}
```
- `prompt` steps: LLM analyzes with the given prompt
- `skill` steps: agent follows `docs/SKILL-DEFINITIONS.md`. Only runs when `run_when` matches the change type
- Dedup: skill steps supersede overlapping prompt steps (e.g., `code-review` skill supersedes `code-hygiene` prompt)
- `run_when` values: `always`, `visual-change`, `code-change`, `pre-merge`, `post-deploy`

#### Context files (.slack-context/)
```markdown
# Thread Context
Thread: 1775153594.541889
User: @username
Started: 2026-04-01 12:00 UTC

## Changes Made
1. `components/Gallery.tsx` — changed grid gap from 2px to 8px

## Decisions
- Using 8px grid for all spacing (user confirmed)

## Current State
- Gallery gap is 8px

## Files Modified
- components/Gallery.tsx
```

#### Skill results (.slack-context/_skills/)
```json
{
  "skill": "design-audit",
  "display_name": "Design Audit",
  "ran_at": "2026-04-04T12:00:00Z",
  "trigger": "auto",
  "findings": { "critical": 0, "warning": 2, "passed": 78, "total": 80 },
  "duration_ms": 28500
}
```

### Commit Format
```
[slack] description | by @username at YYYY-MM-DD HH:MM UTC
```

### Screenshot Format (Block Kit)
```json
[
  {"type": "section", "text": {"type": "mrkdwn", "text": "After — /about"}},
  {"type": "image", "image_url": "https://...", "alt_text": "After screenshot", "title": {"type": "plain_text", "text": "After — /about"}}
]
```
Always use `blocks` param (JSON string) with `text` fallback and `unfurl_media: true`.

### Reply Format
Every Slack message follows `scripts/reply-format.md`. Key templates:
- **After change:** title + 1-line summary + files + commit URL + before/after screenshots + next steps
- **Skill results:** unified pipeline output with severity grouping, tool mode indicator (prompt-only or tool-enhanced)
- **Asking questions:** numbered list with why each matters
- **Sharing plan:** file paths + old → new + visual outcome
- **After merge:** production URL + screenshot + channel announcement

### Rube MCP Tools Used
- **Slack:** SLACK_FETCH_CONVERSATION_HISTORY, SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION, SLACK_SEND_MESSAGE, SLACK_ADD_REACTION_TO_AN_ITEM, SLACK_FIND_CHANNELS
- **GitHub:** GITHUB_GET_REPOSITORY_CONTENT, GITHUB_COMMIT_MULTIPLE_FILES, GITHUB_CREATE_A_PULL_REQUEST, GITHUB_MERGE_A_PULL_REQUEST, GITHUB_GET_A_REFERENCE
- **Browser:** BROWSER_TOOL_CREATE_TASK, BROWSER_TOOL_WATCH_TASK
- **Bash:** only `sleep 10` and `date +%s`

---

## For Humans

### Quick Start (from scratch)

```bash
# 1. Clone
git clone https://github.com/PrathameshSujgure-git/the-memetic-agent.git
cd the-memetic-agent

# 2. Install
npm install

# 3. Create .env with your Slack bot tokens
cat > .env << 'EOF'
SLACK_BOT_TOKEN=xoxb-YOUR_BOT_TOKEN
SLACK_APP_TOKEN=xapp-YOUR_APP_TOKEN
SLACK_BOT_USER_ID=U_YOUR_BOT_USER_ID
EOF

# 4. Run setup (interactive — asks about your project, Slack, roles, skills)
npm run setup

# 5. Start the listener
npm run start

# 6. Go to Slack and @mention your bot
```

### Where to get the Slack tokens

You need an existing Slack bot (or create one at https://api.slack.com/apps).

**Token 1: `SLACK_BOT_TOKEN` (xoxb-...)**
- https://api.slack.com/apps → click your bot → **OAuth & Permissions** → copy **Bot User OAuth Token**

**Token 2: `SLACK_APP_TOKEN` (xapp-...)**
- Same app → **Basic Information** → scroll to **App-Level Tokens**
- If empty: click **Generate Token and Scopes** → name: `socket` → add scope: `connections:write` → Generate

**Token 3: `SLACK_BOT_USER_ID` (U...)**
- Open Slack → find your bot → click profile → **...** menu → **Copy member ID**

**Required bot scopes** (OAuth & Permissions → Bot Token Scopes):
`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:write`, `reactions:read`, `reactions:write`, `groups:history`

**Required event subscriptions** (Event Subscriptions → Subscribe to bot events):
`app_mention`, `message.channels`, `reaction_added`

**Socket Mode** must be enabled (Socket Mode → toggle ON).

**Invite the bot** to your channel: `/invite @your-bot-name`

### What setup asks

```
Existing or new project? → 1 (existing)
GitHub repo URL → https://github.com/your-org/your-repo
Default branch → main
Staging branch → agent-changes
Slack channel → your-channel-name
Production URL → https://yourdomain.com
Staging URL → https://your-staging-url.vercel.app
Tech stack → Next.js, React, Tailwind (or whatever you use)
Description → One-line project description
Modifiable files → content/*,components/*,app/*,styles/*
Protected files → package.json,.env*,vercel.json
Owner Slack user ID → U07LE640TNH
Editor Slack user IDs → (optional)
Skill packs → Quality [Y], Security [y/N], Shipping [y/N], etc.
```

### Requirements
- [Claude Code](https://claude.ai/code) installed with Rube MCP configured
- A Slack workspace with a bot and a channel for the agent
- A GitHub repo (public or connected via Rube)

### How it works

```
You in Slack                    Your machine
━━━━━━━━━━━━━━━━━━━━           ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
@bot make hero bigger    →     listener.mjs receives event (Socket Mode)
                                │ spawns Claude Code session
                                │ Claude reads code from GitHub (Rube)
                                │ proposes change in Slack thread
you: "yes do it"         →     │ commits code, runs quality skills
                                │ waits for staging deploy
                                │ posts screenshot + commit URL
                                │ session exits (zero idle cost)
you: "ship it"           →     │ new session: merges to production
                                │ posts to channel: "shipped!"
                                └ done
```

**Zero cost when idle.** Tokens only flow when someone @mentions the bot. Each request spawns a short-lived Claude Code session with full Rube MCP access (Slack, GitHub, Browser), then exits.

### Test Scenarios

After `npm run start`, run these in Slack to validate everything works:

**Test 1: Is it alive?**
```
@your-bot what project are you connected to?
```
Expected: bot replies with project name, URLs, branch info. Confirms Socket Mode + Rube Slack + system prompt all work.

**Test 2: Read code**
```
@your-bot what does the homepage look like? read the actual code
```
Expected: bot reads files from GitHub via Rube, shows code snippets, describes the page. Confirms Rube GitHub tools work.

Then reply in the same thread (no @mention needed):
```
make the heading text bigger on desktop
```
Expected: bot proposes a change with specific file + line, asks for confirmation. Confirms thread continuation + confirmation gates work.

**Test 3: Quality check**
```
@your-bot check the homepage design - is the typography consistent?
```
Expected: bot reads files, analyzes design, posts structured findings (pass/fail checklist). Confirms skill router + Design Audit skill work.

**What to watch for:**

| Signal | Meaning |
|--------|---------|
| 👀 reaction on your message | listener.mjs received the event |
| Terminal shows `@mention from...` | Event parsed correctly |
| Terminal shows `[claude] ...` | Claude Code session spawned |
| Reply appears in Slack thread | Full round-trip works |
| Terminal shows `Session complete` | Session exited cleanly |
| Thread reply without @mention works | Active thread tracking works |

### Talking to the bot

No commands to memorize. Just talk naturally:

| What you say | What the bot does |
|-------------|-------------------|
| `@bot change the headline to "Hello"` | Reads code, proposes change, waits for approval, commits |
| `@bot is this accessible?` | Runs design audit focused on accessibility |
| `@bot check security` | Runs OWASP + STRIDE security scan |
| `@bot what does the navbar look like?` | Reads code, describes it |
| `@bot ship it` | Creates PR, merges to main, monitors production |
| `yes do it` (in thread) | Confirms and executes the proposed change |
| `make it bolder` (in thread) | Continues the conversation, iterates |

### Optional (for better skill accuracy)
```bash
npm i -D eslint typescript @playwright/test @axe-core/cli
npm i -g lighthouse
pip install semgrep
```
The agent detects these on startup and upgrades skills automatically.

### Skills (26 skills, 7 packs)

Skills run automatically based on what you change — you don't need to think about them.

| What you change | What the agent checks | Why |
|----------------|----------------------|-----|
| CSS, colors, layout | Design Audit (80 points) | Visual changes need visual review |
| Functions, API code | Code Review | Logic needs correctness check |
| Auth, tokens, passwords | Security Scan (auto-escalated) | Sensitive code gets extra scrutiny |
| Dependencies | Security Scan | New packages = new attack surface |
| Same files 3+ times | Design Audit | Iteration drift check |
| Pure content (JSON, markdown) | Nothing | Safe, just ship it |
| "ship it" / "deploy" | QA + Security | Gate before production |
| After deploy | Canary Monitor | Verify production works |

Enable more during setup or by editing `config/skills.json`:

| Pack | What you get |
|------|-------------|
| **Quality** (on by default) | Design Audit, Code Review, QA, Root Cause Investigation |
| **Security** | OWASP scans, protected file guardrails |
| **Shipping** | Ship readiness, deploy monitoring, release notes, performance |
| **Planning** | Product reviews, architecture reviews, design reviews |
| **Creative** | Design variants (3 options), design-to-code generation |
| **Meta** | Weekly retros, institutional memory, second opinions |
| **Browser** | Persistent browsing, cookie auth, headed Chrome for CAPTCHAs |

### Dashboard

```bash
npm run dashboard
```

Dark-themed web dashboard showing: active threads, bot commits, pipeline status, enabled skills with last run results, and a timeline mixing commits and skill runs. Auto-refreshes every 60s.

For private repos: `localStorage.setItem('github_token', 'ghp_...')`

### Running Multiple Projects (Same Machine)

Each project gets its own clone of the agent. Same bot identity, different configs, different channels.

```bash
# Project 1
git clone https://github.com/PrathameshSujgure-git/the-memetic-agent.git agent-project1
cd agent-project1 && npm install
# create .env (see below), then:
npm run setup    # channel: #project1-dev, repo: org/project1
npm run start    # Terminal Tab 1

# Project 2
git clone https://github.com/PrathameshSujgure-git/the-memetic-agent.git agent-project2
cd agent-project2 && npm install
# create .env (see below), then:
npm run setup    # channel: #project2-dev, repo: org/project2
npm run start    # Terminal Tab 2
```

**Each instance MUST have its own `SLACK_APP_TOKEN`.**

Slack's Socket Mode delivers events to only one connection per app token. Two instances sharing the same token = only one receives events, the other is deaf.

Generate a separate app-level token for each instance:
1. https://api.slack.com/apps → your app → **Basic Information** → **App-Level Tokens**
2. Click **Generate Token and Scopes**
3. Name: `socket-project1` → scope: `connections:write` → Generate
4. Repeat: `socket-project2` → same scope → Generate

```bash
# Project 1 .env
SLACK_BOT_TOKEN=xoxb-...       # same across all instances
SLACK_APP_TOKEN=xapp-PROJECT1  # ← UNIQUE per instance
SLACK_BOT_USER_ID=U...         # same across all instances

# Project 2 .env
SLACK_BOT_TOKEN=xoxb-...       # same
SLACK_APP_TOKEN=xapp-PROJECT2  # ← UNIQUE
SLACK_BOT_USER_ID=U...         # same
```

Each instance:
- Has its own Socket Mode connection (separate app token)
- Locks to its own Slack channel (ignores events from other channels)
- Edits its own GitHub repo
- Runs fully independently
- Posts as the same bot identity

### Troubleshooting

**No 👀 reaction when I @mention** — Bot isn't in the channel. Run `/invite @memeticco` in your channel.

**👀 appears but no reply** — Check terminal output. Likely Claude Code not installed or Rube MCP not configured.

**Replies show as my name, not the bot** — Listener posts via bot token. If you still see your name, check that `SLACK_BOT_TOKEN` in `.env` is correct (starts with `xoxb-`, not your user token).

**Thread replies ignored** — Bot needs `message.channels` event subscription. Go to Slack app settings → Event Subscriptions → add it.

**"Run npm run setup first"** — `scripts/agent-system-generated.md` is missing. Run `npm run setup`.

**Agent doesn't understand the project** — Run `npm run generate-context` to scan the repo and generate CODEBASE.md.

**Skills not running** — Check `config/skills.json` — the skills you want must have `"enabled": true`. Or re-run `npm run setup` to enable more packs.

**Want better accuracy** — Install optional tools (eslint, tsc, lighthouse, etc.). Claude detects them and upgrades skills automatically.
