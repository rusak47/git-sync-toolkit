# Publish a cleaned or updated worktree branch to fork origin.
# This script is reference-only and is intentionally ignored by git.

set -euo pipefail

TOOL=~/Documents/9router/.docs/scripts/git-sync-toolkit/cli.js
WORKTREE=/tmp/sketchbook/9router/worktrees/latency-refresh-sandbox
BRANCH=test/latency-refresh-sandbox
REMOTE=origin

cd "$WORKTREE"
test "$(git branch --show-current)" = "$BRANCH"
git status --short --branch

# Publishing requires a clean worktree. Review the exact local result first.
node "$TOOL" publish --worktree "$WORKTREE" --remote "$REMOTE" --branch "$BRANCH" --validate

# Review the validation output above, then publish with force-with-lease.
# The toolkit rejects upstream and refuses publication if the remote or local
# HEAD changed after validation.
#node "$TOOL" publish --worktree "$WORKTREE" --remote "$REMOTE" --branch "$BRANCH" --apply

# Verify the published tip.
#git fetch --prune "$REMOTE"
#git log --oneline --decorate -3
#git ls-remote "$REMOTE" "refs/heads/$BRANCH"
