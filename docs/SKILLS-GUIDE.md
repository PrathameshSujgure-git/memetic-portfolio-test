# Skills Guide

The Memetic Agent can do more than make code changes. Skills are deep analysis tools that run automatically at the right moment or when you ask for them. You never need to remember skill names — just describe what you want.

---

## For Humans

### What are skills?

Skills are like having specialist reviewers on your team. Instead of just making changes and hoping they're good, the agent can:

- **Audit your design** against 80 quality points (typography, spacing, colors, accessibility)
- **Review your code** like a senior engineer (catching bugs, performance issues, security holes)
- **Test your pages** automatically before shipping
- **Monitor production** after deploys to catch issues early
- **Review your product strategy** like a YC partner

### How to use skills in Slack

You have one command: `!check`

```
!check design        → runs a visual quality audit
!check security      → scans for vulnerabilities
!check performance   → measures page speed
!check everything    → runs all enabled skills
!check ready to ship → pre-launch bundle (QA + security + design)
```

You can also just describe what you want in natural language during a `!full-access` session:

```
"is this accessible?"     → agent runs design audit focused on accessibility
"any bugs?"               → agent runs code review + QA
"is this ready?"          → agent runs the pre-merge bundle
```

### What happens when a skill runs?

1. You see a message: "Running Design Audit..."
2. The agent analyzes your changes (15-90 seconds depending on the skill)
3. You get a formatted result with findings grouped by severity
4. If issues are found, reply `!and fix` and the agent fixes what it can

### Skill Packs

During setup, you choose which packs to enable:

**Quality Pack** (recommended for all projects)
- *Design Audit* — 80-point visual check after design changes
- *Code Review* — staff-engineer review after code changes
- *QA Check* — suggested before merging to production

**Security Pack** (recommended for apps with user data)
- *Security Scan* — OWASP Top 10 + threat modeling before merge

**Shipping Pack** (recommended for production apps)
- *Canary Monitor* — auto health check after every deploy
- *Release Notes* — auto-generated changelog after merge
- *Performance Check* — on-demand speed measurement

**Planning Pack** (for product strategy)
- *Product Review* — YC-style product critique
- *Design Direction* — strategic design consultation

### How skills trigger (it's automatic)

You don't need to think about which skill to run. The agent watches what you change and picks the right skill:

| What you changed | What the agent runs | Why |
|-----------------|--------------------|----|
| CSS, colors, layout | Design Audit | Visual changes need visual review |
| Functions, API routes, logic | Code Review | Logic changes need correctness review |
| Auth, tokens, passwords | Security Scan | Security-sensitive code auto-escalates |
| package.json, lock files | Security Scan | New dependencies = new attack surface |
| Same files 3+ times | Design Audit | Lots of iteration = time for quality check |
| 10+ files in one commit | Code Review + QA | Big changes need deeper review |
| Content JSON, markdown | Nothing | Pure content is safe, just ship it |
| `!merge` | QA + Security | Gate before production |
| After deploy | Canary Monitor | Verify production health |

**You never need to ask.** Skills run as part of the normal pipeline and results appear inline.

For interactive skills (Product Review, Design Direction), the agent detects when you're asking strategic questions and offers them.

You can still use `!check` to run skills manually anytime. And owners can adjust what auto-runs via `!skills` or `config/skills.json`.

### Managing skills

Owners can manage skills from Slack:

```
!skills              → list enabled skills and their triggers
!skills enable security   → enable the security pack
!skills disable qa        → disable QA checks
```

Or edit `config/skills.json` directly in the repo.

### FAQ

**Will skills slow down my workflow?**
Auto-triggered skills run in parallel with screenshots. You only wait for results if a critical issue blocks the merge. Most skills take 15-40 seconds.

**Can I turn off the design audit?**
Yes. `!skills disable design-audit` or set `"enabled": false` in `config/skills.json`.

**What if I disagree with a finding?**
Reply `!and skip` to dismiss findings and continue. The agent won't block you unless a critical security issue is found.

