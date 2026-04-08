# Skill Definitions

Machine-readable execution instructions for each gstack skill. The agent reads this file to know HOW to execute skills. Each skill includes trigger conditions, step-by-step execution, expected output format, and timing.

## Hybrid Execution: Tools + Prompts

Some skills can use real CLI tools when available. On startup, the agent checks `config/skills.json` > `tool_detection` and runs detection commands. Skills with a `tooling` field have two execution paths:

**With tools:** Run the CLI tool first (eslint, tsc, lighthouse, npm audit, semgrep, axe, playwright), parse the output, then feed real findings into the LLM for deeper analysis and formatting. Hard data + LLM reasoning.

**Without tools:** LLM does everything — reads code, takes screenshots, reasons about quality. Still valuable, just less precise on things that benefit from measurement (contrast ratios, CWV scores, CVE databases, type checking).

The agent should always note which mode a skill ran in:
- `🔧 Design Audit (with axe)` — real accessibility data
- `🔍 Design Audit (prompt-only)` — LLM analysis from code + screenshots

| Tool | Install | Upgrades |
|------|---------|----------|
| `lighthouse` | `npm i -g lighthouse` | Performance Check → real CWV scores |
| `eslint` | `npm i -D eslint` | Code Review → static analysis |
| `tsc` | `npm i -D typescript` | Code Review + QA → type checking |
| `npm audit` | built-in | Security Scan → real CVE database |
| `semgrep` | `pip install semgrep` | Security Scan → SAST pattern rules |
| `playwright` | `npm i -D @playwright/test` | QA + Browse → real browser automation |
| `axe` | `npm i -D @axe-core/cli` | Design Audit → WCAG compliance |

---

## How skills get selected (Skill Router)

Skills are picked automatically — the user does nothing. After every commit, the agent:

1. Reads the diff (files changed + content changed)
2. Checks thread context (how many iterations, what was discussed)
3. Matches against signals in `config/skills.json` > `skill_router.signals`
4. Applies routing rules (max 2 per commit, dedup within 5 min, etc.)
5. Runs matched skills as part of the pipeline

**No hard rules.** The agent uses full context — user's request, diff content, thread history, what was already checked — to decide what to run and how many. A typo fix needs nothing. A big refactor before merge might need everything. The signals in `skills.json` are hints, not mandates.

**The user only sees results, not the routing logic.** Findings appear as part of the normal pipeline output.

---

## Design Audit (`/design-review`)

**Display name:** Design Audit
**Triggers on:** `visual-change` — files matching `*.css`, `*.scss`, `*.tsx` (with className/style changes), `*.svg`, image files
**Duration:** 20-40 seconds
**Can autofix:** Partially (spacing/typography yes, layout/accessibility no)
**Optional tools:** `axe` (real WCAG compliance data)

**Execution steps:**
1. Identify changed files from the commit diff
2. Determine which pages/routes are affected by the changes
3. Take a screenshot of each affected page on staging URL
4. **If axe available:** Run `npx @axe-core/cli [staging-url] --exit` on each affected page. Parse JSON output for real WCAG violations. Merge into the Accessibility category of the checklist below (replaces LLM estimates with hard data like "contrast ratio 3.2:1, needs 4.5:1").
5. Run the 80-item checklist against each page:

**Checklist categories:**

*Typography (12 items):*
- Font family matches design system
- Font sizes follow the type scale
- Font weights are consistent (no random bolds)
- Line heights are comfortable (1.4-1.6 for body, 1.1-1.3 for headings)
- Letter spacing appropriate per size
- No orphaned single words on a line (widows)
- Heading hierarchy is sequential (h1 > h2 > h3, no skips)
- Text contrast meets WCAG AA (4.5:1 body, 3:1 large)
- No text overflow or clipping
- Consistent text alignment per section
- Code/mono text uses correct font
- Link styles are distinct from body text

*Spacing (10 items):*
- Consistent use of spacing scale (4px/8px grid)
- Section padding follows pattern
- Component internal padding consistent
- Margins between sibling elements consistent
- No spacing collisions (double margins)
- Responsive spacing scales down properly
- Whitespace balance between sections
- List item spacing consistent
- Card padding matches design system
- Gap in grid/flex layouts matches system

*Colors (8 items):*
- All colors from the project palette
- No hardcoded hex outside design tokens
- Accent color used consistently
- Background/foreground contrast sufficient
- Hover/active states have visible color shift
- Dark mode colors correct (if applicable)
- No conflicting color combinations
- Semantic colors used correctly (error=red, success=green)

*Layout (12 items):*
- Grid columns align across sections
- Max-width constraints applied
- Content centered correctly
- No horizontal scroll on mobile
- Flex/grid gap consistent
- Sticky/fixed elements don't overlap content
- Z-index layering correct
- Aspect ratios maintained on images
- Cards same height in rows
- Footer at bottom of viewport
- No layout shift on load
- Responsive breakpoints transition smoothly

*Accessibility (15 items):*
- All images have alt text
- Form inputs have labels
- Buttons have accessible names
- Links are distinguishable from text
- Focus states visible
- Tab order logical
- Color not sole indicator of state
- Touch targets >= 44px on mobile
- Skip-to-content link present
- ARIA roles correct where used
- No autoplaying media
- Reduced motion respected
- Semantic HTML used (nav, main, article, aside)
- Language attribute set
- Heading levels sequential

