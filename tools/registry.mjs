import * as slackTools from "./slack.mjs";
import * as githubTools from "./github.mjs";
import * as browserTools from "./browser.mjs";

// Collect all tool definitions
const toolModules = {
  slack: slackTools,
  github: githubTools,
  browser: browserTools,
};

// Build registry: name → { definition, executor, module }
const registry = new Map();

export function buildRegistry() {
  for (const [moduleName, mod] of Object.entries(toolModules)) {
    const defs =
      mod.slackTools || mod.githubTools || mod.browserTools || [];
    for (const def of defs) {
      registry.set(def.name, {
        definition: def,
        executor: mod.executeTool,
        module: moduleName,
      });
    }
  }
  console.log(`[registry] ${registry.size} tools registered`);
}

// Get tool definitions for Claude API (just the schema part)
export function getToolDefinitions() {
  return Array.from(registry.values()).map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    input_schema: t.definition.input_schema,
  }));
}

// Execute a tool by name with timeout
export async function executeTool(name, input) {
  const tool = registry.get(name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  const timeout = tool.definition.timeout_ms || 30000;

  try {
    const result = await Promise.race([
      tool.executor(name, input),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tool ${name} timed out after ${timeout}ms`)), timeout)
      ),
    ]);
    return result;
  } catch (err) {
    return JSON.stringify({ error: `Tool ${name} failed: ${err.message}` });
  }
}

// Check if a tool requires confirmation before executing
export function requiresConfirmation(name) {
  const tool = registry.get(name);
  return tool?.definition.requires_confirmation || false;
}

// Get a tool's definition
export function getTool(name) {
  return registry.get(name) || null;
}
