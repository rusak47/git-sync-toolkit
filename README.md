# 9router upstream toolkit

Node ESM, intentionally dependency-free. Run from the repository root:

```sh
node .docs/scripts/upstream/cli.js <operation> [target] [options]
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

## Examples

### Inspect and classify changes

<example>
<command>node .docs/scripts/upstream/cli.js analyze upstream/master --json</command>
<command>node .docs/scripts/upstream/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/upstream/cli.js landed upstream/master</command>
<command>node .docs/scripts/upstream/cli.js reset-candidates upstream/master</command>
</example>

### Refresh a worktree from fork origin

<example>
<command>node .docs/scripts/upstream/cli.js refresh</command>
<command>node .docs/scripts/upstream/cli.js refresh --remoteRef origin/master --apply</command>
</example>

### Land a feature branch into fork origin

<example>
<command>node .docs/scripts/upstream/cli.js classify --branch feature/my-work</command>
<command>node .docs/scripts/upstream/cli.js land --branch feature/my-work --apply</command>
<command>node .docs/scripts/upstream/cli.js land --branch feature/my-work --apply --push</command>
</example>

### Sync fork origin from an upstream tag or commit

<example>
<command>node .docs/scripts/upstream/cli.js sync --target upstream/master --json</command>
<command>node .docs/scripts/upstream/cli.js sync --target v0.5.56 --apply</command>
<command>node .docs/scripts/upstream/cli.js sync --target v0.5.56 --apply --push</command>
</example>

### Adopt an upstream PR temporarily

<example>
<command>node .docs/scripts/upstream/cli.js adopt 3352</command>
<command>node .docs/scripts/upstream/cli.js adopt 3352 --apply</command>
</example>

### Generate and review a cleanup plan

<example>
<command>node .docs/scripts/upstream/cli.js cleanup --base origin/master --generate .docs/fork-sync-state/my-branch-cleanup.json</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --json</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --apply</command>
</example>

### Restore a worktree backup

<example>
<command>node .docs/scripts/upstream/cli.js restore --backup backup/test-latency-refresh-sandbox-1787409921031</command>
<command>node .docs/scripts/upstream/cli.js restore --backup backup/test-latency-refresh-sandbox-1787409921031 --apply</command>
</example>

`restore --apply` is an explicit recovery operation. It resets only the
currently checked-out branch to the named backup ref; verify the ref before
using it.

List available recovery backups before restoring one:

<example>
<command>node .docs/scripts/upstream/cli.js backup --list</command>
<command>node .docs/scripts/upstream/cli.js backup --list --json</command>
</example>

Backups are local `backup/*` branches; listing them never changes refs.
Preview and then explicitly delete an individual backup:

<example>
<command>node .docs/scripts/upstream/cli.js backup --delete backup/master-1787422109630</command>
<command>node .docs/scripts/upstream/cli.js backup --delete backup/master-1787422109630 --apply</command>
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
<command>node .docs/scripts/upstream/cli.js publish --validate --branch master</command>
<command>node .docs/scripts/upstream/cli.js publish</command>
<command>node .docs/scripts/upstream/cli.js publish --apply</command>
</example>

For a rewrite that already completed before validation failed, use
`publish --validate`. It runs validation, records the current local `HEAD` and
remote tip, and does not push. `publish --apply` then compares the live remote
tip and local `HEAD` with the values captured during validation, validates
again, and pushes with `--force-with-lease`. If someone changes
`origin/master` or the local result in between, publishing is rejected. It
rejects `upstream`; use `--skip-validation` only when explicitly necessary.

`--generate` preserves every commit initially, includes each commit subject,
and leaves `reason` as `null`. Edit the local plan before applying it: move a
wrongly suggested drop entry into `replay`, add a reason, or group commits
under `subject` to squash them. The toolkit never treats a commit as
disposable solely because its subject contains `debug`, `test`, or `fix`.

To change a classification without editing JSON manually, preview the
modification first and add `--apply` to write it:

<example>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh"</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --action replay --reason "retain warmup behavior; debug logging is still useful during origin refresh" --apply</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 5a7937a7 --action squash --into ed2fa750 --subject "fix(router): record error outcomes in usageHistory" --reason "combine duplicate error-recording fixes" --apply</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --modify 10c38bbf --move-before ca86107b --apply</command>
</example>

Backups and patch snapshots are stored in ignored `.docs` state. If cleanup
stops on a conflict, resolve and stage the files, then resume the plan:

<example>
<command>git status</command>
<command>git add &lt;resolved-files&gt;</command>
<command>node .docs/scripts/upstream/cli.js cleanup --plan .docs/fork-sync-state/my-branch-cleanup.json --continue</command>
</example>

Cleanup persists its current plan position before each cherry-pick.
`cleanup --continue` uses that progress record, preserves the staged resolution
for the interrupted `--no-commit` cherry-pick, and resumes the remaining group
and later groups even when `CHERRY_PICK_HEAD` is unavailable.
If incoming changes should always win, add `--auto-accept-incoming` to both the
initial cleanup command and any continuation command. This selects `theirs`
for every conflicted path and stages the result; review the resulting diff.
To abandon instead, use `git cherry-pick --abort` and restore the generated
backup. Never use this toolkit to push fork changes to `upstream`; upstream
Never use this toolkit to push fork changes to `upstream`; upstream
contributions should use separate branches based directly on upstream.