*Consistency (10 items):*
- Component styles match across pages
- Icon sizes and styles consistent
- Button styles consistent (primary/secondary/ghost)
- Border radius consistent
- Shadow styles from design system
- Animation timing consistent
- Loading states consistent
- Empty states styled
- Error states styled
- Hover effects consistent

*Responsiveness (13 items):*
- Mobile layout works (320px)
- Tablet layout works (768px)
- Desktop layout works (1024px+)
- Large screen doesn't stretch (1440px+)
- Images resize correctly
- Text remains readable at all sizes
- Navigation adapts (hamburger on mobile)
- Touch-friendly on mobile (no tiny targets)
- No content hidden by overflow
- Tables scroll horizontally on mobile
- Modals fit mobile viewport
- Spacing reduces proportionally
- Font sizes scale down sensibly

**Output format:** Checklist grouped by severity
```
Critical (must fix):
- [finding with file:line if applicable]

Warnings (should fix):
- [finding]

Passed: X/80
- [category]: passed
```

---

## Code Review (`/review`)

**Display name:** Code Review
**Triggers on:** `code-change` — any `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go` file changed
**Duration:** 15-30 seconds
**Can autofix:** Partially (imports, console.logs, obvious null checks)
**Optional tools:** `eslint` (static analysis), `tsc` (type checking)

**Execution steps:**
1. **If eslint available:** Run `npx eslint [changed-files] --format=json`. Parse output for real lint errors. Auto-fix with `npx eslint --fix` for fixable issues.
2. **If tsc available:** Run `npx tsc --noEmit --pretty` on the project. Parse type errors. Report any that affect changed files.
3. Read the full diff of changed files
4. Read surrounding context (50 lines above/below each change)
5. Feed tool output (if any) + diff into the LLM review. Tool findings become confirmed issues. LLM adds structural analysis the tools can't do.
6. Run checks in this order:

**Check categories:**

*Performance:*
- N+1 query patterns (loop with DB/API call inside)
- Unbounded list rendering (missing pagination/virtualization)
- Missing memoization on expensive computations
- Unnecessary re-renders (unstable references in deps arrays)
- Large synchronous operations blocking the event loop

*Correctness:*
- Race conditions (async operations without proper guards)
- Missing null/undefined checks at trust boundaries
- Off-by-one errors in loops/slices
- Incorrect comparison operators (== vs ===)
- Unhandled promise rejections
- Missing error boundaries around async UI

*Security:*
- User input passed to dangerous sinks (innerHTML, eval, exec)
- Missing input validation at API boundaries
- Hardcoded secrets or API keys
- Insecure defaults (CORS *, permissive CSP)

*Hygiene:*
- Unused imports
- console.log/debug left behind
- Dead code paths
- Inconsistent naming patterns
- TODO/FIXME without ticket reference
- Commented-out code blocks

*Completeness:*
- Missing loading states for async operations
- Missing error states
- Missing empty states
- Unhandled edge cases mentioned in comments
- Missing TypeScript types (any escape hatches)

**Fix protocol:**
- Hygiene issues: auto-fix and commit
- Performance/correctness: report with suggested fix, ask user
- Security: report as critical, block if severity is high

**Output format:** Report
```
[Severity] [Category] in `file.tsx:line`
Description of the issue
→ Fix: suggested remediation

Summary: X issues (Y critical, Z warnings), W auto-fixed
```

---

## QA Check (`/qa`)

**Display name:** QA Check
**Triggers on:** `pre-merge` or on-demand
**Duration:** 30-90 seconds
**Can autofix:** No
**Optional tools:** `tsc` (type checking), `playwright` (real test execution)

**Pre-execution (if tools available):**
- **If tsc available:** Run `npx tsc --noEmit` — report any type errors in changed files
- **If playwright available:** Check if test files exist matching changed files (`*.spec.ts`, `*.test.ts` with `@playwright/test`). If yes, run `npx playwright test [matching-test-files]`. Report real pass/fail results.

**Execution steps:**

*Mode selection (automatic):*
- After normal commit → `quick` mode
- Before merge (`!merge`) → `full` mode
- User says "!check qa" → `diff-aware` mode
- Previous failures exist in `.slack-context/_skills/` → add `regression` checks

*Quick mode:*
1. Read changed files
2. Check they compile (no syntax errors in the diff)
3. Visit affected pages on staging URL
4. Check for console errors
5. Verify changed elements render correctly
6. Screenshot each affected page

*Full mode:*
1. Get list of all routes from CODEBASE.md
2. Visit each route on staging URL
3. Check for console errors on each page
4. Check all interactive elements (buttons, links, forms)
5. Test critical user flows (navigation, form submission if applicable)
6. Screenshot key pages
7. Compare with production screenshots if available

*Diff-aware mode:*
1. Read the full diff since last QA run
2. Map changes to affected routes/components
3. Test only those routes
4. Check for regressions in related components

*Regression mode (additive):*
1. Read previous failure results from `.slack-context/_skills/qa-*.json`
2. Re-test each previously failing check
3. Report if regressions are fixed or persist

**Output format:** Checklist
```
Pages tested: X
Console errors: Y
Visual issues: Z

Per page:
✅ /home — no errors, renders correctly
❌ /about — console error: "Cannot read property..."
⚠️ /contact — form submit button not visible on mobile
```

