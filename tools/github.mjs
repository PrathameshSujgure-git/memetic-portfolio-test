import { Octokit } from "@octokit/rest";
import { getCache, setCache } from "../context/cache.mjs";
import { withBranchLock } from "../queue.mjs";

let octokit;
let projectConfig;

export function initGitHub(config) {
  octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  projectConfig = config;
  return octokit;
}

function defaults() {
  return {
    owner: projectConfig.github.owner,
    repo: projectConfig.github.repo,
    branch: projectConfig.github.stagingBranch || "agent-changes",
    mainBranch: projectConfig.github.branch || "main",
  };
}

// Tool definitions for Claude
export const githubTools = [
  {
    name: "read_file",
    description:
      "Read a file from the GitHub repo. Returns content truncated to 200 lines. Use read_file_range for specific sections.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path in the repo (e.g. 'components/Hero.tsx')" },
        branch: { type: "string", description: "Branch to read from (defaults to staging branch)" },
      },
      required: ["path"],
    },
    requires_confirmation: false,
    timeout_ms: 15000,
  },
  {
    name: "read_file_range",
    description: "Read specific lines from a file. Use when you need a focused section.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path in the repo" },
        start_line: { type: "number", description: "First line to read (1-indexed)" },
        end_line: { type: "number", description: "Last line to read" },
        branch: { type: "string", description: "Branch (defaults to staging)" },
      },
      required: ["path", "start_line", "end_line"],
    },
    requires_confirmation: false,
    timeout_ms: 15000,
  },
  {
    name: "list_files",
    description: "List files in a directory of the repo",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (e.g. 'components/' or '')" },
        branch: { type: "string", description: "Branch (defaults to staging)" },
      },
      required: ["path"],
    },
    requires_confirmation: false,
    timeout_ms: 10000,
  },
  {
    name: "commit_files",
    description:
      "Commit one or more files atomically to the staging branch. Uses Git Trees API for multi-file atomic commits.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              content: { type: "string", description: "Full file content" },
            },
            required: ["path", "content"],
          },
          description: "Files to commit",
        },
        message: { type: "string", description: "Commit message" },
      },
      required: ["files", "message"],
    },
    requires_confirmation: true,
    timeout_ms: 30000,
  },
  {
    name: "create_pr",
    description: "Create a pull request from staging branch to main",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description (markdown)" },
      },
      required: ["title", "body"],
    },
    requires_confirmation: true,
    timeout_ms: 15000,
  },
  {
    name: "merge_pr",
    description: "Merge a pull request",
    input_schema: {
      type: "object",
      properties: {
        pr_number: { type: "number", description: "PR number to merge" },
      },
      required: ["pr_number"],
    },
    requires_confirmation: true,
    timeout_ms: 15000,
  },
  {
    name: "get_diff",
    description: "Get a summary of changes between staging and main branches",
    input_schema: {
      type: "object",
      properties: {},
    },
    requires_confirmation: false,
    timeout_ms: 15000,
  },
];

