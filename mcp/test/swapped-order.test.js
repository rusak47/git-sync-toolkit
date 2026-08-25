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

test("confirmation survives swapped arg key order in preview vs apply", async t => {
  const repo = await mkdtemp(join(tmpdir(), "gst-swapped-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "t@e.invalid");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "README"), "test\n");
  git(repo, "add", "README");
  git(repo, "commit", "-m", "init");
  git(repo, "branch", "upstream/master");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: repo,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GIT_SYNC_REPO_ROOT")),
  });
  const client = new Client({ name: "test-swapped", version: "1.0.0" }, { capabilities: {} });
  t.after(() => client.close());
  await client.connect(transport);

  // Preview with source-first arg order
  const preview = jsonResult(await client.callTool({
    name: "sync_copy_worktree",
    arguments: { source: "upstream/master", target: "test/swapped-order" },
  }));
  assert.match(preview.confirmation, /^[A-Za-z0-9_-]{20,}$/);

  // Apply with REVERSED arg order (target first) — regression test for JSON.stringify ordering bug
  const applied = jsonResult(await client.callTool({
    name: "sync_copy_worktree",
    arguments: {
      target: "test/swapped-order",
      source: "upstream/master",
      apply: true,
      confirmation: preview.confirmation,
    },
  }));
  assert.equal(applied.copied, true);
  assert.match(git(repo, "branch", "--list", "test/swapped-order"), /test\/swapped-order/);
});