---

## Security Scan (`/cso`)

**Display name:** Security Scan
**Triggers on:** `pre-merge` (suggested) or on-demand
**Duration:** 20-40 seconds
**Can autofix:** No (security fixes need human review)
**Optional tools:** `npm_audit` (CVE database), `semgrep` (SAST rules)

**Pre-execution (if tools available):**
- **If npm audit available:** Run `npm audit --json` in the project root. Parse JSON for known CVEs. Report: package name, severity, vulnerability description, fix command.
- **If semgrep available:** Run `semgrep --config=auto --json [changed-files]`. Parse for security findings. Merge with LLM analysis — tool findings become confirmed issues.

**Execution steps:**
1. Read all changed files in the current branch
2. Merge any tool findings from pre-execution
3. Run OWASP Top 10 analysis (LLM reviews code for patterns tools might miss):

*OWASP checks:*
- A01 Broken Access Control: are there routes without auth checks? Can users access others' data?
- A02 Cryptographic Failures: is sensitive data stored/transmitted in plaintext? Weak hashing?
- A03 Injection: SQL, XSS, command injection, LDAP injection in any user-facing input
- A04 Insecure Design: missing rate limiting, no CSRF tokens, predictable resource IDs
- A05 Security Misconfiguration: verbose error messages, default credentials, open CORS
- A06 Vulnerable Components: known CVEs in dependencies (check package.json)
- A07 Auth Failures: weak passwords allowed, no brute-force protection, session issues
- A08 Data Integrity: unsigned data, unverified downloads, CI/CD pipeline poisoning
- A09 Logging Failures: security events not logged, sensitive data in logs
- A10 SSRF: user input used in server-side HTTP requests without validation

3. Run STRIDE threat model on the change:
- **S**poofing: can someone impersonate a user/component?
- **T**ampering: can data be modified in transit/storage?
- **R**epudiation: can actions be denied? Is there an audit trail?
- **I**nformation Disclosure: can sensitive data leak?
- **D**enial of Service: can the change be abused to overload the system?
- **E**levation of Privilege: can a user gain unauthorized access?

**Output format:** Report
```
OWASP Analysis:
[severity] A03 Injection — XSS in `components/Search.tsx:45`
  User input rendered with dangerouslySetInnerHTML
  → Fix: use textContent or sanitize with DOMPurify

STRIDE Analysis:
[medium] Information Disclosure — API error responses include stack traces
  → Fix: sanitize error responses in production

Summary: X findings (Y critical, Z high, W medium)
```

---

## Canary Monitor (`/canary`)

**Display name:** Canary Monitor
**Triggers on:** `post-deploy` (auto)
**Duration:** 60-120 seconds
**Can autofix:** No

**Execution steps:**
1. Wait 60 seconds after merge for deploy propagation
2. Get production URL from project config
3. Get list of key routes from CODEBASE.md (or use: /, /about, and any routes changed in the merge)
4. For each route:
   a. Visit with Browser Tool
   b. Check HTTP status (expect 200)
   c. Check for console errors
   d. Check key elements are visible (heading, navigation, footer)
   e. Take screenshot
   f. If pre-deploy screenshot exists, compare visually
5. If ANY critical check fails:
   a. Post alert to thread
   b. Post alert to channel (using channel-wide message)
   c. Suggest rollback if multiple pages affected

**Output format:** Checklist
```
Production health check — [production URL]

✅ / — 200, no errors, renders correctly
✅ /about — 200, no errors
❌ /contact — 500 error, form component crash

Action needed: /contact is broken. Consider rolling back or posting a fix.
```

---

## Release Notes (`/document-release`)

**Display name:** Release Notes
**Triggers on:** `post-deploy` (suggested)
**Duration:** 10-20 seconds
**Can autofix:** N/A

**Execution steps:**
1. Read all `.slack-context/` files for threads in this merge
2. Read the PR description
3. Read commit messages in the merge
4. Compile changes by type: features, fixes, improvements, style changes
5. Generate release notes

**Output format:** Summary
```
Release — [date]

Changes:
- Added: [feature description]
- Fixed: [bug description]
- Improved: [improvement description]
- Style: [visual change description]

Files changed: X
Contributors: @user1, @user2
```

---

## Performance Check (`/benchmark`)

**Display name:** Performance Check
**Triggers on:** on-demand only
**Duration:** 30-60 seconds
**Can autofix:** No
**Optional tools:** `lighthouse` (real Core Web Vitals)

**Execution steps:**

**If lighthouse available:**
1. For each affected route, run: `lighthouse [staging-url/route] --output=json --chrome-flags='--headless --no-sandbox'`
2. Parse JSON for: Performance score (0-100), LCP, FID, CLS, TBT, Speed Index
3. Extract top optimization opportunities (unused JS, unoptimized images, render-blocking resources)
4. If previous lighthouse results exist in `.slack-context/_skills/`, show before/after comparison with real numbers

**If lighthouse NOT available (fallback):**
1. Get affected routes (from thread context or user request)
2. For each route on staging URL:
   a. Visit with Browser Tool
   b. Measure page load time (time from navigation to load complete)
   c. Check resource sizes (JS, CSS, images, fonts)
   d. Observe layout stability during load (CLS indicator)
   e. Check for render-blocking resources
   f. Note largest content paint element
