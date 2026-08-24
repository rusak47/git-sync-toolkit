import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcpRoot = resolve(new URL("..", import.meta.url).pathname);
const server = join(mcpRoot, "server.js");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function jsonResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}

test("stdio server discovers tools and confirms a copy operation", async t => {
  const repo = await mkdtemp(join(tmpdir(), "git-sync-mcp-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "MCP Test");
  await writeFile(join(repo, "README"), "test\n");
  git(repo, "add", "README");
  git(repo, "commit", "-m", "initial");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: repo,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GIT_SYNC_REPO_ROOT")),
  });
  const client = new Client({ name: "git-sync-toolkit-test", version: "1.0.0" }, { capabilities: {} });
  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 10);
  assert.ok(listed.tools.some(tool => tool.name === "sync_copy_worktree"));
  const worktrees = jsonResult(await client.callTool({
    name: "sync_list_worktrees",
    arguments: {},
  }));
  assert.equal(worktrees.worktrees.length, 1);
  assert.equal(worktrees.worktrees[0].branch, "master");

  const preview = jsonResult(await client.callTool({
    name: "sync_copy_worktree",
    arguments: { source: "master", target: "test/copy", worktree: join(repo, "worktrees") },
  }));
  assert.match(preview.confirmation, /^[A-Za-z0-9_-]{20,}$/);

  const rejected = await client.callTool({
    name: "sync_copy_worktree",
    arguments: { source: "master", target: "test/copy", worktree: join(repo, "worktrees"), apply: true },
  });
  assert.equal(rejected.isError, true);

  const applied = jsonResult(await client.callTool({
    name: "sync_copy_worktree",
    arguments: {
      source: "master",
      target: "test/copy",
      worktree: join(repo, "worktrees"),
      apply: true,
      confirmation: preview.confirmation,
    },
  }));
  assert.equal(applied.copied, true);
  assert.match(git(repo, "branch", "--list", "test/copy"), /test\/copy/);
});
