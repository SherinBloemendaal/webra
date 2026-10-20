#!/usr/bin/env bash
# Create the Cloudflare API token the deploy workflow uses, with exactly the
# permissions listed in docs/deploy.md, and store it as the GitHub secret
# CLOUDFLARE_API_TOKEN. Asks for an existing token that may create API
# tokens; neither token is ever printed.
#
#   CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_ZONE_ID=<zone id> tools/create-deploy-token.sh
#
# The account id is the one in apps/server/wrangler.jsonc; the zone id is the
# zone that serves the site (dashboard, the zone's Overview, right sidebar).
# Both are given, not looked up, so the token used here needs no zone access.
# Needs curl, jq and an authenticated gh. Run it again to rotate the token
# (the old one is not deleted; remove it in the dashboard).
set -euo pipefail

ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-}
ZONE_ID=${CLOUDFLARE_ZONE_ID:-}
[[ "$ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "set CLOUDFLARE_ACCOUNT_ID to the 32 hex digit account id" >&2; exit 1; }
[[ "$ZONE_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "set CLOUDFLARE_ZONE_ID to the 32 hex digit zone id" >&2; exit 1; }
REPO=SherinBloemendaal/webra
API=https://api.cloudflare.com/client/v4

for tool in curl jq gh; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

read -rsp "Paste a Cloudflare API token that can create tokens (hidden): " ADMIN
echo
[ -n "$ADMIN" ] || { echo "no token given" >&2; exit 1; }

cf() {
  local out
  out=$(curl -sS -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@")
  if [ "$(jq -r '.success' <<<"$out")" != true ]; then
    echo "Cloudflare API error: $(jq -c '.errors' <<<"$out")" >&2
    return 1
  fi
  printf '%s' "$out"
}

# Account-owned tokens use the account endpoints, user tokens the user ones.
if cf "$API/user/tokens/verify" >/dev/null 2>&1; then
  BASE="$API/user/tokens"
else
  cf "$API/accounts/$ACCOUNT_ID/tokens/verify" >/dev/null
  BASE="$API/accounts/$ACCOUNT_ID/tokens"
fi

GROUPS_JSON=$(cf "$BASE/permission_groups")
group() {
  local id
  id=$(jq -r --arg n "$1" '[.result[] | select(.name == $n) | .id][0] // empty' <<<"$GROUPS_JSON")
  [ -n "$id" ] || { echo "permission group '$1' not found" >&2; exit 1; }
  printf '%s' "$id"
}

# Plain assignments, so a missing group stops the script (set -e).
SCRIPTS=$(group 'Workers Scripts Write')
D1=$(group 'D1 Write')
# Replays in accounts: the deploy creates the R2 bucket when it is missing.
R2=$(group 'Workers R2 Storage Write')
ROUTES=$(group 'Workers Routes Write')
ZONEREAD=$(group 'Zone Read')
SETTINGS=$(group 'Account Settings Read')
DNS=$(group 'DNS Write')

BODY=$(jq -n \
  --arg account "com.cloudflare.api.account.$ACCOUNT_ID" \
  --arg zone "com.cloudflare.api.account.zone.$ZONE_ID" \
  --arg scripts "$SCRIPTS" \
  --arg d1 "$D1" \
  --arg r2 "$R2" \
  --arg routes "$ROUTES" \
  --arg zoneread "$ZONEREAD" \
  --arg settings "$SETTINGS" \
  --arg dns "$DNS" \
  '{
    name: "webra GitHub deploy",
    policies: [
      { effect: "allow", resources: { ($account): "*" }, permission_groups: [{ id: $scripts }, { id: $d1 }, { id: $r2 }, { id: $settings }] },
      { effect: "allow", resources: { ($zone): "*" }, permission_groups: [{ id: $routes }, { id: $zoneread }, { id: $dns }] }
    ]
  }')

CREATED=$(cf -X POST "$BASE" --data "$BODY")
unset ADMIN
TOKEN=$(jq -r '.result.value // empty' <<<"$CREATED")
unset CREATED
[ -n "$TOKEN" ] || { echo "Cloudflare returned no token" >&2; exit 1; }

printf '%s' "$TOKEN" | gh secret set CLOUDFLARE_API_TOKEN -R "$REPO"
unset TOKEN
echo "Created the token 'webra GitHub deploy' and stored it as CLOUDFLARE_API_TOKEN in $REPO."