// Tool executors
export async function executeTool(name, input) {
  const d = defaults();

  switch (name) {
    case "read_file": {
      const branch = input.branch || d.branch;
      const cacheKey = `${branch}:${input.path}`;
      const cached = getCache(cacheKey);
      if (cached) return cached;

      try {
        const res = await octokit.repos.getContent({
          owner: d.owner, repo: d.repo, path: input.path, ref: branch,
        });
        const content = Buffer.from(res.data.content, "base64").toString("utf8");
        const lines = content.split("\n");
        const truncated = lines.length > 200
          ? lines.slice(0, 200).join("\n") + `\n\n[Truncated: ${lines.length} total lines. Use read_file_range for more.]`
          : content;
        const result = JSON.stringify({ path: input.path, lines: lines.length, content: truncated, sha: res.data.sha });
        setCache(cacheKey, result);
        return result;
      } catch (err) {
        if (err.status === 404) {
          // Try main branch as fallback
          try {
            const res = await octokit.repos.getContent({
              owner: d.owner, repo: d.repo, path: input.path, ref: d.mainBranch,
            });
            const content = Buffer.from(res.data.content, "base64").toString("utf8");
            const lines = content.split("\n");
            const truncated = lines.length > 200
              ? lines.slice(0, 200).join("\n") + `\n\n[Truncated: ${lines.length} total lines.]`
              : content;
            return JSON.stringify({ path: input.path, lines: lines.length, content: truncated, sha: res.data.sha, branch: d.mainBranch });
          } catch {
            return JSON.stringify({ error: `File not found: ${input.path}` });
          }
        }
        return JSON.stringify({ error: err.message });
      }
    }

    case "read_file_range": {
      const branch = input.branch || d.branch;
      try {
        const res = await octokit.repos.getContent({
          owner: d.owner, repo: d.repo, path: input.path, ref: branch,
        });
        const content = Buffer.from(res.data.content, "base64").toString("utf8");
        const lines = content.split("\n");
        const slice = lines.slice(input.start_line - 1, input.end_line);
        return JSON.stringify({
          path: input.path,
          start_line: input.start_line,
          end_line: input.end_line,
          total_lines: lines.length,
          content: slice.join("\n"),
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case "list_files": {
      const branch = input.branch || d.branch;
      try {
        const res = await octokit.repos.getContent({
          owner: d.owner, repo: d.repo, path: input.path || "", ref: branch,
        });
        const items = Array.isArray(res.data) ? res.data : [res.data];
        const listing = items.map((f) => ({ name: f.name, type: f.type, path: f.path }));
        return JSON.stringify(listing);
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case "commit_files": {
      return withBranchLock(d.branch, async () => {
        try {
          // Get latest commit SHA on staging branch
          const ref = await octokit.git.getRef({
            owner: d.owner, repo: d.repo, ref: `heads/${d.branch}`,
          });
          const latestCommitSha = ref.data.object.sha;

          // Get the tree of the latest commit
          const commit = await octokit.git.getCommit({
            owner: d.owner, repo: d.repo, commit_sha: latestCommitSha,
          });
          const baseTreeSha = commit.data.tree.sha;

          // Create blobs for each file
          const treeItems = [];
          for (const file of input.files) {
            const blob = await octokit.git.createBlob({
              owner: d.owner, repo: d.repo,
              content: Buffer.from(file.content).toString("base64"),
              encoding: "base64",
            });
            treeItems.push({
              path: file.path,
              mode: "100644",
              type: "blob",
              sha: blob.data.sha,
            });
          }

          // Create new tree
          const newTree = await octokit.git.createTree({
            owner: d.owner, repo: d.repo,
            tree: treeItems,
            base_tree: baseTreeSha,
          });

          // Create commit
          const newCommit = await octokit.git.createCommit({
            owner: d.owner, repo: d.repo,
            message: input.message,
            tree: newTree.data.sha,
            parents: [latestCommitSha],
          });

          // Update branch ref
          await octokit.git.updateRef({
            owner: d.owner, repo: d.repo,
            ref: `heads/${d.branch}`,
            sha: newCommit.data.sha,
          });

          // Invalidate cache for committed files
          for (const file of input.files) {
            setCache(`${d.branch}:${file.path}`, null);
          }

          const url = `https://github.com/${d.owner}/${d.repo}/commit/${newCommit.data.sha}`;
          return JSON.stringify({ ok: true, sha: newCommit.data.sha, url });
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      });
    }

    case "create_pr": {
      try {
        const pr = await octokit.pulls.create({
          owner: d.owner, repo: d.repo,
          title: input.title,
          body: input.body,
          head: d.branch,
          base: d.mainBranch,
        });
        return JSON.stringify({ ok: true, number: pr.data.number, url: pr.data.html_url });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case "merge_pr": {
      try {
        const result = await octokit.pulls.merge({
          owner: d.owner, repo: d.repo,
          pull_number: input.pr_number,
          merge_method: "merge",
        });
        return JSON.stringify({ ok: true, sha: result.data.sha });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case "get_diff": {
      try {
        const diff = await octokit.repos.compareCommits({
          owner: d.owner, repo: d.repo,
          base: d.mainBranch,
          head: d.branch,
        });
        const summary = (diff.data.files || []).map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        }));
        return JSON.stringify({
          ahead_by: diff.data.ahead_by,
          files_changed: summary.length,
          files: summary,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown github tool: ${name}` });
  }
}
