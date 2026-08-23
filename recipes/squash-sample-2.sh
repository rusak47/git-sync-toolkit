#user: my master drifted by your small commits, i want to squash all toolkit commits into one. how do i do that using the toolkit?

# Preserve the upstream-originated commit immediately before the toolkit.
BASE=af61c3a71d70be5edbcbea53f84c62b9a04aa4c1 # pr before target, so that everything is squashed into one pr
TARGET=fc8f71097b4ac95dad5957c93270a9b8f87d04c1 # starting pr for squash included into
PLAN=.docs/fork-sync-state/toolkit-cleanup.json
TOOL=.docs/scripts/upstream/cli.js

cd ~/Documents/9router
git status

# Generate a plan that includes the initial toolkit commit.

node "$TOOL" cleanup --base "$BASE" --generate "$PLAN"

# Use the initial toolkit commit as the squash TARGET. 
# These are the follow-up commits currently after it on master; each command updates only the local plan.

node "$TOOL" cleanup --plan "$PLAN" --modify af402ef0aec1627ae9899e6b29d39fdd180c774b --action squash --into "$TARGET" --subject "feat(sync): add fork synchronization toolkit" --reason "combine remote-drift publishing safeguards" --apply

# Preview the final plan:

node "$TOOL" cleanup --plan "$PLAN" --json

# Apply the history rewrite only after reviewing the plan:

#node .docs/scripts/upstream/cli.js cleanup --plan "$PLAN" --apply  --auto-accept-incoming

# After cleanup --apply, inspect the rewritten branch and confirm validation
# completed successfully before publishing:

#git status --short
#git log --oneline --decorate -3
#node .docs/scripts/upstream/cli.js publish --branch master
#node .docs/scripts/upstream/cli.js publish --branch master --apply

#Result:
#af61c3a7  upstream-originated history
#<new SHA> feat(sync): add fork synchronization toolkit
#The cleanup command creates a backup/master-TIMESTAMP branch before rewriting
#master. publish --apply revalidates and uses --force-with-lease; it rejects
#remote or local drift since cleanup --apply.