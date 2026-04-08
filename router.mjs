// Demo: main branch test push
/**
 * Project Router — GitHub is the source of truth.
 *
 * projects.json lists repos to watch. Each repo has a .memeticco/ directory
 * with config (project.json, roles.json, system-prompt.md, etc.).
 *
 * On start: clones repos, reads .memeticco/ for config.
 * Hot-reload: watches projects.json for changes.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "projects.json");
const REPOS_DIR = path.join(__dirname, "repos");

const channelMap = new Map();
const projectConfigs = new Map();

// --- Safe git ---
function git(args, opts = {}) {
  const result = spawnSync("git", args, { stdio: "pipe", encoding: "utf8", timeout: 60000, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.slice(0, 200) || `git ${args[0]} failed`);
  return result.stdout?.trim() || "";
}
function gitSafe(args, opts = {}) {
  try { return git(args, opts); } catch { return null; }
}

// --- Repo cleanup ---
export function cleanRepo(repoDir) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return;
  const lockFile = path.join(repoDir, ".git", "index.lock");
  if (fs.existsSync(lockFile)) { fs.unlinkSync(lockFile); console.log(`[repo] Removed stale index.lock`); }
  gitSafe(["checkout", "--", "."], { cwd: repoDir });
  gitSafe(["clean", "-fd"], { cwd: repoDir });
}

// --- Clone / sync ---
function syncRepo(name, repoFullName, branch) {
  const repoDir = path.join(REPOS_DIR, name);
  const [owner, repo] = repoFullName.split("/");
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const token = process.env.GITHUB_TOKEN;
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  try {
    if (fs.existsSync(path.join(repoDir, ".git"))) {
      console.log(`[repo] ${name}: syncing...`);
      cleanRepo(repoDir);
      gitSafe(["fetch", "--all"], { cwd: repoDir, env: gitEnv });
      if (gitSafe(["checkout", branch], { cwd: repoDir }) === null) {
        gitSafe(["checkout", "-b", branch, `origin/${branch}`], { cwd: repoDir });
      }
      if (gitSafe(["pull", "--ff-only"], { cwd: repoDir, env: gitEnv }) === null) {
        console.log(`[repo] ${name}: diverged, resetting to origin/${branch}`);
        gitSafe(["reset", "--hard", `origin/${branch}`], { cwd: repoDir });
      }
      const current = gitSafe(["branch", "--show-current"], { cwd: repoDir }) || "unknown";
      console.log(`[repo] ${name}: on ${current}, synced`);
    } else {
      console.log(`[repo] ${name}: cloning ${repoUrl}...`);
      fs.mkdirSync(REPOS_DIR, { recursive: true });
      const cloneArgs = ["clone"];
      if (token) cloneArgs.push("-c", `http.extraheader=Authorization: Bearer ${token}`);
      cloneArgs.push(repoUrl, repoDir);
      git(cloneArgs, { env: gitEnv });
      if (gitSafe(["checkout", branch], { cwd: repoDir }) === null) {
        gitSafe(["checkout", "-b", branch, `origin/${branch}`], { cwd: repoDir });
      }
      console.log(`[repo] ${name}: cloned`);
    }
    return repoDir;
  } catch (err) {
    console.error(`[repo] ${name}: failed — ${err.message?.slice(0, 80)}`);
    return null;
  }
}

// --- Read config from .memeticco/ inside repo ---
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function loadProjectFromRepo(name, repoDir, channelName, repoFullName) {
  const mDir = path.join(repoDir, ".memeticco");
  const [owner, repo] = repoFullName.split("/");

  // Read config from .memeticco/ (or use defaults)
  const project = readJson(path.join(mDir, "project.json")) || {};
  const roles = readJson(path.join(mDir, "roles.json")) || { users: { owners: [], editors: [], contributors: [], viewers: [] } };
  const pipeline = readJson(path.join(mDir, "pipeline.json")) || { steps: [] };
  const skills = readJson(path.join(mDir, "skills.json")) || { skills: {} };

  let systemPrompt = "You are memeticco, an AI design engineer.";
  try {
    const promptPath = path.join(mDir, "system-prompt.md");
    if (fs.existsSync(promptPath)) systemPrompt = fs.readFileSync(promptPath, "utf8");
  } catch {}

  // Clean Claude Code directives from system prompt
  systemPrompt = systemPrompt
    .replace(/Do NOT use Rube.*?<<<NEXT_MESSAGE>>> delimiter\./gs, "")
    .replace(/Use Rube MCP for GitHub.*?screenshots\)./gs, "")
    .replace(/<<<NEXT_MESSAGE>>>|<<<CHANNEL>>>/g, "");

  const ghBranch = project.github?.stagingBranch || "agent-changes";
  const ghMainBranch = project.github?.branch || "main";

  return {
    id: name,
    dir: mDir,
    repoDir,
    channel: channelName,
    channelId: null,
    github: { owner, repo, branch: ghBranch, mainBranch: ghMainBranch },
    localRepoPath: repoDir,
    urls: project.urls || {},
    guardrails: project.guardrails || {},
    project: project.project || { name: repo },
    roles, pipeline, skills, systemPrompt,
    devPort: null,      // assigned on startup
    devProcess: null,   // child process for npm run dev
  };
}

// --- Load all projects from registry ---
export function loadAllProjects() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.log("[router] No projects.json found");
    return;
  }

  let registry;
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); }
  catch (err) { console.error("[router] Invalid projects.json:", err.message); return; }

  let loaded = 0;
  for (const entry of registry) {
    if (!entry.name || !entry.repo || !entry.channel) {
      console.error(`[router] Skipping invalid entry:`, entry);
      continue;
    }

    // Determine branch from existing .memeticco/project.json or default
    const repoDir = path.join(REPOS_DIR, entry.name);
    let branch = "agent-changes";
    const existingConfig = readJson(path.join(repoDir, ".memeticco", "project.json"));
    if (existingConfig?.github?.stagingBranch) branch = existingConfig.github.stagingBranch;

    // Clone/sync
    const clonedDir = syncRepo(entry.name, entry.repo, branch);
    if (!clonedDir) continue;

    // Ensure .memeticco/ exists in the repo
    const mDir = path.join(clonedDir, ".memeticco");
    if (!fs.existsSync(mDir)) {
      console.log(`[router] ${entry.name}: no .memeticco/ in repo — creating scaffold`);
      fs.mkdirSync(mDir, { recursive: true });
      // Write minimal config
      fs.writeFileSync(path.join(mDir, "project.json"), JSON.stringify({
        project: { name: entry.repo.split("/")[1] },
        github: { owner: entry.repo.split("/")[0], repo: entry.repo.split("/")[1], branch: "main", stagingBranch: branch },
        slack: { channel: entry.channel },
        urls: {},
        guardrails: { canModify: ["*"], cannotModify: ["package.json", ".env*"] },
      }, null, 2));
      fs.writeFileSync(path.join(mDir, "roles.json"), JSON.stringify({
        users: { owners: [], editors: [], contributors: [], viewers: [] },
      }, null, 2));
      fs.writeFileSync(path.join(mDir, "system-prompt.md"),
`You are memeticco. Senior dev and designer. Ship fast.
No em dashes. Slack mrkdwn (*bold*, \`code\`). Brevity first.`);
      // Commit and push the scaffold
      gitSafe(["add", ".memeticco/"], { cwd: clonedDir });
      gitSafe(["commit", "-m", "[memeticco] initialize bot config"], { cwd: clonedDir });
      gitSafe(["push", "origin", branch], { cwd: clonedDir });
      console.log(`[router] ${entry.name}: pushed .memeticco/ scaffold to ${branch}`);
    }

    // Ensure 00-05 folder structure exists
    for (const dir of ["00-discovery", "01-research", "02-strategy", "03-design", "05-deploy"]) {
      const d = path.join(clonedDir, dir);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    // Generate PROJECT.md if missing
    if (!fs.existsSync(path.join(clonedDir, "PROJECT.md"))) {
      const [owner, repo] = entry.repo.split("/");
      fs.writeFileSync(path.join(clonedDir, "PROJECT.md"), `# ${repo}\n\nManaged by memeticco.\n`);
    }

    // Copy .claude/settings.local.json so Claude Code has Rube MCP access in this repo
    const agentSettings = path.join(__dirname, ".claude", "settings.local.json");
    if (fs.existsSync(agentSettings)) {
      const repoClaudeDir = path.join(clonedDir, ".claude");
      fs.mkdirSync(repoClaudeDir, { recursive: true });
      fs.copyFileSync(agentSettings, path.join(repoClaudeDir, "settings.local.json"));
    }

    const config = loadProjectFromRepo(entry.name, clonedDir, entry.channel, entry.repo);
    if (config) { projectConfigs.set(config.id, config); loaded++; }
  }

  console.log(`[router] Loaded ${loaded} project(s)`);
  projectConfigs.forEach(p => console.log(`[router]   ${p.id}: #${p.channel} → ${p.github.owner}/${p.github.repo}`));
}

// --- Channel resolution (paginated) ---
export async function resolveChannelIds(slack) {
  try {
    let allChannels = [];
    let cursor;
    do {
      const result = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000, cursor });
      allChannels.push(...(result.channels || []));
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    for (const [id, config] of projectConfigs) {
      const ch = allChannels.find(c => c.name === config.channel);
      if (ch) {
        config.channelId = ch.id;
        channelMap.set(ch.id, config);
        console.log(`[router] ${config.id}: #${config.channel} → ${ch.id}`);
      } else {
        console.error(`[router] ${config.id}: #${config.channel} not found`);
      }
    }
  } catch (err) {
    console.error("[router] Channel resolution failed:", err.message);
  }
}

export function getProjectByChannel(channelId) { return channelMap.get(channelId) || null; }
export function getProject(projectId) { return projectConfigs.get(projectId) || null; }
export function getAllProjects() { return [...projectConfigs.values()]; }

// --- Hot reload: watch projects.json ---
export function watchProjects(slack) {
  let debounceTimer = null;
  try {
    fs.watch(REGISTRY_PATH, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log("[router] projects.json changed — reloading");
        channelMap.clear();
        projectConfigs.clear();
        loadAllProjects();
        await resolveChannelIds(slack);
      }, 2000);
    });
  } catch {}
  console.log("[router] Watching projects.json for changes");
}

export function getUserRole(projectConfig, userId) {
  const users = projectConfig.roles?.users || {};
  if (users.owners?.includes(userId)) return "owner";
  if (users.editors?.includes(userId)) return "editor";
  if (users.contributors?.includes(userId)) return "contributor";
  return "viewer";
}

export function buildSystemPrompt(projectConfig, userId) {
  const role = getUserRole(projectConfig, userId);
  const gh = projectConfig.github;
  return projectConfig.systemPrompt + `

## Current User
- ID: ${userId}, Role: ${role}
- Project: ${gh.owner}/${gh.repo}, Channel: #${projectConfig.channel}

## Rules
- Commits go to staging (\`${gh.branch}\`) only. Never main.
- Merge requires owner. You are: ${role}.
${role !== "owner" ? "- This user CANNOT merge." : "- This user CAN merge."}
- Read files from disk (local repo). No API needed for file reads.
- NEVER use Rube Slack tools. Output goes to Slack automatically.`;
}