3. If previous benchmark exists in `.slack-context/_skills/benchmark-*.json`:
   a. Show before/after comparison
   b. Flag any metric that regressed >10%
4. Save results for future comparison

**Output format:** Comparison
```
Performance — /page-name

Load time: 1.2s (was 1.1s, +9%)
JS bundle: 245KB (was 240KB, +2%)
Images: 1.2MB total (3 unoptimized)
LCP element: hero image (2.1s)
CLS: minimal (no layout shift observed)

Recommendations:
- Compress hero.jpg (currently 800KB)
- Lazy load below-fold images
```

---

## Product Review (`/office-hours`)

**Display name:** Product Review
**Triggers on:** on-demand only
**Duration:** Interactive (multi-turn conversation)
**Can autofix:** N/A

**Execution steps:**
1. Read the thread context to understand what the user is building/requesting
2. If this is about a specific feature: focus the review on that feature
3. If this is a general review: do a full product assessment
4. Ask six forcing questions (one at a time, wait for responses):
   - Who is the user and what problem does this solve?
   - How do they solve this today without your product?
   - What is your unique insight that others are missing?
   - What is the absolute simplest version you can ship?
   - How will you measure success? What does "working" look like?
   - What is the biggest risk — and what kills this if you're wrong?
5. After all answers, synthesize into actionable recommendations
6. Be direct. Challenge weak answers. Suggest concrete next steps.

**Output format:** Summary
```
Product Review Summary

Strengths:
- [what's strong about the approach]

Concerns:
- [what needs rethinking]

Recommendation:
[1-3 concrete next steps]
```

---

## Design Direction (`/design-consultation`)

**Display name:** Design Direction
**Triggers on:** on-demand only
**Duration:** Interactive (multi-turn conversation)
**Can autofix:** N/A

**Execution steps:**
1. Read CODEBASE.md for current design guidelines
2. Take screenshots of 3-5 key pages on staging/production
3. Analyze current visual direction: typography, color, spacing, component patterns
4. Research: what visual patterns are common in this product category?
5. Identify areas where the design could be stronger
6. Generate recommendations:
   - Typography: suggest type scale, pairings, hierarchy
   - Color: suggest palette refinements, accent usage
   - Spacing: suggest rhythm, section pacing
   - Components: suggest patterns, hover states, transitions
   - Motion: suggest animation timing, easing
7. Present as a design direction document

**Output format:** Report
```
Design Direction — [project name]

Current state: [1-2 sentence assessment]

Recommendations:
Typography: [suggestions]
Color: [suggestions]
Spacing: [suggestions]
Components: [suggestions]

Creative risk worth taking: [one bold suggestion]
Safe default: [one conservative suggestion]
```

---

## CEO Review (`/plan-ceo-review`)

**Display name:** CEO Review
**Triggers on:** on-demand or when user discusses product direction
**Duration:** Interactive (multi-turn conversation)
**Can autofix:** N/A

**Execution steps:**
1. Read the thread context — what feature or product decision is being discussed?
2. Determine mode based on context:
   - **Scope Expansion**: what would make this 10x better? What would delight users?
   - **Selective Expansion**: which specific parts deserve more investment?
   - **Hold Scope**: is the current scope right for the goal?
   - **Scope Reduction**: what can we cut without losing the magic?
3. For the selected mode:
   a. Identify the core user insight — what do users actually need?
   b. Find the "10-star experience" — the version so good users tell friends
   c. Work backwards to what's actually shippable now
   d. Challenge assumptions — what are we wrong about?
4. Be direct, opinionated, and specific. No vague encouragement.

**Output format:** Summary
```
CEO Review — [feature/product]

Mode: [Scope Expansion/Reduction/etc.]

The 10-star version: [what would blow users' minds]
What's actually shippable: [realistic scope]
What to cut: [things that don't earn their complexity]
What you're wrong about: [assumption challenge]

Next step: [one concrete action]
```

---

## Eng Review (`/plan-eng-review`)

**Display name:** Eng Review
**Triggers on:** suggested when planning complex features, on-demand
**Duration:** 20-40 seconds
**Can autofix:** No

**Execution steps:**
1. Read the plan, feature request, or implementation in the thread context
2. Read relevant source files from the repo to understand current architecture
3. Generate:
   a. **Architecture assessment** — how do components relate? What's the data flow? Where are the API boundaries?
   b. **Risk matrix** — what could go wrong?
      - Scaling: will this work at 10x traffic?
      - Data integrity: race conditions, consistency issues?
      - Migration: does this require data migration?
      - Dependencies: external service failures?
   c. **Test strategy** — what needs testing?
      - Unit: pure functions, business logic
      - Integration: API endpoints, database queries
      - E2E: user flows, critical paths
   d. **Review Readiness Dashboard**:
      - Architecture clarity: X/10
      - Test coverage plan: X/10
      - Error handling: X/10
      - Performance considerations: X/10

**Output format:** Report
```
Eng Review — [feature]

Architecture: [component diagram in text]
Data flow: [request → handler → DB → response]

Risks:
🔴 [high risk] — [description and mitigation]
🟡 [medium risk] — [description]
🟢 [low risk] — [description]

Test plan:
- Unit: [what to test]
- Integration: [what to test]
- E2E: [what to test]

Readiness: [X/10 average across dimensions]
```

