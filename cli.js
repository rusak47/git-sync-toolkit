#!/usr/bin/env node
import { parseArgs, git, gitLines, ref, range, ancestor, mergeBase, patchIds, loadLedger, saveLedger, requireClean, assertPushRemote, assertValidatedState, commitSummary, config } from "./lib.js";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { join, dirname as pathDirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";

const a = parseArgs(process.argv.slice(2));
const command = a._[0] || (a.delete ? "delete" : "analyze");
const invocationCwd = process.cwd();
for (const option of ["plan", "generate"]) {
  if (a[option] && !isAbsolute(a[option])) a[option] = resolve(invocationCwd, a[option]);
}
if (a.worktree && !["copy", "delete"].includes(command)) {
  let selected = a.worktree;
  const lines = git(["worktree", "list", "--porcelain"]).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("worktree ")) continue;
    const end = lines.indexOf("", i);
    const block = lines.slice(i, end < 0 ? lines.length : end);
    if (block.includes(`branch refs/heads/${a.worktree}`)) {
      selected = lines[i].slice("worktree ".length);
      break;
    }
  }
  try { process.chdir(selected); }
  catch (error) { throw new Error(`Cannot use worktree ${a.worktree}: ${error.message}`); }
}
const target = a._[1] || `${config.upstreamRemote}/${config.baseBranch}`;
const apply = a.apply === true || a.apply === "true";
const json = a.json === true;
const output = x => json
  ? console.log(JSON.stringify(x, null, 2))
  : console.dir(x, { depth: null, colors: false });
