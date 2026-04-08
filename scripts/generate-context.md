# Generate Codebase Context

You are generating CODEBASE.md and CODEBASE-DEEP.md for a project so the Memetic Agent understands it.

## Step 1: Read config
Read `config/project.json` from the current directory to get:
- `github.owner` and `github.repo` — the target repo
- `github.branch` — which branch to scan
- `project.stack` — the tech stack
- `guardrails` — what can/cannot be modified

## Step 2: Scan the repo via GitHub
Use Rube's GITHUB_GET_REPOSITORY_CONTENT to read:
- Root directory listing (file tree)
- `package.json` for dependencies and scripts
- Key config files (next.config.*, tsconfig.json, tailwind.config.*)
- Components directory listing
- Pages/app directory listing
- Any existing README.md

## Step 3: Generate CODEBASE.md
Create a file with:
- Stack summary
- File structure (tree format, exclude node_modules/.next/dist)
- Key components: name, what they do, key props
- Pages/routes: path, what renders, data sources
- Content schema (if JSON-based CMS)
- Design tokens/CSS variables
- Typography system
- How to add new pages/components

Keep it under 150 lines. This is read every session (~4000 tokens budget).

## Step 4: Generate CODEBASE-DEEP.md
Create a file with exact code patterns:
- Common class combinations (Tailwind patterns)
- Component rendering logic
- Data flow (content → page → component)
- How themes work
- Key breakpoints
- API routes

Keep it under 160 lines (~4000 tokens budget).

## Step 5: Commit both files
Use GITHUB_COMMIT_MULTIPLE_FILES to commit both files to the target repo's default branch.

## Step 6: Confirm
Print what was generated and which files were committed.
