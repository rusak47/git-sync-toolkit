#!/usr/bin/env node
import { parseArgs, git, gitLines, ref, range, ancestor, mergeBase, patchIds, loadLedger, saveLedger, requireClean, assertPushRemote, assertValidatedState, commitSummary, config } from "./lib.js";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { join, dirname as pathDirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";

const a = parseArgs(process.argv.slice(2));
const command = a._[0] || (a.delete ? "delete" : "analyze");
const invocationCwd = process.cwd();
const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
const commonGitDir = resolve(repositoryRoot, git(["rev-parse", "--git-common-dir"]));
let originUrl = "no-origin";
try { originUrl = git(["config", "--get", "remote.origin.url"]) || originUrl; } catch {}
const repositoryKey = `${commonGitDir}-${originUrl}`;
const repositorySlug = repositoryRoot.split("/").filter(Boolean).at(-1)?.replace(/[^A-Za-z0-9._-]/g, "-") || "repository";
const stateKey = createHash("sha256").update(repositoryKey).digest("hex").slice(0, 16);
const repositoryStateDir = pathToFileURL(`${resolve(tmpdir(), "git-sync-toolkit", `${repositorySlug}-${stateKey}`)}/`);
config.ledger = new URL("ledger.json", repositoryStateDir);
config.patchDir = new URL("patches/merged/", repositoryStateDir);
config.stateDir = repositoryStateDir;
config.appliedState = new URL("applied.json", repositoryStateDir);
config.cleanupProgress = new URL("cleanup-progress.json", repositoryStateDir);
config.refreshProgress = new URL("refresh-progress.json", repositoryStateDir);
config.syncProgress = new URL("sync-progress.json", repositoryStateDir);
config.mergeProgress = new URL("merge-progress.json", repositoryStateDir);
for (const option of ["plan", "generate"]) {
  if (typeof a[option] === "string" && !isAbsolute(a[option])) a[option] = resolve(invocationCwd, a[option]);
}
await mkdir(config.stateDir, { recursive: true });
if (a.worktree && !["copy", "delete", "worktree"].includes(command)) {
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
    execFileSync(command, args, { stdio: "pipe" });
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
async function clearSyncProgress() {
  try { await unlink(config.syncProgress); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
async function clearMergeProgress() {
  try { await unlink(config.mergeProgress); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
function remoteTip(remote, branch) {
  return git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0] || "";
}
function remoteBaseRef(remote, branch) {
  try { return ref(`${remote}/${branch}`, `${remote} base`), `${remote}/${branch}`; }
  catch {
    const head = git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    return ref(head, `${remote} default branch`), head;
  }
}
function remoteForRef(value) {
  const candidate = String(value).split("/", 1)[0];
  if (!candidate) return null;
  try { git(["remote", "get-url", candidate]); return candidate; }
  catch { return null; }
}
function githubRepoForRemote(remote) {
  let url;
  try { url = git(["remote", "get-url", remote]); }
  catch { return null; }
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
function pullRequestDetails(pr, repo) {
  const args = ["pr", "view", pr];
  if (repo) args.push("--repo", repo);
  args.push("--json", "url,title,body,headRefName,baseRefName,additions,deletions,files");
  const raw = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const details = JSON.parse(raw);
  return {
    ...details,
    body: details.body || "",
    files: (details.files || []).map(file => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.changeType,
    })),
  };
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
function skipEmptyCherryPick(error) {
  if (!/cherry-pick.*empty|previous cherry-pick is now empty/i.test(error.message)) return false;
  try { ref("CHERRY_PICK_HEAD", "empty cherry-pick"); }
  catch { return false; }
  if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") return false;
  git(["cherry-pick", "--skip"]);
  return true;
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
  const targetExists = (() => {
    try { git(["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`]); return true; }
    catch { return false; }
  })();
  const worktreeBlocks = git(["worktree", "list", "--porcelain"]).split("\n\n").map(block => block.split("\n"));
  const attached = worktreeBlocks.find(block => block.includes(`branch refs/heads/${targetBranch}`));
  const attachedPath = attached?.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
  if (targetExists && !a.force) {
    throw new Error(`Target branch already exists: ${targetBranch}; use --force to replace its contents from ${source}`);
  }
  if (targetExists && attachedPath) {
    throw new Error(`Cannot replace branch ${targetBranch}; it is checked out at ${attachedPath}`);
  }
  const root = await guessWorktreeRoot();
  const destination = join(root, targetBranch);
  const result = { dryRun: !apply, source, sourceSha, target: targetBranch, worktree: destination, replacing: targetExists };
  output(result);
  if (!apply) return;
  await mkdir(destination, { recursive: true });
  let backup;
  if (targetExists) {
    backup = `backup/${targetBranch.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
    git(["branch", backup, targetBranch]);
    git(["branch", "-f", targetBranch, sourceSha]);
    git(["worktree", "add", destination, targetBranch]);
  } else {
    git(["worktree", "add", "-b", targetBranch, destination, sourceSha]);
  }
  output({ ...result, dryRun: false, copied: true, ...(backup ? { backup } : {}) });
}
async function worktree() {
  if (a.move) {
    if (!a.bulk) throw new Error("worktree --move requires --bulk");
    if (typeof a.target !== "string" || !a.target) {
      throw new Error("worktree --move --bulk requires --target <destination-root>");
    }
    const destinationRoot = resolve(invocationCwd, a.target);
    const blocks = git(["worktree", "list", "--porcelain"]).split("\n\n")
      .map(block => block.split("\n").filter(Boolean));
    const moves = blocks.slice(1).map(block => {
      const source = block.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
      const branchLine = block.find(line => line.startsWith("branch "));
      const branch = branchLine?.slice("branch refs/heads/".length);
      const head = block.find(line => line.startsWith("HEAD "))?.slice("HEAD ".length);
      if (!source || !head) throw new Error("Unable to parse a linked worktree");
      const name = branch || source.split("/").at(-1) || `detached-${head.slice(0, 10)}`;
      return { source, destination: join(destinationRoot, name), branch: branch || null, head };
    }).filter(move => resolve(move.source) !== resolve(move.destination));
    for (const move of moves) {
      if (resolve(move.destination) === resolve(move.source)) continue;
      try {
        await stat(move.destination);
        throw new Error(`Destination already exists: ${move.destination}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const result = { dryRun: !apply, action: "move", bulk: true, destinationRoot, moves };
    output(result);
    if (!apply) return;
    for (const move of moves) {
      await mkdir(dirname(move.destination), { recursive: true });
      git(["worktree", "move", move.source, move.destination]);
    }
    output({ ...result, dryRun: false, moved: moves.length });
    return;
  }
  if (a._[1] !== "checkout") throw new Error("worktree requires the checkout subcommand");
  const requested = a._[2];
  if (!requested) throw new Error("worktree checkout requires a branch name");
  if (!/^[A-Za-z0-9._/-]+$/.test(requested) || requested.startsWith("/") || requested.endsWith("/")) {
    throw new Error("Invalid branch name");
  }
  const requestedRemote = requested.includes("/") ? requested.split("/", 1)[0] : "";
  const isRemoteRef = (() => {
    if (!requestedRemote) return false;
    try { git(["remote", "get-url", requestedRemote]); return true; }
    catch { return false; }
  })();
  const remote = isRemoteRef ? requestedRemote : config.originRemote;
  const remoteBranch = isRemoteRef ? requested.slice(requestedRemote.length + 1) : requested;
  if (!remoteBranch) throw new Error("worktree checkout requires a branch name");
  const branch = a.target || (isRemoteRef && remote !== config.originRemote ? requested : remoteBranch);
  if (typeof branch !== "string"
    || !/^[A-Za-z0-9._/-]+$/.test(branch)
    || branch.startsWith("/")
    || branch.endsWith("/")) {
    throw new Error("Invalid target branch name");
  }
  const localExists = (() => {
    try { git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); return true; }
    catch { return false; }
  })();
  const remoteRef = `${remote}/${remoteBranch}`;
  if (!localExists) {
    try { ref(remoteRef, "remote branch"); }
    catch { throw new Error(`Branch not found locally or on ${remote}: ${remoteBranch}`); }
  }
  const blocks = git(["worktree", "list", "--porcelain"]).split("\n\n").map(block => block.split("\n"));
  const attached = blocks.find(block => block.includes(`branch refs/heads/${branch}`));
  if (attached) {
    const path = attached.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
    throw new Error(`Branch ${branch} is already checked out at ${path}`);
  }
  const root = await guessWorktreeRoot();
  const destination = join(root, branch);
  const result = { dryRun: !apply, branch, source: localExists ? branch : remoteRef, worktree: destination, tracking: !localExists };
  output(result);
  if (!apply) return;
  await mkdir(destination, { recursive: true });
  git(["worktree", "add", ...(localExists ? [] : ["-b", branch]), destination, localExists ? branch : remoteRef]);
  output({ ...result, dryRun: false, checkedOut: true });
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
async function guessWorktreeRoot() {
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const worktrees = git(["worktree", "list", "--porcelain"]).split("\n")
    .filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
  let root = a.worktree && resolve(invocationCwd, a.worktree);
  if (!root && worktrees.length > 1) {
    let guessed = pathDirname(worktrees[1]);
    while (guessed !== pathDirname(guessed)
      && !["worktree", "worktrees"].includes(guessed.split("/").at(-1))) {
      guessed = pathDirname(guessed);
    }
    if (!json && input.isTTY && outputStream.isTTY) {
      const rl = createInterface({ input, output: outputStream });
      const answer = await rl.question(`Guessed worktrees root "${guessed}". Use it? [Y/n] `);
      if (!answer.trim() || /^y(es)?$/i.test(answer.trim())) root = guessed;
      else root = (await rl.question("Enter worktrees root path: ")).trim();
      rl.close();
    } else root = guessed;
  }
  return root || join(repoRoot, "worktrees");
}
async function classify() {
  const commits = range(a.base || `origin/${config.baseBranch}`, a.branch || "HEAD");
  output(commits.map(sha => ({ sha, subject: commitSummary(sha), value: "review", files: gitLines(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) })));
}
async function merge() {
  if (a.plan) {
    const target = git(["branch", "--show-current"]);
    if (!target) throw new Error("merge --plan requires a checked-out target branch");
    const allowed = /^(test|fix|feat|pr)(?:[/-]|$)/;
    const forkMainNames = new Set([config.baseBranch, target]);
    const branches = gitLines(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .filter(branch => branch !== target
        && allowed.test(branch)
        && !(branch.includes("/") && forkMainNames.has(branch.split("/").at(-1))));
    const targetSha = ref(target, "merge plan target");
    const configuredUpstream = `${config.upstreamRemote}/${config.baseBranch}`;
    let upstreamRef = configuredUpstream;
    let upstreamSha;
    try {
      upstreamSha = ref(upstreamRef, "merge plan upstream base");
    } catch {
      upstreamRef = git(["symbolic-ref", "--short", `refs/remotes/${config.upstreamRemote}/HEAD`]);
      upstreamSha = ref(upstreamRef, "merge plan upstream base");
    }
    const targetPatchIds = new Set([...patchIds(gitLines(["rev-list", "--reverse", targetSha])).values()].filter(Boolean));
    const targetSubjects = new Set(git(["log", "--format=%s", targetSha]).split("\n").filter(Boolean));
    const plan = branches.map(source => {
      const sourceSha = ref(source, "merge plan source");
      let upstreamBase;
      try { upstreamBase = mergeBase(sourceSha, upstreamSha); } catch {}
      const behind = upstreamBase ? range(upstreamBase, upstreamSha).length : null;
      if (ancestor(sourceSha, targetSha)) {
        return {
          source,
          status: "merged",
          ahead: 0,
          behind,
          command: null,
        };
      }
      let base;
      try { base = mergeBase(targetSha, sourceSha); } catch {
        return { source, status: "no-common-history", ahead: null, behind, command: null };
      }
      const commits = range(base, sourceSha);
      const sourcePatchIds = patchIds(commits);
      const commitsToMerge = commits.filter(commit => {
        const patchId = sourcePatchIds.get(commit);
        return !(patchId && targetPatchIds.has(patchId))
          && !targetSubjects.has(git(["show", "-s", "--format=%s", commit]));
      });
      return {
        source,
        status: commitsToMerge.length ? "merge" : "merged",
        ahead: commitsToMerge.length,
        behind,
        command: commitsToMerge.length
          ? `node ${process.argv[1]} merge --source ${source} --apply`
          : null,
      };
    }).sort((left, right) => {
      if (left.ahead === null) return 1;
      if (right.ahead === null) return -1;
      return left.ahead - right.ahead || left.source.localeCompare(right.source);
    });
    if (json) {
      output({ dryRun: true, target, branches: plan });
    } else {
      console.log(`reset checked-out branch to ${upstreamRef} before merging:`);
      console.log(`git fetch ${config.upstreamRemote}`);
      console.log(`git reset --hard ${upstreamRef}\n`);
      console.log(`target: ${target}`);
      console.log("branches:");
      for (const entry of plan) {
        if (entry.status === "merged") console.log(`> ${entry.source} ahead 0 behind ${entry.behind} [merged]`);
        else if (entry.ahead === null) console.log(`${entry.source} no-common-history`);
        else console.log(`${entry.source} ahead ${entry.ahead} behind ${entry.behind}`);
      }
      const commands = plan.filter(entry => entry.command);
      if (commands.length) {
        console.log("\ncommands:");
        for (const entry of commands) {
          console.log(entry.command);
        }
      }
    }
    return;
  }
  if (a.abort) {
    let progress;
    try { progress = JSON.parse(await readFile(config.mergeProgress, "utf8")); }
    catch (e) { if (e.code === "ENOENT") throw new Error("No interrupted merge progress found"); throw e; }
    const branch = git(["branch", "--show-current"]);
    if (branch !== progress.target) {
      throw new Error(`Merge abort must run on ${progress.target}; current branch is ${branch || "(detached)"}`);
    }
    ref(progress.backup, "merge backup");
    let interrupted = true;
    try { ref("CHERRY_PICK_HEAD", "interrupted merge"); } catch { interrupted = false; }
    if (interrupted) {
      try { git(["cherry-pick", "--abort"]); }
      catch (error) { throw new Error(`Unable to abort interrupted merge: ${error.message}`); }
    }
    git(["reset", "--hard", progress.backup]);
    await clearMergeProgress();
    output({ aborted: true, branch, restored: progress.backup });
    return;
  }
  if (a.continue) {
    let progress;
    try { progress = JSON.parse(await readFile(config.mergeProgress, "utf8")); }
    catch (e) { if (e.code === "ENOENT") throw new Error("No interrupted merge progress found"); throw e; }
    const branch = git(["branch", "--show-current"]);
    if (branch !== progress.target) throw new Error(`Merge continuation must run on ${progress.target}; current branch is ${branch || "(detached)"}`);
    try { ref("CHERRY_PICK_HEAD", "interrupted merge"); }
    catch { throw new Error("No interrupted merge cherry-pick found; resolve the conflict and run git cherry-pick --continue first"); }
    if (a["auto-accept-incoming"]) autoAcceptIncoming();
    try { git(["cherry-pick", "--continue"]); }
    catch (error) { throw new Error(`Merge continuation requires resolved and staged conflicts: ${error.message}`); }
    for (const [offset, commit] of progress.commits.slice(progress.index + 1).entries()) {
      const index = progress.index + 1 + offset;
      await writeFile(config.mergeProgress, `${JSON.stringify({ ...progress, index }, null, 2)}\n`);
      try { cherryPick(commit, false, a["auto-accept-incoming"]); }
      catch (error) {
        throw new Error([
          "Merge stopped because cherry-pick encountered another conflict.",
          "Resolve the conflicts, stage the files, then run: merge --continue",
          "To abandon this merge instead, run: merge --abort",
          `Original error: ${error.message}`,
        ].join("\n"));
      }
    }
    validate();
    await clearMergeProgress();
    output({ continued: true, branch, applied: progress.commits.length - progress.index });
    return;
  }
  const source = a.source || a._[1];
  const currentBranch = git(["branch", "--show-current"]);
  const targetBranch = a.target || a._[2] || currentBranch;
  if (!source) throw new Error("merge requires --source <branch> or a source branch argument");
  if (!targetBranch) throw new Error("merge requires a checked-out target branch");
  if (source === targetBranch) throw new Error("Merge source and target must be different branches");
  if (targetBranch !== currentBranch) {
    throw new Error(`Target branch ${targetBranch} is not checked out; run merge from its worktree`);
  }
  const sourceSha = ref(source, "merge source");
  const targetSha = ref(targetBranch, "merge target");
  const base = mergeBase(targetSha, sourceSha);
  const sourceCommits = range(base, sourceSha);
  const targetPatchIds = new Set([...patchIds(gitLines(["rev-list", "--reverse", targetSha])).values()].filter(Boolean));
  const targetSubjects = new Set(git(["log", "--format=%s", targetSha]).split("\n").filter(Boolean));
  const sourcePatchIds = patchIds(sourceCommits);
  const mergeCommits = new Set(sourceCommits.filter(commit =>
    git(["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/).length > 2
  ));
  const replayRequested = String(a.replay || "").split(",").map(value => value.trim()).filter(Boolean);
  const replayCommits = new Set(replayRequested.map(requested => {
    const matches = sourceCommits.filter(commit => commit === requested || commit.startsWith(requested));
    if (matches.length !== 1) throw new Error(`--replay commit must identify exactly one commit from ${source}: ${requested}`);
    return matches[0];
  }));
  const isAlreadyPresent = commit => {
    const patchId = sourcePatchIds.get(commit);
    if (mergeCommits.has(commit)) return true;
    if (replayCommits.has(commit)) return false;
    return (patchId && targetPatchIds.has(patchId))
      || targetSubjects.has(git(["show", "-s", "--format=%s", commit]));
  };
  const commits = sourceCommits.filter(commit => !isAlreadyPresent(commit));
  const skipped = sourceCommits
    .filter(isAlreadyPresent)
    .map(sha => {
      const patchId = sourcePatchIds.get(sha);
      const reason = mergeCommits.has(sha)
        ? "merge commit is not replayed; replay its individual commits instead"
        : patchId && targetPatchIds.has(patchId)
          ? "already present in target by patch ID"
          : "already present in target by matching subject";
      return {
        sha,
        subject: commitSummary(sha),
        reason: replayCommits.has(sha) ? "forced by --replay" : reason,
      };
    });
  const report = {
    dryRun: !apply,
    source,
    sourceSha,
    target: targetBranch,
    targetSha,
    base,
    commits: commits.map(sha => ({ sha, subject: commitSummary(sha) })),
    skipped,
    replay: [...replayCommits],
  };
  output(report);
  if (!apply) return;
  requireClean(true);
  if (!commits.length) {
    output({ ...report, dryRun: false, merged: 0 });
    return;
  }
  const backup = `backup/${targetBranch.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
  git(["branch", backup, "HEAD"]);
  for (const [index, commit] of commits.entries()) {
    await writeFile(config.mergeProgress, `${JSON.stringify({
      target: targetBranch,
      commits,
      index,
      backup,
    }, null, 2)}\n`);
    try { cherryPick(commit, false, a["auto-accept-incoming"]); }
    catch (error) {
      throw new Error([
        "Merge stopped because cherry-pick encountered a conflict.",
        "Resolve the conflicts, stage the files, then run: merge --continue",
        "Do not rerun merge --apply; it would reset and replay commits again.",
        `Original error: ${error.message}`,
      ].join("\n"));
    }
  }
  validate();
  await clearMergeProgress();
  output({ ...report, dryRun: false, backup, merged: commits.length });
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
  if (a.push) throw new Error("sync does not support --push; run publish --apply after reviewing the synced branch");
  const ledger = await loadLedger();
  if (a.continue) {
    let progress;
    try { progress = JSON.parse(await readFile(config.syncProgress, "utf8")); }
    catch (e) { if (e.code === "ENOENT") throw new Error("No interrupted sync progress found"); throw e; }
    const branch = git(["branch", "--show-current"]);
    if (branch !== progress.branch) throw new Error(`Sync continuation must run on ${progress.branch}; current branch is ${branch || "(detached)"}`);
    let cherryPickPending = true;
    try { ref("CHERRY_PICK_HEAD", "interrupted sync"); } catch { cherryPickPending = false; }
    if (cherryPickPending) {
      if (a["auto-accept-incoming"]) autoAcceptIncoming();
      try { git(["cherry-pick", "--continue"]); }
      catch (error) {
        if (!skipEmptyCherryPick(error)) {
          throw new Error(`Sync continuation requires resolved and staged conflicts: ${error.message}`);
        }
      }
    } else {
      const expectedPatch = patchIds([progress.keep[progress.index]]).get(progress.keep[progress.index]);
      const currentPatch = patchIds(["HEAD"]).get(ref("HEAD", "current sync HEAD"));
      const expectedSubject = git(["show", "-s", "--format=%s", progress.keep[progress.index]]);
      const currentSubject = git(["show", "-s", "--format=%s", "HEAD"]);
      if ((!expectedPatch || expectedPatch !== currentPatch) && expectedSubject !== currentSubject) {
        throw new Error("No interrupted sync cherry-pick found; run git cherry-pick --continue for the active conflict, or restore the saved sync backup");
      }
    }
    for (const [offset, commit] of progress.keep.slice(progress.index + 1).entries()) {
      const index = progress.index + 1 + offset;
      await writeFile(config.syncProgress, `${JSON.stringify({ ...progress, index }, null, 2)}\n`);
      try { cherryPick(commit, false, a["auto-accept-incoming"]); }
      catch (error) {
        if (skipEmptyCherryPick(error)) continue;
        throw new Error([
          "Sync stopped because cherry-pick encountered another conflict.",
          "Resolve the conflicts, stage the files, then run: sync --continue",
          `Original error: ${error.message}`,
        ].join("\n"));
      }
    }
    validate();
    ledger.lastMergedUpstream = progress.targetRef;
    await saveLedger(ledger);
    await recordAppliedState(progress.remote, progress.branch, progress.expectedRemote);
    await clearSyncProgress();
    output({ continued: true, branch, applied: progress.keep.length - progress.index });
    return;
  }
  if (apply) {
    requireClean(true);
    const targetRemote = remoteForRef(a.target || target) || config.upstreamRemote;
    for (const remote of new Set([targetRemote, config.originRemote])) {
      git(["fetch", "--prune", "--", remote]);
    }
  }
  const upstream = ref(a.target || target, "pinned upstream target");
  const defaultBase = ledger.lastMergedUpstream || remoteBaseRef(config.originRemote, config.baseBranch);
  const head = ref("HEAD");
  const requestedBase = ref(a.base || defaultBase, "sync base");
  let base = requestedBase;
  let baseAdjusted = false;
  if (!ancestor(base, head)) {
    if (a.base) throw new Error("Current branch is not based on the selected sync base");
    base = mergeBase(base, head);
    baseAdjusted = true;
  }
  const replayBase = mergeBase(base, upstream);
  const commits = range(replayBase, head);
  const landedIds = new Set(patchIds(range(replayBase, upstream)).values());
  const targetSubjects = new Set(git(["log", "--format=%s", upstream]).split("\n").filter(Boolean));
  const ids = patchIds(commits);
  const mergeCommits = new Set(commits.filter(commit => git(["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/).length > 2));
  const skipSubjectMatches = a["skip-subject-matches"] === true || a["skip-subject-matches"] === "true";
  const skipRequested = String(a.skip || "").split(",").map(value => value.trim()).filter(Boolean);
  const skipCommits = new Set(skipRequested.map(requested => {
    const matches = commits.filter(commit => commit === requested || commit.startsWith(requested));
    if (matches.length !== 1) throw new Error(`--skip commit must identify exactly one commit in the sync range: ${requested}`);
    return matches[0];
  }));
  const subjectMatches = new Set(skipSubjectMatches
    ? commits.filter(commit => targetSubjects.has(git(["show", "-s", "--format=%s", commit])))
    : []);
  const drop = commits.filter(c => skipCommits.has(c)
    || mergeCommits.has(c)
    || landedIds.has(ids.get(c))
    || subjectMatches.has(c));
  const keep = commits.filter(c => !drop.includes(c));
  const report = {
    dryRun: !apply,
    base,
    ...(baseAdjusted ? { requestedBase, baseAdjusted: true } : {}),
    replayBase,
    upstream,
    keep: keep.map(commitSummary),
    drop: drop.map(commit => ({
      sha: commit,
      subject: commitSummary(commit),
      reason: skipCommits.has(commit)
        ? "manually skipped with --skip"
        : mergeCommits.has(commit)
          ? "merge commit is not replayed; replay its individual commits instead"
          : subjectMatches.has(commit)
            ? "already represented upstream by matching subject (--skip-subject-matches)"
          : "already represented upstream",
    })),
    skip: [...skipCommits],
    skipSubjectMatches,
    conflicts: gitLines(["diff", "--name-only", `${upstream}...HEAD`]).filter(f => config.hotFiles.includes(f)),
  };
  output(report);
  if (!apply) return;
  requireClean(true);
  const remote = assertPushRemote(a.remote || config.originRemote);
  const branch = git(["branch", "--show-current"]) || config.baseBranch;
  const backup = `backup/${branch.replace(/[^A-Za-z0-9._-]/g, "-")}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  git(["branch", backup, "HEAD"]);
  output({ ...report, dryRun: false, backup, applying: true });
  const expectedRemote = remoteTip(remote, branch);
  git(["reset", "--keep", upstream]);
  for (const [index, commit] of keep.entries()) {
    await writeFile(config.syncProgress, `${JSON.stringify({
      branch,
      remote,
      expectedRemote,
      targetRef: a.target || target,
      keep,
      index,
      backup,
    }, null, 2)}\n`);
    try { cherryPick(commit, false, a["auto-accept-incoming"]); }
    catch (error) {
      throw new Error([
        "Sync stopped because cherry-pick encountered a conflict.",
        "Resolve the conflicts, stage the files, then run: sync --continue",
        "Do not rerun sync --apply; it would reset the branch and replay commits again.",
        `Original error: ${error.message}`,
      ].join("\n"));
    }
  }
  validate();
  ledger.lastMergedUpstream = a.target || target;
  await saveLedger(ledger);
  await recordAppliedState(remote, branch, expectedRemote);
  await clearSyncProgress();
  output({ ...report, dryRun: false, backup, synced: true, branch });
}
async function adopt() {
  const pr = a._[1]; if (!pr || !/^\d+$/.test(pr)) throw new Error("adopt requires a numeric PR");
  const remote = a.remote || config.upstreamRemote;
  const repo = a.repo || githubRepoForRemote(remote);
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GitHub repository; use owner/repository");
  const details = pullRequestDetails(pr, repo);
  if (!apply) return output({
    dryRun: true,
    pr: Number(pr),
    ...(repo ? { repo } : {}),
    ...details,
    command: `gh pr diff ${pr}`,
  });
  requireClean(true);
  const source = a.remote ? remote : a.repo ? `https://github.com/${repo}.git` : remote;
  git(["fetch", source, `pull/${pr}/head`]);
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
  if (a.create) {
    const branch = git(["branch", "--show-current"]);
    if (!branch) throw new Error("backup --create requires a checked-out branch");
    const suffix = typeof a.create === "string" ? a.create : a._[1];
    const name = `backup/${(suffix || `${branch}-${Date.now()}`).replace(/^backup\//, "").replace(/[^A-Za-z0-9._/-]/g, "-")}`;
    const current = ref("HEAD", "current HEAD");
    try { git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]); throw new Error(`Backup already exists: ${name}`); }
    catch (error) { if (error.message.startsWith("Backup already exists")) throw error; }
    const report = { dryRun: !apply, action: "create", branch, current, name };
    output(report);
    if (!apply) return;
    git(["branch", name, "HEAD"]);
    output({ ...report, dryRun: false, created: true });
    return;
  }
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
  if (!a.list) throw new Error("backup requires --create, --list, or --delete <ref>");
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
  if (a.push) throw new Error("publish does not accept --push; use publish --apply");
  const currentBranch = git(["branch", "--show-current"]);
  const defaultBranch = currentBranch || config.baseBranch;
  if (a.validate) {
    requireClean(true);
    const remote = assertPushRemote(a.remote || config.originRemote);
    const branch = a.branch || defaultBranch;
    validate();
    const expectedRemote = git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0];
    await recordAppliedState(remote, branch, expectedRemote);
    output({ validated: true, remote, branch, expectedRemote, validatedHead: ref("HEAD", "validated HEAD") });
    return;
  }
  if (!apply) {
    output({ dryRun: true, remote: a.remote || config.originRemote, branch: a.branch || defaultBranch });
    return;
  }
  requireClean(true);
  const remote = assertPushRemote(a.remote || config.originRemote);
  const branch = a.branch || defaultBranch;
  let state;
  try { state = JSON.parse(await readFile(config.appliedState, "utf8")); }
  catch (e) { if (e.code === "ENOENT") throw new Error("No validated apply state found; run an apply operation first"); throw e; }
  const live = remoteTip(remote, branch);
  assertValidatedState(state, { remote, branch, expectedRemote: live, validatedHead: ref("HEAD", "current HEAD") });
  validate();
  git(["push", `--force-with-lease=refs/heads/${branch}:${state.expectedRemote}`, remote, `HEAD:refs/heads/${branch}`]);
}
const commands = { analyze, classify, copy, worktree, delete: deleteBranch, merge, land, landed, refresh, sync, adopt, restore, backup, publish, cleanup, "reset-candidates": resetCandidates };
try { if (!commands[command]) throw new Error(`Unknown operation: ${command}`); await commands[command](); }
catch (e) { console.error(`upstream toolkit: ${e.message}`); process.exitCode = 1; }
