# Clean up the latency-routing sandbox history.
# This script is reference-only and is intentionally ignored by git.

SANDBOX=/tmp/sketchbook/9router/worktrees/latency-refresh-sandbox
TOOL=~/Documents/9router/.docs/scripts/git-sync-toolkit/cli.js
PLAN=.docs/fork-sync-state/latency-refresh-sandbox-cleanup.json
TARGET_BRANCH=test/latency-refresh-sandbox

set -euo pipefail
cd "$SANDBOX"
test "$(git branch --show-current)" = "$TARGET_BRANCH"
BASE=$(git merge-base HEAD origin/master)
test -n "$BASE"
git status --short --branch

# Refresh the fork ref, then list recovery points before changing history.
git fetch --prune origin
node "$TOOL" backup --list

# Generate a plan from this exact branch and its fork merge-base. Never copy
# a plan from another worktree: its base, branch metadata, and commit IDs may
# belong to a different history.
mkdir -p .docs/fork-sync-state
node "$TOOL" cleanup --generate "$PLAN" --base "$BASE"
node "$TOOL" cleanup --plan "$PLAN" --json

# Correct the generated classifications for this branch.
node "$TOOL" cleanup --plan "$PLAN" --modify 81f4c3c9 --action drop --reason "already represented in origin/master" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 5adf1676 --action drop --reason "already represented in origin/master" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 7c05ba93 --action drop --reason "equivalent feature already represented in origin/master" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify bec71c44 --action drop --reason "equivalent feature already represented in origin/master" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify a2783bda --action drop --reason "debug-only test commit" --apply

# Squash each iterative fix group into its logical change.
node "$TOOL" cleanup --plan "$PLAN" --modify 539732ff --action squash --into ca86107b --subject "refactor(health): seed DB by provider/model with real samples" --reason "preserve the corrected separator and dependent health seeding changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 5a7937a7 --action squash --into ed2fa750 --subject "fix(router): record error outcomes in usageHistory" --reason "combine duplicate error-recording fixes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 13b51172 --action squash --into a5351761 --subject "feat(dashboard): show circuit cooldown countdown in routing health" --reason "combine dashboard feature and its follow-up helper fix" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify b8d6aa40 --action squash --into 536951ba --subject "feat(health): implement exponential backoff for circuit breaker" --reason "combine circuit-breaker implementation and cooldown persistence fix" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify ba2c7838 --action squash --into f8fd177f --subject "feat(health): implement HALF_OPEN circuit breaker with probe-based backoff" --reason "combine HALF_OPEN implementation and follow-up execution fix" --apply

# Reorder the warmup test before health seeding if the generated plan places it
# later; replay order is significant, while drop order is not.
node "$TOOL" cleanup --plan "$PLAN" --modify 10c38bbf --move-before ca86107b --apply

# Review the final plan, then apply the rewrite. Apply creates a backup branch
# before changing the sandbox and runs configured validation afterward.
node "$TOOL" cleanup --plan "$PLAN" --json
#node "$TOOL" cleanup --plan .docs/fork-sync-state/latency-refresh-sandbox-cleanup.json --apply

#node .docs/scripts/git-sync-toolkit/cli.js cleanup --plan .docs/fork-sync-state/latency-refresh-sandbox-cleanup.json --apply
# Add --auto-accept-incoming to --apply to resolve every conflict using
# incoming changes automatically.

# Verify the result and locate the generated backup.
#git status --short --branch
#git log --oneline --decorate -12
#node "$TOOL" backup --list --json

# If cleanup stops on a conflict:
#git status
#git cherry-pick --continue
#
# Or abandon the cherry-pick and restore the backup listed above:
#git cherry-pick --abort
#node "$TOOL" restore --backup backup/test-latency-refresh-sandbox-TIMESTAMP --apply
# Add --auto-accept-incoming to cleanup --continue for automatic resolution.