function validate() {
  if (a["skip-validation"]) return;
  for (const [command, args] of config.validationCommands) {
    execFileSync(command, args, { stdio: "inherit" });
  }
}
async function recordAppliedState(remote, branch, expectedRemote) {
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.appliedState, `${JSON.stringify({
    branch,
    remote,
    expectedRemote,
    validatedHead: ref("HEAD", "validated HEAD"),
  }, null, 2)}\n`);
}
async function writeCleanupProgress(data) {
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.cleanupProgress, `${JSON.stringify(data, null, 2)}\n`);
}
async function clearCleanupProgress() {
  try { await unlink(config.cleanupProgress); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
async function clearRefreshProgress() {
  try { await unlink(config.refreshProgress); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
function remoteTip(remote, branch) {
  return git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0] || "";
}
function autoAcceptIncoming() {
  const paths = gitLines(["diff", "--name-only", "--diff-filter=U"]);
  if (!paths.length) return false;
  git(["checkout", "--theirs", "--", ...paths]);
  git(["add", "--", ...paths]);
  return true;
}
function cherryPick(commit, noCommit, autoAccept) {
  try {
    git(noCommit ? ["cherry-pick", "--no-commit", commit] : ["cherry-pick", commit]);
  } catch (error) {
    if (!autoAccept || !autoAcceptIncoming()) throw error;
    if (noCommit) {
      try { git(["cherry-pick", "--quit"]); } catch {}
    } else {
      git(["cherry-pick", "--continue"]);
    }
  }
}
function fixupsFor(commit, fixups) {
  return (fixups || []).filter(fixup => fixup.after === commit);
}
function applyFixups(commit, fixups, amend = false) {
  for (const fixup of fixupsFor(commit, fixups)) {
    if (fixup.patch) {
      const patch = isAbsolute(fixup.patch) ? fixup.patch : resolve(invocationCwd, fixup.patch);
      try {
        git(["apply", "--index", "--", patch]);
      } catch (error) {
        throw new Error([
          `Cleanup fixup failed after ${commit}: ${patch}`,
          "The cleanup is paused at this commit.",
          "Fix the patch manually and stage the result, then run cleanup --continue;",
          "or run cleanup --continue without staging it to skip this fixup.",
          error.message,
        ].join("\n"));
      }
    }
    if (fixup.manual) {
      throw new Error(`Manual cleanup fix required after ${commit}: ${fixup.manual}`);
    }
  }
  if (amend && fixupsFor(commit, fixups).length) git(["commit", "--amend", "--no-edit"]);
}

async function analyze() {
  const upstream = ref(target, "upstream target"), base = ref(`HEAD`, "HEAD");
  const commits = range(upstream, base).map(c => ({ sha: c, subject: commitSummary(c) }));
  const files = gitLines(["diff", "--name-only", `${upstream}...HEAD`]);
  const result = { target, upstream, commits, files, hotFiles: files.filter(f => config.hotFiles.includes(f)), clean: clean() };
  output(result);
}
async function copy() {
  const source = a.source || a._[1];
  const targetBranch = a.target || a._[2];
  if (!source || !targetBranch) throw new Error("copy requires --source <branch> and --target <branch>");
  if (!/^[A-Za-z0-9._/-]+$/.test(targetBranch) || targetBranch.startsWith("/") || targetBranch.endsWith("/")) {
    throw new Error("Invalid target branch");
  }
  const sourceSha = ref(source, "source branch");
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`]);
    throw new Error(`Target branch already exists: ${targetBranch}`);
  } catch (error) {
    if (error.message.startsWith("Target branch already exists")) throw error;
  }
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const worktrees = git(["worktree", "list", "--porcelain"]).split("\n")
    .filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
  let root = a.worktree && resolve(invocationCwd, a.worktree);
  if (!root && worktrees.length > 1) {
    const guessed = pathDirname(worktrees[1]);
    if (!json && input.isTTY && outputStream.isTTY) {
      const rl = createInterface({ input, output: outputStream });
      const answer = await rl.question(`Guessed worktrees root "${guessed}". Use it? [Y/n] `);
      if (!answer.trim() || /^y(es)?$/i.test(answer.trim())) root = guessed;
      else root = (await rl.question("Enter worktrees root path: ")).trim();
      rl.close();
    } else root = guessed;
  }
  if (!root) root = join(repoRoot, "worktrees");
  const destination = join(root, targetBranch);
  const result = { dryRun: !apply, source, sourceSha, target: targetBranch, worktree: destination };
  output(result);
  if (!apply) return;
  await mkdir(destination, { recursive: true });
  git(["worktree", "add", "-b", targetBranch, destination, sourceSha]);
  output({ ...result, dryRun: false, copied: true });
}
async function deleteBranch() {
  const branch = typeof a.delete === "string" ? a.delete : (a._[1] || a.branch);
  if (!branch) throw new Error("delete requires a branch name");
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("Invalid branch name");
  }
  try { git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); }
  catch { throw new Error(`Local branch does not exist: ${branch}`); }
  const blocks = git(["worktree", "list", "--porcelain"]).split("\n\n").map(block => block.split("\n"));
  const attached = blocks.find(block => block.includes(`branch refs/heads/${branch}`));
  const attachedPath = attached?.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
  const removeWorktree = Boolean(a.worktree);
  const selectedPath = a.worktree && a.worktree !== true ? resolve(invocationCwd, a.worktree) : attachedPath;
  if (attachedPath && !removeWorktree) {
    throw new Error(`Branch ${branch} is checked out at ${attachedPath}; remove that worktree first or pass --worktree`);
  }
  if (selectedPath && attachedPath !== selectedPath) {
    throw new Error(`--worktree does not point to branch ${branch}; expected ${attachedPath || "(no attached worktree)"}`);
  }
  const dirty = attachedPath ? git(["-C", attachedPath, "status", "--porcelain", "--untracked-files=all"]) !== "" : false;
  if (dirty && !a.force) {
    throw new Error(`Worktree ${attachedPath} has uncommitted changes; review them or add --force`);
  }
  const result = { dryRun: !apply, branch, worktree: attachedPath || null, dirty, removeWorktree };
  output(result);
  if (!apply) return;
  if (attachedPath) git(["worktree", "remove", ...(a.force ? ["--force"] : []), "--", attachedPath]);
  git(["branch", a.force ? "-D" : "-d", branch]);
  output({ ...result, dryRun: false, deleted: true });
}
function clean() { try { return git(["status", "--porcelain"]) === ""; } catch { return false; } }
async function classify() {
  const commits = range(a.base || `origin/${config.baseBranch}`, a.branch || "HEAD");
  output(commits.map(sha => ({ sha, subject: commitSummary(sha), value: "review", files: gitLines(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) })));
}
async function land() {
  await classify();
  if (!apply) return;
  requireClean(true);
  const remote = assertPushRemote(a.remote || config.originRemote);
  git(["fetch", "--prune", "--", remote]);
  const base = ref(a.base || `origin/${config.baseBranch}`);
  const backup = `backup/${(a.branch || "feature").replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  git(["rebase", base]);
  validate();
  const branch = a.branch || git(["branch", "--show-current"]);
  await recordAppliedState(remote, branch, remoteTip(remote, branch));
  if (a.push) git(["push", `--force-with-lease=refs/heads/${branch}:${ref(`${remote}/${branch}`, "origin branch")}`, remote, `HEAD:refs/heads/${branch}`]);
}
async function landed() {
  const base = a.base || (await loadLedger()).lastMergedUpstream || target;
  ref(base, "base");
  const local = range(base, "HEAD"), upstream = range(base, target);
  const upIds = new Set(patchIds(upstream).values());
  output(local.map(sha => ({ sha, subject: commitSummary(sha), landed: upIds.has(patchIds([sha]).get(sha)) })));
}
async function refresh() {
  if (a.continue) {
    let progress;
    try { progress = JSON.parse(await readFile(config.refreshProgress, "utf8")); }
    catch (e) { if (e.code === "ENOENT") throw new Error("No interrupted refresh progress found"); throw e; }
    if (progress.plan && progress.plan !== a.remoteRef) throw new Error("Refresh progress belongs to a different remote reference");
    let interrupted = false;
    try { ref("CHERRY_PICK_HEAD", "interrupted refresh"); interrupted = true; } catch {}
    if (interrupted && a["auto-accept-incoming"]) autoAcceptIncoming();
    try { git(["cherry-pick", "--continue"]); } catch (error) {
      throw new Error(`Refresh continuation requires resolved and staged conflicts: ${error.message}`);
    }
    for (const [index, commit] of progress.kept.slice(progress.index + 1).entries()) {
      await writeFile(config.refreshProgress, `${JSON.stringify({ plan: progress.plan, kept: progress.kept, index: progress.index + 1 + index }, null, 2)}\n`);
      cherryPick(commit, false, a["auto-accept-incoming"]);
    }
    await clearRefreshProgress();
    output({ continued: true, branch: git(["branch", "--show-current"]), applied: progress.kept.length - progress.index });
    return;
  }
  const branch = git(["branch", "--show-current"]);
  const remoteRef = a.remoteRef || `${config.originRemote}/${branch || config.baseBranch}`;
  if (apply) { requireClean(true); git(["fetch", "--prune", "--", config.originRemote]); }
  const pinned = ref(remoteRef, "origin target");
  const current = ref("HEAD");
  const base = mergeBase(current, pinned);
  const localCommits = range(base, current);
  const originCommits = range(base, pinned);
  const originIds = new Set(patchIds(originCommits).values());
  const originShas = new Set(originCommits);
  const ledger = await loadLedger();
  const aliases = new Map(
    ledger.commits
      .filter(commit => commit.sha && Array.isArray(commit.aliases))
      .flatMap(commit => commit.aliases.map(alias => [alias, commit.sha])),
  );
  const localIds = patchIds(localCommits);
  const dropped = localCommits.filter(commit =>
    originIds.has(localIds.get(commit)) ||
    (aliases.has(commit) && originShas.has(aliases.get(commit))),
  );
  const kept = localCommits.filter(commit => !dropped.includes(commit));
  const action = ancestor(pinned, current)
    ? "up-to-date"
    : ancestor(current, pinned) && kept.length === 0
      ? "fast-forward"
      : "rebase";
  const plan = {
    dryRun: !apply,
    branch,
    remoteRef,
    current,
    mergeBase: base,
    target: pinned,
    action,
    kept: kept.map(commitSummary),
    dropped: dropped.map(commit => ({
      sha: commit,
      subject: git(["show", "-s", "--format=%s", commit]),
      reason: originIds.has(localIds.get(commit)) ? "patch-id-match" : "ledger-equivalent",
    })),
  };
  output(plan);
  if (!apply) return;
  if (action === "up-to-date") return;
  const backup = `backup/${(branch || config.baseBranch).replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  const fetched = ref(remoteRef, "origin target");
  if (action === "fast-forward") {
    git(["merge", "--ff-only", fetched]);
    return;
  }
  git(["reset", "--keep", fetched]);
  for (const [index, commit] of kept.entries()) {
    await writeFile(config.refreshProgress, `${JSON.stringify({ plan: a.remoteRef || remoteRef, kept, index }, null, 2)}\n`);
    cherryPick(commit, false, a["auto-accept-incoming"]);
  }
  await clearRefreshProgress();
}
async function sync() {
  if (apply) {
    requireClean(true);
    git(["fetch", "--prune", "--", config.upstreamRemote]);
    git(["fetch", "--prune", "--", config.originRemote]);
  }
  const upstream = ref(a.target || target, "pinned upstream target");
  const head = ref("HEAD"), base = ref(a.base || `origin/${config.baseBranch}`);
  if (!ancestor(base, head)) throw new Error("Current branch is not based on the configured base branch");
  const commits = range(base, head), ledger = await loadLedger();
  const landedIds = new Set(patchIds(range(ledger.lastMergedUpstream || upstream, upstream)).values());
  const ids = patchIds(commits);
  const drop = commits.filter(c => landedIds.has(ids.get(c)));
  const keep = commits.filter(c => !drop.includes(c));
  const report = { dryRun: !apply, upstream, keep: keep.map(commitSummary), drop: drop.map(commitSummary), conflicts: gitLines(["diff", "--name-only", `${upstream}...HEAD`]).filter(f => config.hotFiles.includes(f)) };
  output(report);
  if (!apply) return;
  requireClean(true);
  const backup = `backup/${config.baseBranch}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  git(["branch", backup, "HEAD"]);
  git(["reset", "--keep", upstream]);
  for (const commit of keep) git(["cherry-pick", commit]);
  ledger.lastMergedUpstream = a.target || target; await saveLedger(ledger);
  const remote = assertPushRemote(a.remote || config.originRemote);
  const branch = git(["branch", "--show-current"]) || config.baseBranch;
  await recordAppliedState(remote, branch, remoteTip(remote, branch));
  if (a.push) git(["push", `--force-with-lease=refs/heads/${branch}:${ref(`${remote}/${branch}`, "origin branch")}`, remote, `HEAD:refs/heads/${branch}`]);
}
async function adopt() {
  const pr = a._[1]; if (!pr || !/^\d+$/.test(pr)) throw new Error("adopt requires a numeric PR");
  if (!apply) return output({ dryRun: true, command: `gh pr diff ${pr}` });
  requireClean(true);
  git(["fetch", config.upstreamRemote, `pull/${pr}/head`]);
  const sourceSha = ref("FETCH_HEAD", "PR source");
  const patchId = patchIds([sourceSha]).get(sourceSha);
  const patch = git(["format-patch", "-1", "--stdout", sourceSha]);
  await mkdir(config.patchDir, { recursive: true });
  await writeFile(new URL(`pr-${pr}.patch`, config.patchDir), patch);
  git(["cherry-pick", sourceSha]);
  const resolvedSha = git(["rev-parse", "HEAD"]);
  const ledger = await loadLedger();
  ledger.commits.push({ kind: "cherry-pick", upstreamPr: Number(pr), sourceSha, resolvedSha, patchId, keepIfLanded: false });
  await saveLedger(ledger);
}
async function resetCandidates() {
  const upstream = ref(a.target || target, "upstream target");
  const files = gitLines(["diff", "--name-only", `${upstream}...HEAD`]);
  output(files.map(file => {
    let insignificant = false;
    try { git(["diff", "--quiet", "--ignore-all-space", upstream, "HEAD", "--", file]); insignificant = true; } catch {}
    return { file, insignificant, recommendation: insignificant ? "reset-to-upstream" : "review" };
  }));
}
async function restore() {
  if (!a.backup) throw new Error("restore requires --backup <ref>");
  const backup = ref(a.backup, "backup ref");
  const current = ref("HEAD");
  const report = { dryRun: !apply, current, backup: a.backup, target: backup };
  output(report);
  if (!apply) return;
  if (!git(["branch", "--show-current"])) throw new Error("Refusing to restore a detached HEAD");
  git(["reset", "--hard", backup]);
}
async function backup() {
  if (a.delete) {
    const name = a.delete === true ? a._[1] : a.delete;
    if (!name || !name.startsWith("backup/") || /[\s;&|`$]/.test(name)) {
      throw new Error("backup --delete requires a backup/<name> ref");
    }
    const target = ref(name, "backup ref");
    if (!apply) {
      output({ dryRun: true, action: "delete", name, target });
      return;
    }
    git(["update-ref", "-d", `refs/heads/${name}`, target]);
    output({ dryRun: false, action: "delete", deleted: true, name, target });
    return;
  }
  if (!a.list) throw new Error("backup requires --list or --delete <ref>");
  const backups = gitLines([
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)\t%(objectname)\t%(creatordate:iso8601)\t%(subject)",
    "refs/heads/backup",
  ]).map(line => {
    const [name, sha, createdAt, ...subject] = line.split("\t");
    return { name, sha, createdAt, subject: subject.join("\t") };
  });
  output(backups);
}
async function cleanup() {
  if (a.truncate) {
    const base = ref(a.base, "truncate base");
    const branch = git(["branch", "--show-current"]);
    if (!branch) throw new Error("Refusing to truncate a detached HEAD");
    const current = ref("HEAD", "current HEAD");
    if (!ancestor(base, current)) {
      throw new Error(`Truncate base ${base} is not an ancestor of current HEAD ${current}; regenerate the plan for this branch`);
    }
    const report = { dryRun: !apply, action: "truncate", branch, current, base };
    output(report);
    if (!apply) return;
    requireClean(true);
    const backup = `backup/${(branch || config.baseBranch).replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
    git(["branch", backup, "HEAD"]);
    git(["reset", "--hard", base]);
    validate();
    await recordAppliedState(config.originRemote, branch || config.baseBranch, remoteTip(config.originRemote, branch || config.baseBranch));
    await clearCleanupProgress();
    output({ ...report, dryRun: false, applied: true, backup, result: ref("HEAD", "truncated HEAD") });
    return;
  }
  if (a.modify) {
    if (!a.plan) throw new Error("--modify requires --plan <file>");
    if (a["move-before"]) {
      const plan = JSON.parse(await readFile(a.plan, "utf8"));
      const sha = ref(a.modify, "cleanup commit");
      const before = ref(a["move-before"], "move target");
      const sourceIndex = (plan.replay || []).findIndex(group => group.commits.includes(sha));
      const targetIndex = (plan.replay || []).findIndex(group => group.commits.includes(before));
      if (sourceIndex < 0 || targetIndex < 0) throw new Error("--move-before requires both commits in replay groups");
      const [group] = plan.replay.splice(sourceIndex, 1);
      const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      plan.replay.splice(adjustedTarget, 0, group);
      if (apply) {
        const temporary = `${a.plan}.tmp-${process.pid}`;
        await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`);
        await rename(temporary, a.plan);
      }
      output({ dryRun: !apply, action: "move-before", commit: sha, before, plan });
      return;
    }
    if (!["drop", "replay", "squash"].includes(a.action)) throw new Error("--action must be drop, replay, or squash");
    if (!a.reason) throw new Error("--modify requires --reason <text>");
    const plan = JSON.parse(await readFile(a.plan, "utf8"));
    const sha = ref(a.modify, "cleanup commit");
    if (a.action === "squash") {
      if (!a.into || !a.subject) throw new Error("squash requires --into <sha> and --subject <text>");
      const into = ref(a.into, "squash target");
      let firstIndex = -1;
      const groups = [];
      for (const [index, group] of (plan.replay || []).entries()) {
        if (group.commits.includes(sha) || group.commits.includes(into)) {
          if (firstIndex === -1) firstIndex = index;
          groups.push(group);
        }
      }
      if (groups.length < 2) throw new Error("Squash commits must be in separate replay groups");
      const commits = groups.flatMap(group => group.commits);
      plan.replay = (plan.replay || []).filter(group => !groups.includes(group));
      plan.replay.splice(firstIndex, 0, { commits, subject: a.subject, reason: a.reason });
      if (apply) {
        const temporary = `${a.plan}.tmp-${process.pid}`;
        await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`);
        await rename(temporary, a.plan);
      }
      output({ dryRun: !apply, action: a.action, commits, subject: a.subject, reason: a.reason, plan });
      return;
    }
    let found = false;
    plan.drop = (plan.drop || []).filter(item => {
      const commit = typeof item === "string" ? item : item.commit;
      if (commit !== sha) return true;
      found = true;
      return false;
    });
    plan.replay = (plan.replay || []).flatMap(group => {
      const commits = (group.commits || []).filter(commit => {
        if (commit !== sha) return true;
        found = true;
        return false;
      });
      return commits.length ? [{ ...group, commits }] : [];
    });
    if (!found) throw new Error(`Commit is not classified in cleanup plan: ${a.modify}`);
    if (a.action === "drop") {
      plan.drop.push({ commit: sha, subject: git(["show", "-s", "--format=%s", sha]), reason: a.reason });
    } else {
      plan.replay.push({
        commits: [sha],
        subject: git(["show", "-s", "--format=%s", sha]),
        reason: a.reason,
      });
    }
    if (apply) {
      const temporary = `${a.plan}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`);
      await rename(temporary, a.plan);
    }
    output({ dryRun: !apply, modified: sha, action: a.action, reason: a.reason, plan });
    return;
  }
  if (a.generate) {
    const base = ref(a.base || `origin/${config.baseBranch}`, "cleanup base");
    const current = ref(a.branch || "HEAD", "cleanup branch");
    const generated = {
      schemaVersion: 1,
      branch: git(["branch", "--show-current"]) || a.branch || "HEAD",
      base,
      drop: [],
      replay: range(base, current).map(commit => ({
        commits: [commit],
        subject: git(["show", "-s", "--format=%s", commit]),
        reason: null,
      })),
    };
    await mkdir(dirname(a.generate), { recursive: true });
    await writeFile(a.generate, `${JSON.stringify(generated, null, 2)}\n`);
    output({ generated: a.generate, ...generated });
    return;
  }
  if (!a.plan) throw new Error("cleanup requires --plan <file> (or --generate <file>)");
  const plan = JSON.parse(await readFile(a.plan, "utf8"));
  const branch = git(["branch", "--show-current"]);
  const worktree = git(["rev-parse", "--show-toplevel"]);
  if (a.rebind) {
    if (!branch) throw new Error("Refusing to rebind a plan from detached HEAD");
    const rebound = { ...plan, branch };
    output({ dryRun: !apply, action: "rebind", worktree, branch, plan: rebound });
    if (apply) {
      const temporary = `${a.plan}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(rebound, null, 2)}\n`);
      await rename(temporary, a.plan);
    }
    return;
  }
  if (plan.branch && plan.branch !== branch) {
    const worktrees = git(["worktree", "list"]);
    throw new Error([
      "Cleanup plan branch mismatch.",
      `  Plan branch:    ${plan.branch}`,
      `  Current branch: ${branch || "(detached)"}`,
      `  Worktree:       ${worktree}`,
      "",
      "If the current worktree is the intended target, run --rebind --apply",
      "to update the plan metadata. Otherwise select the correct worktree with",
      "--worktree <branch-or-path>.",
      "",
      "Available worktrees:",
      worktrees,
    ].join("\n"));
  }
  if (a.continue) {
    let progress;
    try { progress = JSON.parse(await readFile(config.cleanupProgress, "utf8")); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      const interruptedCommit = ref("CHERRY_PICK_HEAD", "interrupted cherry-pick");
      progress = { groupIndex: (plan.replay || []).findIndex(group => group.commits.includes(interruptedCommit)), commitIndex: 0, commit: interruptedCommit };
    }
    const groupIndex = progress.groupIndex;
    const commitIndex = progress.commitIndex;
    const interruptedCommit = progress.commit;
    if (progress.plan && progress.plan !== a.plan) {
      throw new Error("Cleanup progress belongs to a different plan");
    }
    if (!Number.isInteger(groupIndex) || !Number.isInteger(commitIndex) || !interruptedCommit) {
      throw new Error("Cleanup progress is invalid");
    }
    if (git(["diff", "--name-only", "--diff-filter=U"]) && !a["auto-accept-incoming"]) {
      throw new Error("Resolve and stage all conflicts before cleanup --continue");
    }
    if (groupIndex < 0 || !plan.replay[groupIndex] || plan.replay[groupIndex].commits[commitIndex] !== interruptedCommit) {
      throw new Error("Interrupted cherry-pick is not in the cleanup plan");
    }
    if (a["auto-accept-incoming"]) autoAcceptIncoming();
    try { git(["cherry-pick", "--quit"]); } catch {}
    const replay = plan.replay || [];
    for (let i = groupIndex; i < replay.length; i++) {
      const group = replay[i];
      const commits = group.commits.map(commit => ref(commit, "cleanup commit"));
      if (commits.length === 1) {
        if (i === groupIndex) {
          if (commitIndex !== 0) throw new Error("Invalid cleanup continuation state");
          if (git(["diff", "--cached", "--quiet"]) === "") continue;
          applyFixups(commits[0], group.fixups);
          git(["commit", "-C", commits[0]]);
        } else {
          await writeCleanupProgress({
            branch: git(["branch", "--show-current"]) || config.baseBranch,
            plan: a.plan,
            groupIndex: i,
            commitIndex: 0,
            commit: commits[0],
          });
          cherryPick(commits[0], false, a["auto-accept-incoming"]);
          applyFixups(commits[0], group.fixups, true);
        }
        continue;
      }
      const start = i === groupIndex ? commitIndex + 1 : 0;
      if (start >= commits.length) continue;
      for (const [offset, commit] of commits.slice(start).entries()) {
        await writeCleanupProgress({
          branch: git(["branch", "--show-current"]) || config.baseBranch,
          plan: a.plan,
          groupIndex: i,
          commitIndex: start + offset,
          commit,
        });
        cherryPick(commit, true, a["auto-accept-incoming"]);
        applyFixups(commit, group.fixups);
      }
      if (!group.subject) throw new Error("Squash group requires a subject");
      git(["commit", "-m", group.subject]);
    }
    validate();
    const currentBranch = branch || config.baseBranch;
    await recordAppliedState(config.originRemote, currentBranch, remoteTip(config.originRemote, currentBranch));
    await clearCleanupProgress();
    output({ continued: true, worktree, branch: currentBranch, validatedHead: ref("HEAD", "validated HEAD") });
    return;
  }
  const base = ref(plan.base || a.base || `origin/${config.baseBranch}`, "cleanup base");
  const current = ref(a.branch || "HEAD", "cleanup branch");
  if (!ancestor(base, current)) {
    throw new Error(`Cleanup base ${base} is not an ancestor of current HEAD ${current}; regenerate the plan for this branch`);
  }
  const local = new Set(range(base, current));
  const replay = plan.replay || [];
  const dropped = (plan.drop || []).map(item => typeof item === "string" ? { commit: item } : item);
  const replayShas = replay.flatMap(group => group.commits || []);
  const droppedShas = dropped.map(item => item.commit);
  const allPlanned = [...replayShas, ...droppedShas];
  if (new Set(allPlanned).size !== allPlanned.length) throw new Error("Cleanup plan contains duplicate commits");
  for (const commit of allPlanned) {
    const sha = ref(commit, "cleanup commit");
    if (!local.has(sha)) {
      throw new Error([
        `Cleanup commit is not on the selected branch: ${commit}`,
        "The plan may already have been applied or the branch may have been reset;",
        "restore the pre-cleanup backup and regenerate the plan for this branch.",
      ].join("\n"));
    }
  }
  if (allPlanned.length !== local.size) throw new Error("Cleanup plan must classify every local commit");
  const report = {
    dryRun: !apply,
    base,
    branch: git(["branch", "--show-current"]) || a.branch || "HEAD",
    drop: dropped.map(item => ({
      sha: ref(item.commit, "cleanup commit"),
      subject: item.subject || git(["show", "-s", "--format=%s", item.commit]),
      reason: item.reason || "explicitly marked for removal",
    })),
    replay: replay.map(group => ({
      commits: group.commits.map(commitSummary),
      subject: group.subject || null,
      squash: group.commits.length > 1,
      reason: group.reason || (group.commits.length > 1
        ? "squash iterative commits into one logical change"
        : "preserve unique local change"),
      fixups: (group.fixups || []).map(fixup => ({
        after: ref(fixup.after, "fixup commit"),
        patch: fixup.patch || null,
        manual: fixup.manual || null,
        reason: fixup.reason || null,
      })),
    })),
  };
  output(report);
  if (!apply) return;
  requireClean(true);
  git(["fetch", "--prune", "--", config.originRemote]);
  const currentBranch = branch || config.baseBranch;
  const expectedRemote = remoteTip(config.originRemote, currentBranch);
  const backup = `backup/${(report.branch || config.baseBranch).replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  git(["reset", "--keep", base]);
  for (const group of replay) {
    const commits = group.commits.map(commit => ref(commit, "cleanup commit"));
    if (commits.length === 1) {
      await writeCleanupProgress({ branch, plan: a.plan, groupIndex: replay.indexOf(group), commitIndex: 0, commit: commits[0] });
      cherryPick(commits[0], false, a["auto-accept-incoming"]);
      applyFixups(commits[0], group.fixups, true);
      continue;
    }
    for (const [commitIndex, commit] of commits.entries()) {
      await writeCleanupProgress({ branch, plan: a.plan, groupIndex: replay.indexOf(group), commitIndex, commit });
      cherryPick(commit, true, a["auto-accept-incoming"]);
      applyFixups(commit, group.fixups);
    }
    if (!group.subject) throw new Error("Squash group requires a subject");
    git(["commit", "-m", group.subject]);
  }
  validate();
  await recordAppliedState(config.originRemote, currentBranch, expectedRemote);
  await clearCleanupProgress();
}
async function publish() {
  if (a.validate) {
    requireClean(true);
    const remote = assertPushRemote(a.remote || config.originRemote);
    const branch = a.branch || git(["branch", "--show-current"]) || config.baseBranch;
    validate();
    const expectedRemote = git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0];
    await recordAppliedState(remote, branch, expectedRemote);
    output({ validated: true, remote, branch, expectedRemote, validatedHead: ref("HEAD", "validated HEAD") });
    return;
  }
  if (!apply) {
    output({ dryRun: true, remote: a.remote || config.originRemote, branch: a.branch || config.baseBranch });
    return;
  }
  requireClean(true);
  const remote = assertPushRemote(a.remote || config.originRemote);
  const branch = a.branch || config.baseBranch;
  let state;
  try { state = JSON.parse(await readFile(config.appliedState, "utf8")); }
  catch (e) { if (e.code === "ENOENT") throw new Error("No validated apply state found; run an apply operation first"); throw e; }
  const live = remoteTip(remote, branch);
  assertValidatedState(state, { remote, branch, expectedRemote: live, validatedHead: ref("HEAD", "current HEAD") });
  validate();
  git(["push", `--force-with-lease=refs/heads/${branch}:${state.expectedRemote}`, remote, `HEAD:refs/heads/${branch}`]);
}
const commands = { analyze, classify, copy, delete: deleteBranch, land, landed, refresh, sync, adopt, restore, backup, publish, cleanup, "reset-candidates": resetCandidates };
try { if (!commands[command]) throw new Error(`Unknown operation: ${command}`); await commands[command](); }
catch (e) { console.error(`upstream toolkit: ${e.message}`); process.exitCode = 1; }
