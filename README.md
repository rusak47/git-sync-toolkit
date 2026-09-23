# Git synchronization toolkit

Node ESM, intentionally dependency-free. Run from the repository root:

```sh
node .docs/scripts/git-sync-toolkit/cli.js <operation> [target] [options]
```

All operations are read-only by default. `--apply` is required for fetch,
rebase, cherry-pick, ledger, or patch writes. `--push` is accepted by `land`,
uses `--force-with-lease`, and never permits pushes to `upstream`.
`refresh` updates the current branch from its `origin/<branch>` counterpart
using fast-forward when possible, otherwise rebase. Apply operations require a
clean tree; `land` and `sync` create `backup/master-TIMESTAMP`.
Refs are resolved as immutable commits and ancestry is checked before rebasing.
The ledger is schema-versioned and written atomically. Keep `.docs/scripts/samples`
ignored: it is reference material, not executable toolkit code.

## Which synchronization command should I use?

To rebuild the current branch on fresh upstream history while replaying
fork-unique commits, use `sync`:

```sh
node .docs/scripts/git-sync-toolkit/cli.js sync \
  --target upstream/master \
  --json
node .docs/scripts/git-sync-toolkit/cli.js sync \
  --target upstream/master \
  --apply
```

Review the preview's `keep` and `drop` lists before applying. `sync` fetches
upstream and origin in apply mode, resets the current branch to the selected
upstream target, then replays fork-local commits that are not already
represented upstream by patch ID. It creates a backup ref and updates the
ledger. Publishing is a separate `publish --apply` operation.

Merge commits in the current branch are not replayed as commits. Their
individual non-merge commits remain eligible for replay, which avoids
reintroducing an old upstream-integration merge when the selected target
already contains that upstream history. Any conflict-resolution changes that
exist only in the merge commit require a manually reviewed `cleanup` plan.

Use `refresh` to update the current branch from its fork remote counterpart
(`origin/<branch>` by default), while preserving local-only commits. Use
`merge` to cherry-pick selected commits from one local branch into the
currently checked-out branch. Use `copy` to create or replace a branch and
worktree from a source ref, and `worktree checkout` to attach an existing
local or remote branch to a new worktree. Use `cleanup` only when you need a
manually reviewed history rewrite—such as selectively dropping, reordering,
replaying, or squashing commits.

## Repository configuration

The toolkit is repository-agnostic. Defaults are `origin`, `upstream`, and
`master`; override them without editing the toolkit:

<example>
<command>SYNC_ORIGIN_REMOTE=fork SYNC_UPSTREAM_REMOTE=source SYNC_BASE_BRANCH=main node .docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef fork/main</command>
</example>

Repository-specific ownership and risk settings use JSON-array environment
variables:

<example>
<command>SYNC_FORK_OWNED='["docs/**","vendor/**"]' SYNC_HOT_FILES='["src/core.js"]' node .docs/scripts/git-sync-toolkit/cli.js analyze upstream/main --json</command>
</example>

Validation defaults to the toolkit's own tests. Replace it for a host
repository by setting `SYNC_VALIDATION_COMMANDS` to a JSON array of
`[command,args]` pairs.

### Run the full test suite before commits

Configure the repository-local Git hook once:

```sh
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

After setup, every commit runs both test suites:

```sh
npm test
npm --prefix mcp test
```

The commit is rejected if either suite fails. The hook is stored in
`.githooks/pre-commit`, so the setup command must be repeated in each clone.

For persistent project settings, create the ignored `config.local.js` beside
the toolkit:

```js
export const config = {
  originRemote: "fork",
  upstreamRemote: "source",
  baseBranch: "main",
  forkOwned: ["docs/**"],
  hotFiles: ["src/core.js"],
  validationCommands: [["npm", ["test"]]],
};
```

`config.local.js` overrides defaults without being committed or pushed.

## Examples

### Copy a branch to a new worktree

Create a new branch and worktree from an existing source branch:

```sh
node .docs/scripts/git-sync-toolkit/cli.js copy \
  --source feature/my-work \
  --target test/my-work \
  --worktree /tmp/9router/worktrees \
  --apply
