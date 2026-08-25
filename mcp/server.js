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
const timeoutMs = Number(process.env.GIT_SYNC_MCP_TIMEOUT_MS || 120000);
const confirmations = new Map();

const stringProperty = { type: "string", minLength: 1 };

const worktreePathProp = {
  type: "string",
  minLength: 1,
  description: [
    "Selects which worktree the operation runs in.",
    "Accepts exact branch name whose worktree is resolved automatically via git worktree list, or an absolute worktree directory path.",
    "Omit to use the current worktree.",
  ].join(" "),
};
const applyProp = { type: "boolean", description: "false or omitted: preview only and returns a confirmation token. true: perform the operation." };
const confirmationProp = { type: "string", minLength: 1, description: "Token returned by the preview call. Required when apply=true. Single-use, 10-minute expiry." };

function repositoryRoot() {
  return resolve(process.env.GIT_SYNC_REPO_ROOT || process.cwd());
}

function run(args, cwd = repositoryRoot()) {
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
      try { resolvePromise(JSON.parse(stdout.trim().split(/\n(?=\{)/).at(-1))); }
      catch { reject(new Error(`Toolkit returned invalid JSON: ${stdout.trim() || stderr.trim() || "empty output"}`)); }
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
  const keys = Object.keys(copy).sort();
  return JSON.stringify([name, Object.fromEntries(keys.map(k => [k, copy[k]]))]);
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
    inputSchema: {
      type: "object",
      properties: {
        target: { ...stringProperty, description: "Upstream branch to compare against. Default: upstream/master." },
        worktree: worktreePathProp,
      },
    },
  },
  {
    name: "sync_refresh",
    description: "Preview or apply a worktree refresh from a remote ref. First call with apply=false (or omitted) to get a confirmation token; then call again with apply=true and the confirmation token. continue=true resumes after a conflicted apply. autoAcceptIncoming=true auto-resolves incoming changes without prompting.",
    inputSchema: {
      type: "object",
      properties: {
        remoteRef: { ...stringProperty, description: "Remote ref to refresh from (e.g., upstream/main). Default: last merged upstream from ledger." },
        worktree: worktreePathProp,
        apply: applyProp,
        confirmation: confirmationProp,
        continue: { type: "boolean", description: "Resume an interrupted refresh from saved progress. Mutually exclusive with remoteRef." },
        autoAcceptIncoming: { type: "boolean", description: "Auto-resolve conflicts by accepting incoming (theirs) changes. Only meaningful with continue or when conflicts expected." },
      },
    },
  },
  {
    name: "sync_cleanup",
    description: [
      "Rewrites the CURRENT branch's commit history from a cleanup plan JSON file.",
      "The plan splits every local commit (since the plan's base) into \"replay\" groups (cherry-picked in order; multi-commit groups become one squashed commit) and \"drop\" entries (removed).",
      "Only the checked-out branch is rewritten. Other branches, worktrees, and remotes are never touched. A backup/<branch>-TIMESTAMP ref is created before the rewrite, and configured validation runs after it.",
      "Workflow: 1) generate a plan with the CLI: `cli.js cleanup --base <ref> --generate <file>`; 2) edit the plan to mark which commits to drop, keep, or squash; 3) call this tool with apply=false to preview, review the report, then repeat with apply=true and the returned token.",
      "Preview/apply flow: first call without apply returns a preview and a single-use confirmation token (10-minute expiry). Pass the identical request plus the token and apply=true to execute. If the apply stops on a conflict, resolve and stage the files, then resume with continue=true. autoAcceptIncoming=true resolves conflicts by taking the incoming version instead of pausing.",
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: { ...stringProperty, description: "Absolute or relative path to the cleanup plan JSON file. Generated by the CLI command `cleanup --generate <file>`." },
        worktree: worktreePathProp,
        apply: applyProp,
        confirmation: confirmationProp,
        continue: { type: "boolean", description: "Resume an interrupted cleanup from saved progress." },
        autoAcceptIncoming: { type: "boolean", description: "Auto-resolve conflicts by accepting incoming (theirs) changes. Only meaningful with continue or when conflicts expected." },
      },
    },
  },
  {
    name: "sync_validate_publish",
    description: "Run configured validation and capture publish state without pushing.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { ...stringProperty, description: "Branch to validate. Default: current branch." },
        worktree: worktreePathProp,
      },
    },
  },
  {
    name: "sync_publish",
    description: "Publish a previously validated branch. First call with apply=false (or omitted) to get a confirmation token; then call again with apply=true and the confirmation token.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { ...stringProperty, description: "Branch to publish. Default: last validated branch." },
        worktree: worktreePathProp,
        apply: applyProp,
        confirmation: confirmationProp,
      },
    },
  },
  {
    name: "sync_copy_worktree",
    description: "Preview or create a new branch and worktree from a source branch. First call with apply=false (or omitted) to get a confirmation token; then call again with apply=true and the confirmation token.",
    inputSchema: {
      type: "object",
      required: ["source", "target"],
      properties: {
        source: { ...stringProperty, description: "Source branch to copy from (e.g., upstream/master)." },
        target: { ...stringProperty, description: "New branch name to create." },
        worktree: worktreePathProp,
        apply: applyProp,
        confirmation: confirmationProp,
      },
    },
  },
  {
    name: "sync_delete_branch",
    description: "Preview or delete a local branch, optionally removing its associated worktree. First call with apply=false (or omitted) to get a confirmation token; then call again with apply=true and the confirmation token.",
    inputSchema: {
      type: "object",
      required: ["branch"],
      properties: {
        branch: { ...stringProperty, description: "Local branch name to delete." },
        worktree: worktreePathProp,
        removeWorktree: { type: "boolean", description: "Also remove the worktree where this branch is checked out (bare --worktree flag). Ignored when worktree path is given explicitly." },
        force: { type: "boolean", description: "Skip safety checks (e.g., unmerged commits)." },
        apply: applyProp,
        confirmation: confirmationProp,
      },
    },
  },
  {
    name: "sync_list_backups",
    description: "List local recovery backups.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sync_restore_backup",
    description: "Preview or restore a branch from a local recovery backup. First call with apply=false (or omitted) to get a confirmation token; then call again with apply=true and the confirmation token.",
    inputSchema: {
      type: "object",
      required: ["backup"],
      properties: {
        backup: { ...stringProperty, description: "Backup name to restore (from sync_list_backups)." },
        worktree: worktreePathProp,
        apply: applyProp,
        confirmation: confirmationProp,
      },
    },
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
        const reason = !entry ? "missing" : entry.expires < Date.now() ? "expired" : `key mismatch: stored=${entry.key} got=${requestKey(request.params.name, args)}`;
        throw new Error(`Invalid or expired confirmation (${reason}); run the same operation in preview mode first`);
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
      if (args.worktree) cliArgs.push("--worktree", args.worktree);
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_delete_branch") {
      cliArgs.push("delete", "--delete", args.branch);
      if (args.removeWorktree && !args.worktree) cliArgs.push("--worktree");
      if (args.force) cliArgs.push("--force");
      if (args.apply) cliArgs.push("--apply");
    } else if (request.params.name === "sync_list_backups") {
      cliArgs.push("backup", "--list");
    } else if (request.params.name === "sync_restore_backup") {
      cliArgs.push("restore", "--backup", args.backup);
      if (args.apply) cliArgs.push("--apply");
    } else {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    if (typeof args.worktree === "string") cliArgs.push("--worktree", args.worktree);
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
  const child = spawn(process.env.GIT_BIN || "git", args, { cwd: repositoryRoot(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  for await (const chunk of child.stdout) stdout += chunk;
  for await (const chunk of child.stderr) stderr += chunk;
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  if (exitCode !== 0) throw new Error(stderr.trim() || `git exited with ${exitCode}`);
  return stdout;
}

await access(cli);
await server.connect(new StdioServerTransport());
