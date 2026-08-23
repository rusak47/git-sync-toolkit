# Update a sandbox worktree from its fork origin while preserving local commits.
# This script is reference-only and is intentionally ignored by git.

SANDBOX=/tmp/sketchbook/9router/worktrees/latency-refresh-sandbox
TOOL=~/Documents/9router/.docs/scripts/git-sync-toolkit/cli.js
REMOTE_REF=origin/master

cd "$SANDBOX"

# Never apply with uncommitted changes.
git status --short --branch

# Preview the update. Review kept/dropped commits and the selected action.
node ~/Documents/9router/.docs/scripts/git-sync-toolkit/cli.js refresh --remoteRef "$REMOTE_REF" --json

# Apply only after reviewing the preview. This fetches origin, creates a
# backup/<branch>-TIMESTAMP ref, and fast-forwards or rebuilds the worktree.
node "$TOOL" refresh --remoteRef "$REMOTE_REF" --apply --auto-accept-incoming --json

# Confirm the resulting worktree and locate the recovery backup.
git status --short --branch
git log --oneline --decorate -8
git branch --list 'backup/*' --sort=-creatordate | head -5

# If refresh stops during cherry-pick, inspect the conflict, then either:
#   git cherry-pick --continue
# or abandon the in-progress operation and restore the pre-refresh backup:
#
#git cherry-pick --abort
#node "$TOOL" restore --backup backup/test-latency-refresh-sandbox-TIMESTAMP --apply
#
# The backup ref is not changed or deleted by restore. Do not push from this
# workflow; refresh updates the local worktree from origin only.