**Do I need to install gstack?**
No. The agent has gstack's skill logic built in. You don't need to install anything extra.

**How accurate are skills?**
Skills use a hybrid model: if real CLI tools are installed, they use hard data. If not, they fall back to LLM analysis. Here's the difference:
| Skill | Without tools | With tools installed |
|-------|--------------|---------------------|
| Design Audit | LLM reads code + screenshots | + `axe` for real WCAG contrast ratios and ARIA validation |
| Code Review | LLM reads diff, catches structural issues | + `eslint` for lint rules, `tsc` for type errors |
| QA Check | Browser Tool visits pages, checks console | + `playwright` runs actual test suites, `tsc` catches type errors |
| Security Scan | LLM pattern-matches OWASP in code | + `npm audit` for real CVE database, `semgrep` for SAST rules |
| Performance | LLM estimates from Browser Tool load | + `lighthouse` for real CWV scores (LCP, CLS, TBT, 0-100) |

On startup, the agent detects which tools are available and tells you. Install more tools anytime — the agent auto-detects on next restart.

Without any tools installed, skills still work as a senior colleague reviewing your work. With tools, they become that colleague plus real measurement data.

**Can contributors run skills?**
By default, `!check` requires editor role. Owners can adjust this in `config/skills.json` per skill.

---

## For the AI Agent

### Skill Versioning

`config/skills.json` has a `_version` field. When the Memetic Agent repo updates skill definitions (new skills, improved prompts, new signals), the version bumps. On startup, the agent should compare the version in the target repo's `config/skills.json` with the latest `config/skills.json.template` in the Memetic Agent repo (if accessible). If outdated, post a one-time notice in the Slack channel:

```
💡 Skill definitions have been updated (v1.0.0 → v1.1.0). New skills available: [list]. Run setup again or copy the latest config/skills.json.template and docs/SKILL-DEFINITIONS.md to your repo.
```

This is informational only — never auto-update the target repo's skill config.

### Reading the skill config

At startup, read `config/skills.json` from the target repo (staging branch, fall back to main). This file contains:

- `skills` — map of skill ID to skill definition
- `_packs` — grouping info (for display only, not for execution)
- `skill_router` — context-aware automatic skill selection (signals + routing rules)
- `natural_language_map` — fallback keyword map for explicit `!check` commands

### Skill Router (automatic selection)

The router picks skills without user input. After every commit:

1. **Collect signals** — evaluate each signal in `skill_router.signals`:
   - `detect_by: "files"` — match changed filenames against `file_patterns`, optionally exclude `exclude_patterns`
   - `detect_by: "content"` — scan the diff text for `content_patterns` (e.g., "password", "auth", "fetch")
   - `detect_by: "context"` — evaluate `condition` against thread history (commit count, file overlap)
   - `detect_by: "diff_size"` — check if diff exceeds `threshold`
   - `detect_by: "intent"` — match user's original request text against `patterns`
   - `detect_by: "command"` — fires on specific bang command
   - `detect_by: "event"` — fires on lifecycle event

2. **Resolve skills** — each matched signal contributes its `skills` list. Higher `priority` signals win when there are conflicts.