```

Short options are also supported: `-s`, `-t`, and `-w`. The target worktree
path is `<worktrees-root>/<target-branch>`. If `--worktree` is omitted and
existing worktrees provide a likely common root, the toolkit asks for
confirmation before using it; otherwise it uses `<repository>/worktrees`.
The source must resolve to a commit. If the target branch already exists, copy
stops and tells you to use `--force`; with `--force`, the existing branch must
not be checked out by any worktree, a backup ref is created, and the branch is
repointed to the source before the worktree is created. Copy previews by
default; `--apply` is required to create or replace the branch and worktree.

To replace an existing, unattached branch:

```sh
node .docs/scripts/git-sync-toolkit/cli.js copy \
  --source master \
  --target test/master \
  --force \
  --apply
```

### Check out a branch into a worktree

Check out an existing local branch, or create a local tracking branch from
`origin/<branch>`, in a guessed worktree directory:

```sh
node .docs/scripts/git-sync-toolkit/cli.js worktree checkout test/latency-aware-routing
node .docs/scripts/git-sync-toolkit/cli.js worktree checkout test/latency-aware-routing --apply
```

The command previews by default. If `--worktree` is supplied, it is used as
the worktree root; otherwise the toolkit guesses it from existing worktrees.
The branch must not already be checked out in another worktree.

### Delete a branch and its worktree

Preview deletion:

```sh
node .docs/scripts/git-sync-toolkit/cli.js delete --delete test/my-work
```

Use `-D` as the short form and add `-w`/`--worktree` to automatically locate
and remove the worktree associated with that branch:

```sh
node .docs/scripts/git-sync-toolkit/cli.js -D test/my-work \
  --worktree --apply