---

## Design Pre-Review (`/plan-design-review`)

**Display name:** Design Pre-Review
**Triggers on:** suggested when a plan exists but code hasn't started, on-demand
**Duration:** 20-30 seconds
**Can autofix:** No

**Execution steps:**
1. Read the plan or feature description from thread context
2. If screenshots or mockups exist, analyze them
3. Run 7 passes:

**Pass 1 — User Flow (X/10):**
Is the happy path clear? What about: error states, empty states, loading states, edge cases (long text, no data, slow connection)?

**Pass 2 — Visual Hierarchy (X/10):**
Will the user see what matters first? Is there a clear focal point? Does the information density feel right?

**Pass 3 — Information Architecture (X/10):**
Is content organized logically? Can users find what they need? Does the navigation make sense?

**Pass 4 — Accessibility (X/10):**
Will this work for screen readers? Keyboard navigation? Color blind users? Touch targets adequate?

**Pass 5 — Edge Cases (X/10):**
What happens with: 0 items, 1 item, 100 items, very long text, very short text, missing images, slow network, offline?

**Pass 6 — Consistency (X/10):**
Does this match existing patterns in CODEBASE.md? Same button styles, spacing, typography, motion?

**Pass 7 — AI Slop Detection (X/10):**
Does anything look generic, templated, or lacking personality? Flag: gradient blobs, generic hero sections, stock-photo vibes, "Lorem ipsum" energy.

**Output format:** Checklist
```
Design Pre-Review — [feature]

User Flow: 8/10 — happy path clear, missing error state for [scenario]
Visual Hierarchy: 7/10 — CTA gets lost below the fold
Information Architecture: 9/10 — logical grouping
Accessibility: 6/10 — touch targets too small on mobile, missing alt text
Edge Cases: 5/10 — no empty state designed, long text overflows
Consistency: 8/10 — matches existing patterns except [detail]
AI Slop: 9/10 — feels intentional, not templated

Overall: 7.4/10
Fix before coding: [top 3 issues]
```

---

## Design Variants (`/design-shotgun`)

**Display name:** Design Variants
**Triggers on:** on-demand when user asks for options/alternatives
**Duration:** 30-60 seconds
**Can autofix:** N/A

**Execution steps:**
1. Understand what component, page, or feature needs variants
2. Read CODEBASE.md for design system constraints
3. Generate 3 distinct approaches:
   - **Variant A — Safe**: follows existing patterns exactly, minimal visual risk, polished execution
   - **Variant B — Bold**: pushes the design system intentionally, stronger visual statement, confident
   - **Variant C — Experimental**: breaks a convention on purpose, unexpected, high risk/high reward
4. For each variant: describe the visual direction in detail (colors, typography, layout, spacing, motion)
5. If possible, generate code previews for each variant
6. Present all three with clear trade-offs
7. Ask user which direction resonates, then implement that one

**Output format:** Comparison
```
Design Variants — [component/page]

Variant A (Safe):
[Description — what it looks like, why it works, trade-off]

Variant B (Bold):
[Description — what's different, what statement it makes, trade-off]

Variant C (Experimental):
[Description — what convention it breaks, why it might be great, trade-off]

Which direction feels right?
```

---

## Design to Code (`/design-html`)

**Display name:** Design to Code
**Triggers on:** on-demand
**Duration:** 30-60 seconds
**Can autofix:** N/A

