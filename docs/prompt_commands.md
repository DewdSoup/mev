# Agent Handoff Prompt/command

pnpm tsx services/arb-mm/scripts/agent_handoff.ts

# Push to Github

# stage everything including untracked files
git add -A

# commit (skip pre-commit hook since you don't have lint-staged installed)
git commit -m "update: latest changes pushed" --no-verify

# push to GitHub
git push origin main


##############################

# Rebuild Git
# nuke everything not in git
git reset --hard origin/main
git clean -xfd

# fresh install
pnpm install

# build workspace (generates dist for all internal packages)
pnpm -r build

# run
pnpm live