```

If the branch is checked out by a worktree, deletion stops unless
`--worktree` is supplied. Dirty worktrees also stop unless `--force` is
supplied. `--apply` is required for removal; `--force` permits discarding
uncommitted changes. An explicit worktree path is still accepted when needed.

## MCP server

The optional `mcp/` package exposes the toolkit over MCP stdio while keeping
the terminal CLI unchanged. Install its dependencies and configure an MCP
client to launch:

```sh
npm --prefix .docs/scripts/git-sync-toolkit/mcp install
npm --prefix .docs/scripts/git-sync-toolkit/mcp test
```

Install the toolkit outside any project (for example under
`~/.local/share/git-sync-toolkit`) and configure Kilo Code globally with the
absolute path to `mcp/server.js`. The server uses the MCP process working
directory as the repository by default, so the same installation works across
projects and worktrees. Set `GIT_SYNC_REPO_ROOT` only when the MCP client
cannot provide the project working directory or when intentionally targeting a
fixed repository.

```jsonc
{
  "mcp": {
    "git-sync-toolkit": {
      "type": "local",
      "command": [
        "node",
        "/home/you/.local/share/git-sync-toolkit/mcp/server.js"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

The server provides structured tools for listing worktrees, analyzing,
refreshing, cleanup, validation, and publishing. Mutating tools default to
preview mode and return a short-lived confirmation token. Pass that token with
the identical request and `apply: true` only after reviewing the preview.
Tokens are single-use and expire after ten minutes. `GIT_SYNC_MCP_TIMEOUT_MS`
controls the subprocess timeout.

### Inspect and classify changes

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js analyze upstream/master --json</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js landed upstream/master</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js reset-candidates upstream/master</command>
</example>

### Merge a feature branch into the current branch

To see which local fork branches are candidates for merging into the current
branch, run:

```sh
node .docs/scripts/git-sync-toolkit/cli.js merge --plan
```

`merge --plan` ignores branches that do not start with `test`, `fix`, `feat`,
or `pr` (including forms such as `test/master` and `pr-2941`). It excludes the
currently checked-out target branch. It first prints every candidate as `branch ahead N behind M`, where
`behind` is measured against the configured upstream base (for example,
`upstream/master`), sorted from fewest to most commits, followed by a separate
list of exact merge commands. Branches already fully contained in the target are marked `merged`;
already-contained and no-common-history branches are summarized without
listing their commits. Use `--json` when structured status details are needed.
The human-readable plan starts with the commands to fetch and reset the
checked-out branch to that upstream base. The plan is read-only; review each
command before running it.

Preview the commits that would be cherry-picked from a source branch onto the
currently checked-out branch:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js merge --source feature/my-work</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js merge --source feature/my-work --apply</command>
</example>

The target defaults to the branch checked out where the command is run. An
explicit target may be supplied as the second positional branch:

```sh
node .docs/scripts/git-sync-toolkit/cli.js merge feature/my-work test/master
```

The target must be checked out in the current worktree. Preview is the default;
`--apply` creates a `backup/<target>-TIMESTAMP` ref, cherry-picks source-only
commits in order, and runs configured validation. Commits whose patch IDs are
already present in the target, or whose subjects match an existing target
commit after a conflict-resolved integration, are listed under `skipped` and
are not cherry-picked again.

If a skipped commit contains a fix that must be reapplied despite matching a
target subject or patch ID, force it by commit SHA (short SHAs are accepted):

```sh
node .docs/scripts/git-sync-toolkit/cli.js merge \
  --source pr/latency-view-feature \
  --replay 9946dafc \
  --apply
```

`--replay` accepts a comma-separated list when multiple skipped commits must
be restored. The requested commits must belong to the source branch; conflicts
are handled with the normal `merge --continue` or `merge --abort` workflow.

If `merge --apply` stops on a conflict, do not rerun the merge command.
Resolve the conflicts and stage the files, then continue the saved merge:

```sh
git add <resolved-files>
node .docs/scripts/git-sync-toolkit/cli.js merge --continue
```

Repeat the resolve, stage, and `merge --continue` steps for any additional
conflicts. The continuation completes the remaining cherry-picks and runs
validation. Rerunning `merge --apply` would reset and replay the operation.

To abandon a conflicted merge and restore the target branch to its pre-merge
state, run:

```sh
node .docs/scripts/git-sync-toolkit/cli.js merge --abort
```

The generated backup ref is retained.

### Refresh a worktree from fork origin

`refresh` synchronizes the **currently checked-out branch** with its fork
remote branch. By default, it uses `origin/<current-branch>`; use
`--remoteRef <remote>/<branch>` to select another remote branch. It does not
switch branches, create worktrees, or merge arbitrary local branches.

The command first previews the synchronization plan. It fetches the selected
remote only with `--apply`, then:

- reports `up-to-date` when the current branch already contains the remote tip;
- uses a fast-forward when the current branch is strictly behind and no local
  commits need to be preserved; or
- resets to the remote tip and cherry-picks local-only commits that are not
  already represented by patch ID or the synchronization ledger.

Local commits that are already present in the remote are reported as
`dropped`; local commits that remain after the refresh are reported as `kept`.
Apply mode requires a clean worktree. A backup ref is created before a
non-fast-forward refresh.

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef origin/master --apply</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef origin/master --apply --auto-accept-incoming</command>
</example>

If an apply stops while replaying a kept commit, refresh persists its replay
position before each cherry-pick. Resolve and stage the files, then resume
with:

```sh
node .docs/scripts/git-sync-toolkit/cli.js refresh \
  --remoteRef origin/master \
  --continue
```

Use `--continue --auto-accept-incoming` to choose the incoming version for
unresolved paths before continuing. Refresh progress is separate from cleanup
progress.

### Land a feature branch into fork origin

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js land --branch feature/my-work --apply</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js land --branch feature/my-work --apply --push</command>
</example>

### Sync fork origin from an upstream tag or commit

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js sync --target upstream/master --json</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js sync --target v0.5.56 --apply</command>
</example>

`sync` uses the explicit `--base` when supplied; otherwise it uses the
ledger's `lastMergedUpstream` boundary. This preserves fork-local commits
that are already present in `origin/<branch>` while dropping only changes
whose patch IDs or adopted-PR records are represented by the selected
upstream target. When the selected fork base and upstream have diverged, sync
uses their merge base as the replay boundary so commits already present in the
fork base are still inspected instead of being silently treated as absent.
If the remembered default base is no longer an ancestor of the current branch,
sync automatically narrows it to the current branch's merge base and reports
`requestedBase` plus `baseAdjusted: true`. An explicitly supplied `--base`
remains strict and still fails when it is not an ancestor. The operation
validates the rebuilt branch before updating the ledger. It never pushes.

If rebasing changed a PR enough that automatic matching cannot identify it as
already present in the selected target, explicitly exclude its local commit
from replay with `--skip`:

```sh
node .docs/scripts/git-sync-toolkit/cli.js sync \
  --target origin/master \
  --skip 64923679,c5ea8b25 \
```

`--skip` accepts full or unambiguous short SHAs, comma-separated. Each SHA
must be a commit in the sync range. Skipped commits appear in `drop` with the
reason `manually skipped with --skip`; review the preview before using
`--apply`.

For rebased PRs whose patch IDs changed but whose commit subjects are unchanged,
you can opt into subject-based dropping:

```sh
node .docs/scripts/git-sync-toolkit/cli.js sync \
  --target origin/master \
  --skip-subject-matches
```

This is disabled by default because equal subjects do not guarantee equal
content. The preview reports these entries with the reason
`already represented upstream by matching subject
(--skip-subject-matches)`.

`sync --apply` creates and reports a `backup/*` ref before changing the
current branch. If replay stops on a conflict, do not rerun `sync --apply`.
Resolve and stage the files, then resume the saved replay:

```sh
git add <resolved-files>
node .docs/scripts/git-sync-toolkit/cli.js sync --continue
```

Repeat the resolve, stage, and `sync --continue` steps for additional
conflicts. The continuation completes validation, ledger updates, and publish
state only after all kept commits are replayed.

To separate rebuilding from publishing, run sync, then publish the completed
result:

```sh
node .docs/scripts/git-sync-toolkit/cli.js sync \
  --target upstream/master \
  --base <base> \
  --apply
node .docs/scripts/git-sync-toolkit/cli.js publish \
  --validate \
  --branch master
node .docs/scripts/git-sync-toolkit/cli.js publish \
  --branch master \
  --apply
```

The publish step does not rerun sync. It validates the current `HEAD`, records
the remote tip, and then pushes only if the local `HEAD` and remote tip remain
unchanged. `sync --push` is rejected; use `publish --apply` after reviewing
the sync result.

### Adopt an upstream PR temporarily

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js adopt 3352</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js adopt 3352 --apply</command>
</example>

### Generate and review a cleanup plan

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --base origin/master --generate .docs/fork-sync-state/my-branch-cleanup.json</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --json</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --apply</command>
</example>

When every commit after a known base should be removed, use the simpler
contiguous-history operation instead of generating a plan:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --truncate --base af61c3a7 --json</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --truncate --base af61c3a7 --apply --skip-validation</command>
</example>

`--truncate` creates a `backup/*` ref before resetting the current branch to
the base. It is intended for removing a complete trailing stack, not for
selective cleanup.

### Restore a worktree backup

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js restore --backup backup/test-latency-refresh-sandbox-1787409921031</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js restore --backup backup/test-latency-refresh-sandbox-1787409921031 --apply</command>
</example>

`restore --apply` is an explicit recovery operation. It resets only the
currently checked-out branch to the named backup ref; verify the ref before
using it.

List available recovery backups before restoring one:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js backup --list</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js backup --list --json</command>
</example>

Create a backup of the currently checked-out branch before a manual rebuild.
Preview first; `--apply` creates the local `backup/*` ref:

```sh
node .docs/scripts/git-sync-toolkit/cli.js backup --create
node .docs/scripts/git-sync-toolkit/cli.js backup --create --apply
```

The automatic name includes the current branch and a timestamp. To choose a
suffix explicitly:

```sh
node .docs/scripts/git-sync-toolkit/cli.js backup \
  --create before-test-master-rebuild \
  --apply
```

Backups are local `backup/*` branches; listing them never changes refs.
Preview and then explicitly delete an individual backup:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js backup --delete backup/master-1787422109630</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js backup --delete backup/master-1787422109630 --apply</command>
</example>

Deletion never accepts refs outside `backup/*`, deletes only the exact
validated ref, and uses `--apply` as a mandatory confirmation.

Cleanup also supports local-only worktree branches that do not yet have a
matching `origin/<branch>`; validation still runs, but publishing requires a
separate remote branch decision.

### Validate and publish separately

`cleanup --apply` runs the configured validation command after rebuilding the
branch. Publishing is a separate operation:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js publish --validate --branch master</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js publish</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js publish --apply</command>
</example>

For a rewrite that already completed before validation failed, use
`publish --validate`. It runs validation, records the current local `HEAD` and
remote tip, and does not push. `publish --apply` then compares the live remote
tip and local `HEAD` with the values captured during validation, validates
again, and pushes with `--force-with-lease`. With no `--branch`, publish targets
the currently checked-out branch. If someone changes
`origin/master` or the local result in between, publishing is rejected. It
rejects `upstream`; use `--skip-validation` only when explicitly necessary.

The reference recipe `recipes/worktree-to-origin.sh` shows the safe
worktree-to-fork workflow: select the worktree, verify the branch is clean,
run `publish --validate`, review the captured state, then enable and run
`publish --apply`. The apply step is intentionally commented out in the
recipe and must be enabled after review.

`--generate` preserves every commit initially, includes each commit subject,
and leaves `reason` as `null`. Edit the local plan before applying it: move a
wrongly suggested drop entry into `replay`, add a reason, or group commits
under `subject` to squash them. The toolkit never treats a commit as
disposable solely because its subject contains `debug`, `test`, or `fix`.
Cleanup plans are tied to the pre-rewrite commit graph and are not reusable
after the cleanup has been applied. To repeat or review the operation, restore
the pre-cleanup backup first, then generate a new plan for that branch.

For a correction that must take effect at an earlier replay point, add a
`fixups` entry to the relevant replay group instead of replaying a distant
corrective commit:

```json
{
  "commits": ["ca86107b", "539732ff", "..."],
  "fixups": [{
    "after": "539732ff",
    "patch": ".docs/fork-sync-state/null-byte-fix.patch",
    "reason": "restore the actual null byte at the original fix position"
  }]
}
```

The patch is applied immediately after the referenced commit, before the next
commit or squash completion. This preserves historical ordering and allows the
later corrective commit to be omitted from replay. Patch paths are resolved
relative to the command's launch directory.

To change a classification without editing JSON manually, preview the
modification first and add `--apply` to write it:

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh"</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh" --apply</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 5a7937a7 --action squash --into ed2fa750 --subject "fix(router): record error outcomes in usageHistory" --reason "combine duplicate error-recording fixes" --apply</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --move-before ca86107b --apply</command>
</example>

Backups are Git refs. Toolkit ledger, progress, and patch snapshots are stored
outside the repository under `/tmp/git-sync-toolkit/<repository-key>/`, so the
toolkit does not require repository-local `.docs` directories or ignore rules.
If cleanup stops on a conflict, resolve and stage the files, then resume the
plan:

<example>
<command>git status</command>
<command>git add &lt;resolved-files&gt;</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --continue</command>
</example>

Cleanup persists its current plan position before each cherry-pick.
`cleanup --continue` uses that progress record, preserves the staged resolution
for the interrupted `--no-commit` cherry-pick, and resumes the remaining group
and later groups even when `CHERRY_PICK_HEAD` is unavailable.
If incoming changes should always win, add `--auto-accept-incoming` to both the
initial cleanup command and any continuation command. This selects `theirs`
for every conflicted path and stages the result; review the resulting diff.

If the initial cleanup stopped because `--auto-accept-incoming` was omitted,
do not rerun the initial `--apply` command. Continue the interrupted cleanup
and add the flag:

```sh
node cli.js cleanup \
  --plan path/to/plan.json \
  --worktree feature/my-work \
  --continue \
  --auto-accept-incoming
```

The toolkit resumes from persisted cleanup progress, accepts the incoming
version for unresolved paths, stages those files, and continues the remaining
replay. Review the resulting diff before publishing.

Cleanup verifies that the plan branch matches the currently checked-out branch
and reports the detected worktree. For a deliberately copied plan, rebind it
explicitly before applying:

```sh
node cli.js cleanup --plan path/to/plan.json --rebind
node cli.js cleanup --plan path/to/plan.json --rebind --apply
```

Rebinding changes only the plan metadata; it does not switch branches or
rewrite commits.

The target worktree can also be selected explicitly when invoking the toolkit
from another directory:

```sh
node /path/to/git-sync-toolkit/cli.js cleanup \
  --worktree /path/to/repository/worktrees/feature \
  --plan /path/to/plan.json
```

`--worktree` accepts either a worktree path or an exact branch name and resolves
branch names through Git's worktree list. It changes the Git working directory
used by the operation; it does not rebind the plan. The plan branch must still
match the branch checked out there. If the plan was intentionally copied to
that worktree, combine both
flags:

Plan and generated-plan paths are resolved relative to the directory where the
toolkit command was launched, before `--worktree` changes Git's working
directory. Absolute paths are also supported.

```sh
node /path/to/git-sync-toolkit/cli.js cleanup \
  --worktree /path/to/repository/worktrees/feature \
  --plan /path/to/plan.json \
  --rebind --apply
```

With `--worktree`, `--rebind --apply` updates only the plan’s `branch` field to
the branch detected in the selected worktree. It does not switch branches,
rewrite commits, or apply cleanup.
To abandon instead, use `git cherry-pick --abort` and restore the generated
backup. Never use this toolkit to push fork changes to `upstream`; upstream
contributions should use separate branches based directly on upstream.
