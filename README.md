# Git synchronization toolkit

Node ESM, intentionally dependency-free. Run from the repository root:

```sh
node .docs/scripts/git-sync-toolkit/cli.js <operation> [target] [options]
```

All operations are read-only by default. `--apply` is required for fetch,
rebase, cherry-pick, ledger, or patch writes. `--push` is accepted by `land`
and `sync`, uses `--force-with-lease`, and never permits pushes to `upstream`.
`refresh` updates the current branch from its `origin/<branch>` counterpart
using fast-forward when possible, otherwise rebase. Apply operations require a
clean tree; `land` and `sync` create `backup/master-TIMESTAMP`.
Refs are resolved as immutable commits and ancestry is checked before rebasing.
The ledger is schema-versioned and written atomically. Keep `.docs/scripts/samples`
ignored: it is reference material, not executable toolkit code.

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
The source must resolve to a commit and the target branch must not already
exist. Copy previews by default; `--apply` is required to create the branch
and worktree.

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
GIT_SYNC_REPO_ROOT=/path/to/repository \
  node /path/to/git-sync-toolkit/mcp/server.js
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

### Refresh a worktree from fork origin

<example>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef origin/master --apply</command>
<command>node .docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef origin/master --apply --auto-accept-incoming</command>
</example>

Refresh persists its replay position before each cherry-pick. If an apply
stops on a conflict, resolve and stage the files, then resume with:

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
<command>node .docs/scripts/git-sync-toolkit/cli.js sync --target v0.5.56 --apply --push</command>
</example>

`sync` uses the explicit `--base` when supplied; otherwise it uses the
ledger's `lastMergedUpstream` boundary. This preserves fork-local commits
that are already present in `origin/<branch>` while dropping only changes
whose patch IDs or adopted-PR records are represented by the selected
upstream target. The operation validates the rebuilt branch before updating
the ledger and checks the live remote tip again before an optional push.

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
again, and pushes with `--force-with-lease`. If someone changes
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

Backups and patch snapshots are stored in ignored `.docs` state. If cleanup
stops on a conflict, resolve and stage the files, then resume the plan:

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