3. **Use judgment** — no hard limits. The agent reads the full context (user's request, diff size, thread history, what was already checked) and decides how many skills to run. A one-line copy fix might need zero. A big refactor before merge might need five.

4. **Run selected skills** — in priority order, following the execution protocol below.

**Signals the router considers (not hard rules — context-dependent):**
- Pure content edits (JSON, MD) usually need nothing
- Auth/security patterns in diff should escalate to Security Scan
- Repeated iterations on same files suggest a quality check
- Large diffs benefit from deeper review
- First commit in a thread can be lighter (let user see the change first)
- Pre-merge is a natural gate point for thorough checks

### Execution protocol

When running any skill:

1. **Check permission**: verify user has `min_role` for the skill
2. **Start signal**: add `slack_emoji` reaction to triggering message, post "Running [display_name]..."
3. **Read instructions**: load the skill's execution steps from `docs/SKILL-DEFINITIONS.md`
4. **Execute**: follow the steps, using changed files as input context
5. **Progress updates**: for skills >15 seconds, post intermediate updates ("Analyzing 5 files...", "Found 2 issues, checking fixes...")
6. **Format results**: use the skill's `result_format`:
   - `checklist` — pass/fail items grouped by severity, with pass count
   - `report` — structured sections with findings, file:line references, and remediation
   - `comparison` — before/after metrics with delta percentages
   - `summary` — 3-5 bullet executive summary
7. **Action prompt**: if issues found, suggest next steps ("Reply `!and fix` to apply fixes")
8. **Persist results**: commit to `.slack-context/_skills/{skill-id}-{ISO-timestamp}.json`
9. **Update reaction**: checkmark for pass, warning for issues found

### Determining trigger conditions

When the agent commits code, evaluate which auto-triggered skills should run:

1. Get the list of changed files from the commit
2. For each trigger type in `trigger_map`:
   - `visual-change`: check if any file matches `file_patterns` OR if content changes match `content_patterns`
   - `code-change`: check if any file matches `file_patterns`
   - `pre-merge`: fires when user posts `!merge`
   - `post-deploy`: fires after successful merge to main
3. For each matching trigger, find skills where `trigger === "auto"` and `trigger_on` includes this trigger type
4. Run matching skills in order: design-audit → code-review → qa → security-scan → canary-monitor → release-docs

### Handling `!check` command

When user posts `!check [text]`:

1. Parse the text after `!check`
2. Look up keywords in `natural_language_map`
3. If multiple skills match, run them in the order above
4. If no match, ask: "What would you like me to check? Options: design, code, security, performance, everything"
5. If `!check everything`, run all enabled skills with `trigger !== "manual"` first, then manual ones

### Handling suggestions

When a skill has `trigger: "suggested"` and its trigger condition fires:

1. Post suggestion message (see reply-format.md template)
2. Wait for user response in thread
3. If user replies "yes", "do it", "go ahead", "!and yes" → execute the skill
4. If user replies "no", "skip", "later" → do not execute, continue workflow
5. Do not ask again for the same skill in the same thread unless files change again

### Avoiding duplicate runs

Before running a skill, check `.slack-context/_skills/` for recent results:
- If the same skill ran in the last 5 minutes on the same files → skip
- If files changed since last run → run again
- Exception: user explicitly requests with `!check` → always run

### Error handling

If a skill fails (timeout, Browser Tool error, etc.):
1. Post: "⚠️ [Display Name] couldn't complete. [1 line reason]"
2. Continue the workflow — don't block on a failed skill
3. Exception: if a `required` pipeline skill fails, retry once, then ask user

### Skill results file format

Committed to `.slack-context/_skills/{skill-id}-{ISO-timestamp}.json`:

```json
{
  "skill": "design-audit",
  "display_name": "Design Audit",
  "ran_at": "2026-04-04T12:00:00Z",
  "trigger": "auto",
  "trigger_reason": "visual-change",
  "thread_ts": "1775153594.541889",
  "files_analyzed": ["components/Gallery.tsx", "styles/global.css"],
  "findings": {
    "critical": 0,
    "warning": 2,
    "info": 5,
    "passed": 73,
    "total": 80
  },
  "details": [
    {
      "severity": "warning",
      "category": "accessibility",
      "message": "Image alt text missing on gallery items 3, 7",
      "file": "components/Gallery.tsx",
      "line": 45,
      "fix": "Add alt={item.title} to Image component"
    }
  ],
  "duration_ms": 28500,
  "autofix_applied": false
}
```

### `!skills` command handling

When an owner posts `!skills`:
- Read `config/skills.json` from staging branch
- List enabled skills with trigger type and last run status
- Format as a clean Slack message

When an owner posts `!skills enable [pack-or-skill]`:
- Match against pack names or skill IDs
- Update `enabled` field in `config/skills.json`
- Commit updated file to staging branch
- Reply confirming the change

When an owner posts `!skills disable [pack-or-skill]`:
- Same as enable but set `enabled: false`
- Safety: never disable safety skills
