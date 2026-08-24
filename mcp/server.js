#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const toolkitRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(toolkitRoot, "cli.js");
const repoRoot = resolve(process.env.GIT_SYNC_REPO_ROOT || process.cwd());
const timeoutMs = Number(process.env.GIT_SYNC_MCP_TIMEOUT_MS || 120000);
const confirmations = new Map();

const stringProperty = { type: "string", minLength: 1 };

function run(args, cwd = repoRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Toolkit command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Toolkit command exited with ${code}`));
        return;
      }
      try { resolvePromise(JSON.parse(stdout)); }
      catch { reject(new Error("Toolkit returned invalid JSON")); }
    });
  });
}

function result(data, confirmation) {
  return { content: [{ type: "text", text: JSON.stringify(confirmation ? { ...data, confirmation } : data, null, 2) }] };
}
function requestKey(name, args) {
  const copy = { ...args };
  delete copy.apply;
  delete copy.confirmation;
  return JSON.stringify([name, copy]);
}
function mutating(name, args) {
  return ["sync_refresh", "sync_cleanup", "sync_copy_worktree", "sync_delete_branch", "sync_restore_backup", "sync_publish"].includes(name) && args.apply === true;
}
function issueConfirmation(name, args, data) {
  const token = randomBytes(18).toString("base64url");
  confirmations.set(token, { key: requestKey(name, args), preview: data, expires: Date.now() + 10 * 60 * 1000 });
  return token;
}

const tools = [
  {
    name: "sync_list_worktrees",
    description: "List Git worktrees for the configured repository.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_analyze",
    description: "Preview synchronization differences without modifying Git state.",
    inputSchema: { type: "object", properties: { target: stringProperty, worktree: stringProperty } },
  },
  {
    name: "sync_refresh",
    description: "Preview or apply a worktree refresh from a remote ref. Apply requires explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: { remoteRef: stringProperty, worktree: stringProperty, apply: { type: "boolean" }, confirmation: stringProperty, autoAcceptIncoming: { type: "boolean" }, continue: { type: "boolean" } },
    },
  },
  {
    name: "sync_cleanup",
    description: "Preview or apply a cleanup plan. Apply requires explicit confirmation.",
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: { plan: stringProperty, worktree: stringProperty, apply: { type: "boolean" }, confirmation: stringProperty, continue: { type: "boolean" }, autoAcceptIncoming: { type: "boolean" } },
    },
  },
  {
    name: "sync_validate_publish",
    description: "Run configured validation and capture publish state without pushing.",
    inputSchema: { type: "object", properties: { branch: stringProperty, worktree: stringProperty } },
  },
  {
    name: "sync_publish",
    description: "Publish a previously validated branch. Requires explicit confirmation.",
    inputSchema: { type: "object", properties: { branch: stringProperty, worktree: stringProperty, apply: { type: "boolean" }, confirmation: stringProperty } },
  },
  {
    name: "sync_copy_worktree",
    description: "Preview or create a new branch and worktree from a source branch.",
    inputSchema: { type: "object", required: ["source", "target"], properties: { source: stringProperty, target: stringProperty, worktree: stringProperty, apply: { type: "boolean" }, confirmation: stringProperty } },
  },
  {
    name: "sync_delete_branch",
    description: "Preview or delete a local branch, optionally removing its associated worktree.",
    inputSchema: { type: "object", required: ["branch"], properties: { branch: stringProperty, worktree: { type: "boolean" }, force: { type: "boolean" }, apply: { type: "boolean" }, confirmation: stringProperty } },
  },
  {
    name: "sync_list_backups",
    description: "List local recovery backups.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_restore_backup",
    description: "Preview or restore a branch from a local recovery backup.",
    inputSchema: { type: "object", required: ["backup"], properties: { backup: stringProperty, worktree: stringProperty, apply: { type: "boolean" }, confirmation: stringProperty } },
  },
];

const server = new Server({ name: "git-sync-toolkit", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments || {};
  try {
    if (mutating(request.params.name, args)) {
      const entry = confirmations.get(args.confirmation);
      if (!entry || entry.expires < Date.now() || entry.key !== requestKey(request.params.name, args)) {
        throw new Error("Invalid or expired confirmation; run the same operation in preview mode first");
      }
      confirmations.delete(args.confirmation);
    }
    if (request.params.name === "sync_list_worktrees") {
      return result({ worktrees: parseWorktrees(await runGit(["worktree", "list", "--porcelain"])) });
    }
    const cliArgs = [];
    if (request.params.name === "sync_analyze") {
      cliArgs.push("analyze", args.target || "upstream/master");
    } else if (request.params.name === "sync_refresh") {
      cliArgs.push("refresh");
      if (args.remoteRef) cliArgs.push("--remoteRef", args.remoteRef);
      if (args.continue) cliArgs.push("--continue");
      if (args.autoAcceptIncoming) cliArgs.push("--auto-accept-incoming");
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_cleanup") {
      cliArgs.push("cleanup", "--plan", args.plan);
      if (args.continue) cliArgs.push("--continue");
      if (args.autoAcceptIncoming) cliArgs.push("--auto-accept-incoming");
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_validate_publish") {
      cliArgs.push("publish", "--validate");
      if (args.branch) cliArgs.push("--branch", args.branch);
    } else if (request.params.name === "sync_publish") {
      cliArgs.push("publish");
      if (args.branch) cliArgs.push("--branch", args.branch);
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_copy_worktree") {
      cliArgs.push("copy", "--source", args.source, "--target", args.target);
      if (args.worktree && !["sync_copy_worktree", "sync_delete_branch", "sync_restore_backup"].includes(request.params.name)) {
        cliArgs.push("--worktree", args.worktree);
      }
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_delete_branch") {
      cliArgs.push("delete", "--delete", args.branch);
      if (args.worktree) cliArgs.push("--worktree");
      if (args.force) cliArgs.push("--force");
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_list_backups") {
      cliArgs.push("backup", "--list");
    } else if (request.params.name === "sync_restore_backup") {
      cliArgs.push("restore", "--backup", args.backup);
      if (args.worktree) cliArgs.push("--worktree", args.worktree);
      if (args.apply) cliArgs.push("--apply");
    } else {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    if (args.worktree) cliArgs.push("--worktree", args.worktree);
    const data = await run(cliArgs);
    if (["sync_refresh", "sync_cleanup", "sync_copy_worktree", "sync_delete_branch", "sync_restore_backup", "sync_publish"].includes(request.params.name) && !args.apply) {
      return result(data, issueConfirmation(request.params.name, args, data));
    }
    return result(data);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});

function parseWorktrees(text) {
  return text.trim().split("\n\n").filter(Boolean).map(block => {
    const fields = Object.fromEntries(block.split("\n").map(line => {
      const index = line.indexOf(" ");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    return { path: fields.worktree, head: fields.HEAD, branch: fields.branch?.replace("refs/heads/", "") || null, bare: "bare" in fields };
  });
}

async function runGit(args) {
  const child = spawn(process.env.GIT_BIN || "git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  for await (const chunk of child.stdout) stdout += chunk;
  for await (const chunk of child.stderr) stderr += chunk;
  if (child.exitCode !== 0) throw new Error(stderr.trim() || `git exited with ${child.exitCode}`);
  return stdout;
}

await access(cli);
await server.connect(new StdioServerTransport());
