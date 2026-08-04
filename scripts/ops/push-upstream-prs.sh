#!/usr/bin/env bash
# @file push-upstream-prs.sh
# @description Push clean feature branches to fork and open PRs against diegosouzapw/OmniRoute release/v3.8.49
#
# @changes
# - [2026-07-28] [Composer] - Initial push + gh pr create script for 7 upstream PRs
set -euo pipefail

BASE="release/v3.8.49"
UPSTREAM="diegosouzapw/OmniRoute"
FORK="AndrianBalanescu/OmniRoute"
REMOTE="fork"

branches=(
  "fix/deepseek-web-tool-calling"
  "fix/combo-runtime-unit-concurrency"
  "fix/antigravity-quota-and-project-selection"
  "fix/usage-provider-window-costs-sql"
  "feat/alibaba-free-tier-routing"
  "fix/combo-least-used-and-wildcard-ui"
  "feat/raycast-oauth-provider"
)

titles=(
  "fix(deepseek-web): enable toolCalling on all models"
  "fix(combo): fail-fast concurrency gate and execute-mode overflow"
  "fix(antigravity): quota-aware account selection and projectId persistence"
  "fix(usage): aggregate provider window costs in SQL"
  "feat(alibaba): free-tier routing with live quota sync"
  "fix(combo): least-used quota strategy and wildcard UI preservation"
  "feat(oauth): add Raycast Pro provider with local auto-import"
)

bodies=(
  "Enables tool calling for DeepSeek Web models and fixes invalid supportsTools registry property."
  "Adds fail-fast concurrency gating for combo runtime units and execute-mode overflow to the next unit when the first connection is at cap."
  "Improves Antigravity routing: per-model quota handling, projectId persistence, and skipping quota-exhausted accounts during selection."
  "Moves provider window cost aggregation into SQL for correct usage reporting."
  "Adds Alibaba free-tier routing with console quota sync, builtin allowlist pack, and live-quota preference over static lists."
  "Improves least-used combo strategy with quota-weighted selection, session usage counts, and wildcard step preservation in the control center."
  "Adds Raycast Pro as an OAuth provider with local credential auto-import, executor, and dashboard auth modal."
)

echo "Fetching origin/${BASE}..."
git fetch origin "${BASE}"

for i in "${!branches[@]}"; do
  branch="${branches[$i]}"
  echo "=== Pushing ${branch} ==="
  git push -u "${REMOTE}" "${branch}"
done

for i in "${!branches[@]}"; do
  branch="${branches[$i]}"
  title="${titles[$i]}"
  body="${bodies[$i]}"
  echo "=== Creating PR for ${branch} ==="
  gh pr create \
    --repo "${UPSTREAM}" \
    --head "AndrianBalanescu:${branch}" \
    --base "${BASE}" \
    --title "${title}" \
    --body "$(cat <<EOF
## Summary
${body}

## Test plan
- [ ] \`npm run lint\`
- [ ] \`npm run test:unit\` (focused tests on changed areas)
- [ ] Manual smoke on affected provider/combo paths

EOF
)"
done

echo "Done. Open PR list:"
gh pr list --repo "${UPSTREAM}" --head "AndrianBalanescu" --state open
