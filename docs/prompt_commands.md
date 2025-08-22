# Agent Handoff Prompt/command

pnpm tsx services/arb-mm/scripts/agent_handoff.ts

# Push to Github

# stage everything including untracked files
git add -A

# commit (skip pre-commit hook since you don't have lint-staged installed)
git commit -m "update: latest changes pushed" --no-verify

# push to GitHub
git push origin main
