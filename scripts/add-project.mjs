#!/usr/bin/env node

/**
 * Add a new project to memeticco.
 *
 * 1. Adds entry to projects.json (bot registry)
 * 2. Clones the repo
 * 3. Creates .memeticco/ config + 00-05 folders in the repo
 * 4. Pushes to GitHub
 *
 * The listener auto-detects changes to projects.json (hot-reload).
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "projects.json");
const REPOS_DIR = path.join(ROOT, "repos");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

console.log(`
╔══════════════════════════════════════════════╗
║          Add Project to Memeticco            ║
╠══════════════════════════════════════════════╣
║  Adds to projects.json + creates .memeticco/ ║
║  in the GitHub repo. Auto-detected by bot.   ║
╚══════════════════════════════════════════════╝
`);

async function main() {
  const projectName = (await ask("Project name (short, no spaces): ")).trim().toLowerCase().replace(/\s+/g, "-");
  if (!projectName) { console.error("Name required"); process.exit(1); }

  const repoUrl = await ask("GitHub repo URL: ");
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s.]+)/);
  if (!match) { console.error("Invalid GitHub URL"); process.exit(1); }
  const [, owner, repo] = match;
  const repoFullName = `${owner}/${repo}`;

  const channel = await ask("Slack channel name (without #): ");
  if (!channel.trim()) { console.error("Channel required"); process.exit(1); }

  const defaultBranch = (await ask("Default branch [main]: ")) || "main";
  const stagingBranch = (await ask("Staging branch [agent-changes]: ")) || "agent-changes";
  const productionUrl = await ask("Production URL: ");
  const stagingUrl = await ask("Staging URL: ");
  const stack = await ask("Tech stack: ");
  const description = await ask("One-line description: ");
  const canModify = ((await ask("Modifiable files [*]: ")) || "*").split(",").map(s => s.trim());
  const cannotModify = ((await ask("Protected files [package.json,.env*]: ")) || "package.json,.env*").split(",").map(s => s.trim());
  const ownerIds = (await ask("Owner Slack user ID(s): ")).split(",").map(s => s.trim()).filter(Boolean);
  const editorIds = (await ask("Editor Slack user ID(s) (or enter): ")).split(",").map(s => s.trim()).filter(Boolean);

  // 1. Add to projects.json
  let registry = [];
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); } catch {}
  if (registry.some(e => e.name === projectName)) {
    console.error(`Project "${projectName}" already exists in projects.json`);
    process.exit(1);
  }
  registry.push({ name: projectName, repo: repoFullName, channel });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(`\n✅ Added to projects.json`);

  // 2. Clone the repo
  const repoDir = path.join(REPOS_DIR, projectName);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    console.log(`Cloning ${repoFullName}...`);
    fs.mkdirSync(REPOS_DIR, { recursive: true });
    const token = process.env.GITHUB_TOKEN;
    const cloneArgs = ["clone"];
    if (token) cloneArgs.push("-c", `http.extraheader=Authorization: Bearer ${token}`);
    cloneArgs.push(`https://github.com/${owner}/${repo}.git`, repoDir);
    spawnSync("git", cloneArgs, { stdio: "inherit" });
  }

  // Checkout staging branch
  spawnSync("git", ["checkout", stagingBranch], { cwd: repoDir, stdio: "pipe" });
  if (spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout?.trim() !== stagingBranch) {
    spawnSync("git", ["checkout", "-b", stagingBranch], { cwd: repoDir, stdio: "pipe" });
  }

  // 3. Create .memeticco/ in the repo
  const mDir = path.join(repoDir, ".memeticco");
  fs.mkdirSync(mDir, { recursive: true });

  fs.writeFileSync(path.join(mDir, "project.json"), JSON.stringify({
    project: { name: repo, description, stack },
    github: { owner, repo, branch: defaultBranch, stagingBranch },
    slack: { channel },
    urls: { staging: stagingUrl, production: productionUrl },
    guardrails: { canModify, cannotModify, copyRules: [], designGuidelines: [] },
  }, null, 2) + "\n");

  fs.writeFileSync(path.join(mDir, "roles.json"), JSON.stringify({
    users: { owners: ownerIds, editors: editorIds, contributors: [], viewers: [] },
  }, null, 2) + "\n");

  fs.writeFileSync(path.join(mDir, "pipeline.json"), JSON.stringify({
    steps: [
      { name: "design-check", prompt: "Review visual change against design system.", required: true, autofix: false },
      { name: "code-hygiene", prompt: "Check for unused imports, console.logs, hardcoded values.", required: true, autofix: true },
      { name: "bug-check", prompt: "Check for null refs, missing fallbacks, responsive issues.", required: true, autofix: true },
    ],
  }, null, 2) + "\n");

  fs.writeFileSync(path.join(mDir, "system-prompt.md"),
`You are memeticco. Senior dev and designer for ${repo}. Ship fast.

## Project
- ${description}
- Stack: ${stack}
- Production: ${productionUrl}
- Staging: ${stagingUrl}

## Personality
Punchy and concise. No em dashes. No oxford commas. Brevity first.
Slack mrkdwn: *bold*, _italic_, \`code\`, <url|text>.

## Guardrails
Can modify: ${canModify.join(", ")}
Protected: ${cannotModify.join(", ")}
`);

  // 4. Create 00-05 folder structure
  for (const dir of ["00-discovery", "01-research", "02-strategy", "03-design", "05-deploy"]) {
    const d = path.join(repoDir, dir);
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, ".gitkeep"), "");
    }
  }

  // PROJECT.md at repo root
  if (!fs.existsSync(path.join(repoDir, "PROJECT.md"))) {
    fs.writeFileSync(path.join(repoDir, "PROJECT.md"), `# ${repo}

## Overview
${description}

## Stack
${stack}

## URLs
- Production: ${productionUrl}
- Staging: ${stagingUrl}

## Repo
- GitHub: ${owner}/${repo}
- Main: ${defaultBranch}
- Staging: ${stagingBranch}
- Channel: #${channel}
`);
  }

  // 5. Commit and push
  console.log(`\nCommitting .memeticco/ + folder structure...`);
  spawnSync("git", ["add", ".memeticco/", "00-discovery/", "01-research/", "02-strategy/", "03-design/", "05-deploy/", "PROJECT.md"], { cwd: repoDir, stdio: "pipe" });
  spawnSync("git", ["commit", "-m", "[memeticco] initialize project structure and bot config"], { cwd: repoDir, stdio: "pipe" });
  const pushResult = spawnSync("git", ["push", "origin", stagingBranch], { cwd: repoDir, stdio: "inherit" });

  if (pushResult.status === 0) {
    console.log(`✅ Pushed to ${repoFullName} on ${stagingBranch}`);
  } else {
    console.log(`⚠️ Push failed. You may need to push manually: cd repos/${projectName} && git push origin ${stagingBranch}`);
  }

  console.log(`
╔══════════════════════════════════════════════╗
║              Project Added!                  ║
╠══════════════════════════════════════════════╣
║                                              ║
║  Repo structure:                             ║
║    ${repoFullName.padEnd(40)}║
║    ├── .memeticco/  ← bot config             ║
║    ├── 00-discovery/                         ║
║    ├── 01-research/                          ║
║    ├── 02-strategy/                          ║
║    ├── 03-design/                            ║
║    ├── 05-deploy/                            ║
║    └── PROJECT.md                            ║
║                                              ║
║  Bot auto-detects via projects.json          ║
║  (hot-reload, no restart needed)             ║
║                                              ║
╚══════════════════════════════════════════════╝
`);

  rl.close();
}

main().catch(console.error);
