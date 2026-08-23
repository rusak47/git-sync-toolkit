
cd ~/Documents/9router

TOOL=~/Documents/9router/.docs/scripts/upstream/cli.js
BASE=af61c3a71d70be5edbcbea53f84c62b9a04aa4c1 ## TARGET - everything above will be removed from history

git status --short --branch
node "$TOOL" backup --list

#Preview truncation:

node "$TOOL" cleanup --truncate --base "$BASE"  --json

#Capture the current remote tip, then apply:

EXPECTED=$(git rev-parse origin/master)

node "$TOOL" cleanup  --truncate --base "$BASE" --apply  --skip-validation
# --skip-validation  is intentional: the toolkit files are being removed, so its own tests will no longer exist after the reset. The command creates a  backup/*  ref before truncating.

#Verify:

git status --short --branch
git log --oneline --decorate -5
git diff origin/master..HEAD

#Expected result:

#HEAD -> af61c3a7...

#After reviewing, update the fork:

#git push --force-with-lease="refs/heads/master:$EXPECTED"  origin HEAD:refs/heads/master
#git push --force-with-lease="refs/heads/master:25baf097f612fe873970db798c692f341935362b"  origin HEAD:refs/heads/master