**Execution steps:**
1. Understand the input: design description, screenshot, Figma reference, or direction from Design Variants
2. Detect framework from CODEBASE.md (React/Next.js, Svelte, Vue, plain HTML)
3. Read the project's existing components, design tokens, naming conventions
4. Generate production-ready code that:
   - Uses existing component library (don't reinvent)
   - Follows naming conventions from the codebase
   - Uses design tokens (CSS variables, Tailwind config, theme)
   - Includes responsive breakpoints
   - Handles loading, empty, and error states
5. Run refinement loop:
   a. Generate code → commit to staging
   b. Take screenshot
   c. Compare with design intent
   d. Adjust and re-commit if needed
6. Output exact file paths and changes

**Output format:** Report
```
Design to Code — [component]

Framework: [detected]
Files created/modified:
- [file path] — [what this file does]

Using existing:
- [component name] from [file path]
- [design token] from [file path]

Screenshot: [staging URL screenshot]
```

---

## Root Cause Investigation (`/investigate`)

**Display name:** Root Cause
**Triggers on:** auto when user reports a bug, on-demand
**Duration:** 30-120 seconds
**Can autofix:** Only after root cause is confirmed

**Execution steps:**

**Iron Law: no fixes without root cause.**

1. **Reproduce** — understand exactly what happens
   - What's the expected behavior?
   - What's the actual behavior?
   - What page/route/action triggers it?
   - Can you reproduce it on staging? On production?

2. **Narrow** — bisect the problem
   - Which file? Read the component tree.
   - Which function? Read the data flow.
   - Which line? Read the actual code.
   - Is it a data issue, logic issue, or render issue?

3. **Root cause** — explain WHY, not just WHAT
   - Trace the data flow from source to symptom
   - Read the actual code (don't guess from memory)
   - Check: was this working before? What changed? (read recent commits)
   - Confirm: does the root cause explain ALL the symptoms?

4. **Only after root cause is confirmed**: propose a fix
   - Explain what the fix does and why it addresses the root cause
   - Check if the fix could introduce new issues

**3-strike rule:** If 3 investigation attempts fail to find root cause, STOP. Post what you know, what you've ruled out, and escalate to the user.

**Output format:** Report
```
Root Cause Investigation — [bug description]

Symptom: [what the user sees]
Root cause: [why it happens — file:line, data flow explanation]
Evidence: [how you confirmed this]

Fix: [what to change and why]
Risk: [could this fix break anything else?]
```

---

## Ship Check (`/ship`)

**Display name:** Ship Check
**Triggers on:** suggested before merge, on-demand
**Duration:** 15-30 seconds
**Can autofix:** Partial (can generate PR description, add missing tests)

**Execution steps:**
1. Read all changes on the staging branch since it diverged from main
2. Run checks:

**Test bootstrap:**
- Are there tests? Do they cover the changed files?
- Flag untested critical paths

**Coverage audit:**
- Which changed functions have tests?
- Which don't? Are they critical?

**Review gate:**
- Has this been reviewed? (check thread for explicit approvals)
- Are there unresolved questions in the thread?

**PR quality:**
- Is the PR title clear and descriptive?
- Does the description explain the why, not just the what?
- Are screenshots included for visual changes?

**Changelog readiness:**
- Should this change be documented? (features yes, typo fixes no)
- Generate a changelog entry if needed

**Output format:** Checklist
```
Ship Check — ready to merge?

✅ Tests: 3 test files cover changed code
⚠️ Coverage: `handleSubmit` in form.tsx has no test
✅ Review: approved by @user in thread
✅ PR description: clear, includes screenshots
⚠️ Changelog: new feature should be documented

Recommendation: [ship it / fix X first]
```

---

## Full Review (`/autoplan`)

**Display name:** Full Review
**Triggers on:** on-demand, when user asks for comprehensive review before building
**Duration:** 60-120 seconds
**Can autofix:** No

**Execution steps:**
Run three reviews sequentially on the plan or feature request:

1. **CEO Review pass** — Is this the right thing to build?
   - Find the 10-star version
   - Challenge scope
   - What would users actually pay for?

2. **Design Pre-Review pass** — 7-pass design review
   - User flow, visual hierarchy, IA, accessibility, edge cases, consistency, AI slop
   - Rate each 0-10

3. **Eng Review pass** — Can we build this well?
   - Architecture, risks, test strategy
   - Review readiness dashboard

4. **Synthesis** — combine all three into unified recommendation:
   - What to change before building
   - What's strong
   - What's risky
   - Concrete next steps

**Six encoded principles:**
- User value over technical elegance
- Ship fast then iterate
- Simplicity wins
- Data beats opinions
- Design is how it works, not how it looks
- Good enough today beats perfect next month

**Output format:** Report
```
Full Review — [feature]

Product (CEO): [1-2 line verdict + 10-star insight]
Design: [overall score X/10 + top issues]
Engineering: [readiness X/10 + top risks]

Verdict: [build / rethink / descope]
Before building: [top 3 changes]
```

---

## Weekly Retro (`/retro`)

**Display name:** Weekly Retro
**Triggers on:** on-demand
**Duration:** 20-40 seconds
**Can autofix:** N/A

**Execution steps:**
1. Read all `.slack-context/` files from the past 7 days
2. Read git log for the past 7 days on both staging and main branches
3. Compile:

**Per-person breakdown:**
- Who shipped what (map Slack user IDs to changes via commit messages)
- How many changes per person
- Which areas of the codebase each person touched

**Shipping metrics:**
- Total commits to staging
- Total merges to production
- Shipping streak (consecutive days with production deploys)

**Quality metrics:**
- Pipeline pass rate (how often did all steps pass on first try?)
- Autofix rate (how many issues were auto-resolved?)
- Skill findings (what types of issues were most common?)

**Patterns:**
- Same files changed repeatedly? (suggests instability or iteration)
- Same types of bugs recurring? (suggests systemic issue)
- Areas with no changes? (stable or neglected?)

**Output format:** Report
```
Weekly Retro — [date range]

Shipped: [X] changes to production by [N] people
Streak: [N] consecutive deploy days

Per person:
@user1 — [N] changes (components, content)
@user2 — [N] changes (API, styles)

What went well: [changes that shipped cleanly]
What was hard: [changes that needed 3+ iterations]
Pattern: [recurring observation]

Suggestion: [one actionable improvement for next week]
```

---

## Learn (`/learn`)

**Display name:** Learn
**Triggers on:** auto after every thread that results in a commit
**Duration:** 5-10 seconds
**Can autofix:** N/A

**Execution steps:**
1. After a thread concludes (merge or user moves on), review the full thread
2. Extract learnings in three categories:

**Codebase learnings:**
- Gotchas discovered (e.g., "Gallery component requires key prop on carousel items")
- Patterns that work (e.g., "Always use optional chaining on content.credits")
- File relationships (e.g., "Changing Gallery.tsx requires checking MockupFrame.tsx")

**User preference learnings:**
- Style preferences (e.g., "User prefers 8px grid, Geist Mono for captions")
- Communication preferences (e.g., "User wants terse replies, no trailing summaries")
- Decision patterns (e.g., "User prioritizes mobile-first, always checks /about page")

**Project learnings:**
- Design system rules (e.g., "Blue accent #1F78FF, never use gradient overlays")
- Content rules (e.g., "No em dashes, max 3 sentences per block")
- Technical constraints (e.g., "Vercel deploys take ~70s, not 20s")

3. Read existing `.slack-context/_learnings.md` from staging branch
4. Merge new learnings — strengthen signals that repeat, update contradictions
5. Commit updated learnings file

**File format:** `.slack-context/_learnings.md`
```markdown
# Agent Learnings
Last updated: [date]

## Codebase
- [date] Gallery component requires key prop on carousel items
- [date] Always use optional chaining on content.credits — some projects don't have it

## User Preferences
- [date] User prefers 8px grid spacing
- [date] Terse replies, no trailing summaries

## Project
- [date] Vercel deploys take ~70s for this project
- [date] Blue accent #1F78FF, dashed grid borders for card patterns
```

---

## Safety Guard (`/careful` + `/freeze` + `/guard`)

**Display name:** Safety Guard
**Triggers on:** auto — checks BEFORE committing any change
**Duration:** 2-5 seconds (fast gate)
**Can autofix:** N/A (blocks and asks)

**Execution steps:**
1. Before committing ANY change, check if the diff touches protected patterns:

**Protected by config:**
- Files in the `cannotModify` guardrails list from project config

**Protected by convention:**
- Database migrations or schema files
- Authentication/authorization logic
- Payment processing code
- Environment configuration (.env, secrets)
- CI/CD pipeline files
- Package manager lock files (unintentional changes)
- Server configuration (next.config, vercel.json)

2. If protected code is touched:
   a. STOP — do not commit
   b. Post warning in thread:
      ```
      ⚠️ *Protected code detected*
      
      This change touches: [file path] — [why it's protected]
      
      Options:
      - Reply `!and confirm` to proceed (change will be tagged [PROTECTED])
      - Reply `!and skip` to exclude this file
      - Reply `!and explain` for more details on what's being changed
      ```
   c. Wait for explicit confirmation
   d. If confirmed: proceed but tag commit message with [PROTECTED]
   e. If skipped: remove file from the commit

3. Never silently modify protected code, even if the user's original request implies it

---

## Browse (`/browse`)

**Display name:** Browse
**Triggers on:** on-demand
**Duration:** 10-60 seconds per action
**Can autofix:** N/A

**Execution steps:**
1. Launch or resume a persistent headless browser session via Browser Tool
2. Execute the user's request. Common operations:

**Navigation:** goto [URL], back, forward, reload
**Reading:** get page text, accessibility tree, list all forms, list all links, get HTML of a selector
**Interaction:** click [selector/text], fill [input] with [value], hover [element], type [text], scroll [direction], select [option], upload [file]
**Inspection:** read cookies, console logs, network requests, CSS computed values, localStorage, evaluate JavaScript
**Visual:** take screenshot, generate PDF, test responsive across viewports (320/768/1024/1440px)

3. Keep the session alive between requests in the same thread — don't restart the browser each time
4. Report findings with inline screenshots (Block Kit image blocks)
5. If a page requires authentication, suggest the Browser Cookies skill

**Output format:** Report with screenshots
```
Browse — [URL]

Action: [what was done]
Result: [what was observed]
📸 [screenshot]

[Follow-up suggestion if relevant]
```

---

## Browser Cookies (`/setup-browser-cookies`)

**Display name:** Browser Cookies
**Triggers on:** on-demand, when authenticated pages need testing
**Duration:** Interactive
**Can autofix:** N/A

**Execution steps:**
1. Ask the user how they want to provide cookies:
   - **Option A:** Export from browser DevTools (Application > Cookies > copy as JSON)
   - **Option B:** Provide login credentials and let the agent log in via Browser Tool
   - **Option C:** Use an existing cookie file from a previous session
2. If Option A: parse the cookie JSON, load into Browser Tool session
3. If Option B: navigate to the login page, fill credentials, submit, capture the resulting cookies
4. Verify authentication by visiting a protected page
5. Store a reference (NOT raw tokens) in `.slack-context/_browser-auth.md` noting which domains have auth set up
6. Report success/failure

**Security rules:**
- Never commit raw session tokens or passwords to git
- Only store a note that auth is configured for a domain
- Session cookies expire — the user may need to re-authenticate periodically

**Output format:** Summary
```
Browser Cookies — [domain]

✅ Authentication configured for [domain]
Verified: can access [protected page]
Session expires: [approximate expiry if known]

Other skills (QA, Canary Monitor, Browse) can now test authenticated pages.
```

---

## Connect Browser (`/connect-chrome`)

**Display name:** Connect Browser
**Triggers on:** on-demand, when headless browser can't handle CAPTCHAs or complex auth
**Duration:** Interactive
**Can autofix:** N/A

**Execution steps:**
1. Detect the user's OS and provide platform-specific instructions:
   - **macOS:** `open -a "Google Chrome" --args --remote-debugging-port=9222`
   - **Windows:** `chrome.exe --remote-debugging-port=9222`
   - **Linux:** `google-chrome --remote-debugging-port=9222`
2. Post instructions in Slack:
   ```
   I need a real browser for this (CAPTCHA/complex login). Steps:
   1. Run this command on your machine: [platform command]
   2. Complete the login/CAPTCHA in the Chrome window
   3. Reply `!and done` when you're past the auth screen
   ```
3. Wait for user confirmation
4. Connect Browser Tool to the running Chrome instance on port 9222
5. Take over automated testing from the authenticated session
6. When done, disconnect and return to headless mode
7. Capture any auth cookies for future use

**Output format:** Summary
```
Connect Browser — [domain]

Status: connected to headed Chrome
Auth: [logged in as X / CAPTCHA solved]
Cookies captured: [yes/no]

Switching back to headless mode. Future requests will use captured cookies.
```

---

## Setup Deploy (`/setup-deploy`)

**Display name:** Setup Deploy
**Triggers on:** on-demand, first-time setup
**Duration:** 10-20 seconds
**Can autofix:** N/A

**Execution steps:**
1. Read the project's root files from GitHub to detect the deploy platform:
   - `vercel.json` or `vercel.ts` → Vercel
   - `netlify.toml` → Netlify
   - `railway.json` or `railway.toml` → Railway
   - `Dockerfile` or `docker-compose.yml` → Docker/self-hosted
   - `.github/workflows/*.yml` → GitHub Actions (check for deploy steps)
   - `fly.toml` → Fly.io
   - `render.yaml` → Render
2. Read `package.json` for build/deploy scripts
3. Detect preview URL patterns:
   - Vercel: `{branch}--{project}.vercel.app`
   - Netlify: `deploy-preview-{number}--{site}.netlify.app`
   - Custom: check CI config for URL output patterns
4. Estimate deploy timing by platform (Vercel ~30-90s, Netlify ~60-120s, Docker ~120-300s)
5. Save findings to `config/project.json` under a `deploy` field
6. This helps Canary Monitor, screenshot timing, and Land & Deploy work correctly

**Output format:** Report
```
Deploy Setup — [project]

Platform: [Vercel/Netlify/etc.]
Build command: [detected command]
Deploy flow: [push-to-deploy / CI/CD / manual]
Preview URL pattern: [pattern]
Estimated deploy time: [Xs]
Production URL: [URL]

Saved to config/project.json.
```

---

## Second Opinion (`/codex`)

**Display name:** Second Opinion
**Triggers on:** on-demand
**Duration:** 20-40 seconds
**Can autofix:** No

**Execution steps:**
Determine mode from context:

**Review mode** (default after changes are made):
1. Re-read ALL changes in this thread from scratch
2. Forget the reasoning that led to these changes — evaluate fresh
3. Would you have made the same decisions? What would you do differently?
4. Check: are there simpler approaches? Over-engineering? Missing edge cases?

**Challenge mode** (when user asks "challenge this" or "find problems"):
1. Actively try to break the implementation
2. Think of edge cases: empty data, concurrent users, slow network, huge inputs, malicious inputs
3. Check for race conditions, memory leaks, security issues
4. Try to find UX problems: confusing flows, hidden states, accessibility gaps

**Consult mode** (when user presents a dilemma):
1. User describes two or more approaches
2. Present genuine pros/cons for each — don't anchor on what was already built
3. Consider: effort, risk, maintainability, user impact, technical debt
4. Make a recommendation but explain the trade-off

**Rules:**
- Be genuinely independent — don't rubber-stamp
- If the approach is solid, say so in one line and move on
- If there are real concerns, be specific: file, line, what's wrong, what to do instead

**Output format:** Report
```
Second Opinion — [review/challenge/consult]

Verdict: [solid / concerns / rethink]

[Mode-specific findings]

Recommendation: [specific action or "ship it"]
```

---

## Land & Deploy (`/land-and-deploy`)

**Display name:** Land & Deploy
**Triggers on:** on-demand or suggested before important merges
**Duration:** 120-300 seconds (waits for CI and deploy)
**Can autofix:** No

**Execution steps:**

This is the "careful merge" — more thorough than basic `!merge`.

1. **Pre-flight checks:**
   - Read all changes on staging branch since it diverged from main
   - Run Ship Check (if enabled) — PR quality, test coverage, changelog
   - Run Security Scan (if enabled) — last check before production

2. **Create PR:**
   - Generate PR title and description from thread context
   - Include: summary of changes, screenshots, test results, skill findings
   - Create PR via GitHub API

3. **Wait for CI:**
   - Poll GitHub status checks every 15 seconds
   - If checks fail: report the failure in thread, suggest fixes, do NOT merge
   - If checks pass: proceed

4. **Merge:**
   - Merge PR via GitHub API (merge commit, not squash — preserve history)
   - Do NOT delete the staging branch

5. **Wait for deploy:**
   - Use deploy timing from `config/project.json` (or default 90s)
   - Post progress: "Deploying to production..."

6. **Verify production:**
   - Run Canary Monitor (if enabled) — visit key routes, check for errors
   - Take production screenshots
   - If canary fails: immediately alert in thread AND channel, suggest rollback

7. **Announce:**
   - Post success to channel (not just thread)
   - Include: what shipped, PR link, production URL, screenshots

**Output format:** Checklist
```
Land & Deploy — [project]

✅ PR created: [link]
✅ CI checks passed (3/3)
✅ Merged to main
✅ Deploy complete (82s)
✅ Canary: 4/4 pages healthy
✅ Announced in channel

Production: [URL]
```
