# Slack Reply Format Guide

Reference this before every Slack message you send. Every reply must follow this structure.

## Core Principle
Clients skim messages. Make updates easy to scan, easy to understand and easy to give feedback on. No unnecessary calls — everything async.

## Message Structure

### 1. Main Message (visible in the group/thread)
This is the first thing the client sees. Keep it scannable.

- **Short title** describing the update (e.g. "Add Memory modal design iteration")
- **Visual proof**: screenshot of the change (use Block Kit image blocks)
- **1-2 lines** of high-level context — the tl;dr version
- No long paragraphs here

### 2. Reply Thread (detailed explanation)
Use the thread to explain things clearly. For each change:

- **Short title** for what that section is about
- **What** changed — 2-3 bullet points
- **Why** it was changed — reasoning behind the decision
- Mention if any previous feedback was incorporated
- Each screenshot gets its own reply with explanation

### 3. Links at the End
After context is clear, share links as handoff:

- Staging URL (preview link)
- GitHub commit URL (proof of change)
- Keep links at the end so the message stays clean

## Formatting Rules

**Do:**
- Use screenshots/images inline (Block Kit image blocks, never raw URLs)
- Keep main message under 4 lines
- Use bullet points, not paragraphs
- Use *bold* for emphasis, `backticks` for file paths
- Show before/after when making visual changes
- Explain the "why" not just the "what"

**Don't:**
- Write walls of text
- Use em dashes
- Use oxford commas
- Send links without context
- Skip the visual — always include a screenshot
- Use generic language ("improved the design") — be specific ("increased gallery gap from 2px to 8px for more breathing room")

## Reply Templates

### After Making a Change
```
✅ *[Short title of what changed]*

> [1 line summary of what and why]

*Files:* `component.tsx`, `content.json`
*Proof:* [commit URL]

📸 [Before screenshot]
📸 [After screenshot]

_Review above. `!and` for more iterations or `!merge` to go live._
```

### Asking a Question
```
A couple of things to clarify before I start:

1. *[Specific question]* — [why you need to know]
2. *[Specific question]* — [context for why it matters]

_Reply `!and` with your answers._
```

### Sharing a Plan
```
📋 *Plan: [title]*

Here's what I'll change:
• `file/path.tsx` — [old value] → [new value]
• `content/file.json` — [what changes]

*Visual outcome:* [describe what it will look like]
*Pages affected:* /page-name

_Ready? Reply `!and yes` to execute._
```

### Progress Update
```
⚡ Working on it...

📂 Reading `file.tsx`...
📝 Updating gallery gap...
✅ Committed! [link]
🔍 Building staging...
📸 [screenshot when ready]
```

### After Merge
```
✅ *Live on production!*

> [PR link]
> [1 line of what shipped]

🌐 memetic.design
📸 [production screenshot]
```

### Error / Failure
```
⚠️ *[What went wrong]*

> [1 line explanation]
> [What was attempted and why it failed]

_[Next step: how to fix it or what to try instead]_
```

### Iteration (second+ round of changes)
```
✅ *[Title — referencing previous change]*

> Previously: [what was done last time]
> Now: [what changed this time and why]

*Files:* `file.tsx`
📸 [After screenshot — current state reflects all iterations]

_`!and` for more or `!merge` to go live._
```

### Pipeline Results (with auto-routed skills)
When skills are auto-selected by the router, they appear inline with pipeline results.
The user sees one unified quality report, not separate "skill" and "pipeline" outputs.
```
🔍 *Quality check complete*

✅ Design check — spacing follows 8px grid
⚠️ Code hygiene — removed 1 unused import (autofixed)
✅ Bug check — no issues
🎨 Design Audit (80-point) — 78/80 passed
   ⚠️ 2 warnings: image alt text missing on items 3, 7
🔍 Code Review — no critical issues

_2 minor warnings. Reply `!and fix` to address them, or `!merge` to ship as-is._
```

If the router skips skills (pure content change), nothing extra shows.
If a skill finds critical issues, it appears at the top with ❌.

Add a brief "why" line when skills auto-run so the user understands the reasoning:
```
🔍 *Quality check complete* _(CSS + layout files changed)_
```
or
```
🔍 *Quality check complete* _(auth code touched — running security scan)_
```
Keep it short — one parenthetical, not a paragraph.

When a skill uses real tooling, note it briefly:
```
🔧 Code Review (eslint + tsc) — 2 type errors, 1 lint warning
🔍 Design Audit (prompt-only) — 78/80 passed
```
The emoji tells the story: 🔧 = tool-enhanced, 🔍 = prompt-only.

### Skill Running (for explicit !check or long-running skills)
```
🔍 *Running [Display Name]...*

> [1 line of what this checks]

_Usually takes [estimated_duration]._
```

### Skill Results (Checklist Format)
```
🔍 *[Display Name] — Complete*

*Critical (must fix):*
❌ [Finding with file:line if applicable]

*Warnings:*
⚠️ [Finding]

*Passed: X/Y*
✅ [Category] · ✅ [Category] · ✅ [Category] · ...

_[N] issues found. Reply `!and fix` to apply fixes._
```

### Skill Results (Report Format)
```
🛡️ *[Display Name] — Report*

> Scanned [N] files across [N] routes

*Findings:*
1. *[Title]* in `file.tsx:line` — [description]
   → Fix: [remediation]
2. *[Title]* in `file.tsx:line` — [description]
   → Fix: [remediation]

*Summary:* [N] issues ([N] critical, [N] warnings). [1 line takeaway].

_Reply `!and fix` to apply recommended fixes._
```

### Skill Results (Comparison Format)
```
📊 *[Display Name] — [Page]*

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Load time | 1.1s | 1.2s | +9% |
| JS bundle | 240KB | 245KB | +2% |

*Recommendations:*
- [Actionable suggestion]
```

### Skill Suggestion
```
💡 I noticed you changed [what triggered it]. Want me to run a *[Display Name]*?
[description_for_humans].

_Reply `!and yes` to run, or just continue._
```

### Skill Error
```
⚠️ *[Display Name] couldn't complete*

> [1 line reason — e.g. "Browser Tool timed out taking screenshot"]

_Continuing without this check. Run `!check [skill]` to retry._
```

## Message Length
- Slack limit: 4000 characters per message
- If your message exceeds ~3500 chars, split it into two messages
- First message: summary + files + proof
- Second message: screenshots + next steps
- Never send a message that will be truncated

## Voice & Tone
- Use "I" when the bot is acting alone ("I changed the gap to 8px")
- Use "we" when referencing collaborative decisions ("we agreed on the 8px grid")
- Confident but not arrogant
- Concise — say it in fewer words
- Technical when talking to devs, visual when talking to designers
- Always explain the reasoning, not just the action
- Match the user's energy — if they're casual, be casual. If they're formal, be precise.
