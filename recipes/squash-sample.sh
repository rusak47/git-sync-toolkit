#user: my master drifted, i want to squash all toolkit commits into one. how do i do that using the toolkit?

# Preserve the upstream-originated commit immediately before the toolkit.
BASE=af61c3a71d70be5edbcbea53f84c62b9a04aa4c1
TARGET=730689b8c45b037c0c2aa0c38838b1aa817b4a4d
PLAN=.docs/fork-sync-state/toolkit-cleanup.json
TOOL=.docs/scripts/upstream/cli.js

cd ~/Documents/9router
git status

# Generate a plan that includes the initial toolkit commit.

node "$TOOL" cleanup --base "$BASE" --generate "$PLAN"

# Use the initial toolkit commit as the squash target. These are the commits
# currently after it on master; each command updates only the local plan.

node "$TOOL" cleanup --plan "$PLAN" --modify 72f04202 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify d297bd80 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify d4de13bc --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify cc4fca65 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify b44bcfd5 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 09768753 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 70ee5f3f --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 1ed82611 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify d8e53b01 --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply
node "$TOOL" cleanup --plan "$PLAN" --modify 8fff639f --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine toolkit follow-up changes" --apply

# Preview the final plan:

node "$TOOL" cleanup --plan "$PLAN" --json

# Apply the history rewrite only after reviewing the plan:

#node "$TOOL" cleanup --plan "$PLAN" --apply --auto-accept-incoming

#Result:
#af61c3a7  upstream-originated history
#<new SHA> feat(sync): add fork synchronization toolkit
#The cleanup command creates a  backup/master-TIMESTAMP  branch before rewriting  master . Validate the result before force-pushing anything.