#!/usr/bin/env bash
#
# provision.sh — provision a new sap-tutorials tutorial repo pair.
#
# Creates, for a product <name>:
#   - <name>              (public  source repo, from tutorial-repo-template)
#   - <name>-Contribution (private QA repo,     from tutorial-repo-Contribution-template)
#   - the content-rebuild notify workflows on each repo
#   - four org teams with the standard admin/maintain grants
#
# The templates already ship the base CI (community-requester-id, label-issues,
# and the two tutorial-ci caller workflows tutorial-pr-checks / tutorial-pr-comment
# pinned @v1) — no tutorial-ci rollout is needed. This script only adds the
# per-repo notify workflow that the templates deliberately omit.
#
# REQUIRES: `gh` authenticated to github.com as a sap-tutorials ORG OWNER, or
# with an active just-in-time (20-minute) admin elevation. A plain org member
# CANNOT create repos or teams; the preflight fails fast in that case.
#
# It does NOT (cannot, without extra org config) do the following — see the
# reminders printed at the end:
#   - install the `sap-tutorials-builder` GitHub App on the new repos
#   - guarantee the org actions secrets TUTORIALS_APP_ID / _PRIVATE_KEY reach them
#
set -euo pipefail

ORG="sap-tutorials"
TEMPLATE_SOURCE="tutorial-repo-template"
TEMPLATE_CONTRIB="tutorial-repo-Contribution-template"
# Canonical repos to copy the (repo-agnostic) notify workflows from.
REF_SOURCE="btp-adai"
REF_CONTRIB="btp-adai-Contribution"
# Admin grant: the org uses a just-in-time custom role first, plain admin as fallback.
ADMIN_ROLE_PRIMARY="admin-ondemand"
ADMIN_ROLE_FALLBACK="admin"
TEAM_ROLE="maintain"

NAME=""
DESCRIPTION=""
ADMINS=""
MEMBERS=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: provision.sh --name <product> --description "<text>" \
                    --admins "user1,user2" --members "user1,user2,user3" [--dry-run]

  --name         product name, e.g. "integration" (avoid marketing product names)
  --description  repo description, applied to BOTH repos
  --admins       comma-separated logins for the *-admin teams (admin grant)
  --members      comma-separated logins for the *-team teams (maintain grant)
  --dry-run      print the gh commands instead of running them
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name)        NAME="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --admins)      ADMINS="$2"; shift 2 ;;
    --members)     MEMBERS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$NAME" ] || { echo "ERROR: --name is required" >&2; usage; exit 2; }
[ -n "$ADMINS" ] || echo "WARN: no --admins given; admin teams will be created empty" >&2
[ -n "$MEMBERS" ] || echo "WARN: no --members given; team teams will be created empty" >&2

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

CONTRIB="${NAME}-Contribution"

# --- Preflight: must be an org admin/owner ---------------------------------
SELF="$(gh api user --jq '.login')"
ROLE="$(gh api "orgs/${ORG}/memberships/${SELF}" --jq '.role' 2>/dev/null || echo "unknown")"
if [ "$ROLE" != "admin" ]; then
  echo "ERROR: '${SELF}' is org role '${ROLE}', not 'admin'." >&2
  echo "       Repo/team creation needs org-owner rights (or active JIT elevation)." >&2
  [ "$DRY_RUN" -eq 1 ] || exit 1
fi

echo "==> Provisioning '${NAME}' (+ '${CONTRIB}') as ${SELF} [role=${ROLE}]"

# --- 1. Repos from templates -----------------------------------------------
echo "==> Creating repos from templates"
run gh repo create "${ORG}/${NAME}" --template "${ORG}/${TEMPLATE_SOURCE}" \
  --public --description "${DESCRIPTION}"
run gh repo create "${ORG}/${CONTRIB}" --template "${ORG}/${TEMPLATE_CONTRIB}" \
  --private --description "${DESCRIPTION}"

# --- 2. Notify workflows (copied verbatim from the reference repos) ---------
# Both notify workflows are repo-agnostic (they use ${{ github.repository }}),
# so no editing is required — copy the current canonical version straight over.
copy_workflow() {
  local ref_repo="$1" wf_path="$2" dst_repo="$3"
  local content
  content="$(gh api "repos/${ORG}/${ref_repo}/contents/${wf_path}" --jq '.content' | tr -d '\n')"
  run gh api --method PUT "repos/${ORG}/${dst_repo}/contents/${wf_path}" \
    -f message="chore(ci): add ${wf_path##*/} rebuild-notify workflow" \
    -f content="${content}"
}
echo "==> Adding notify workflows"
copy_workflow "${REF_SOURCE}"  ".github/workflows/notify-tutorials-ims.yml" "${NAME}"
copy_workflow "${REF_CONTRIB}" ".github/workflows/notify-qa.yml"            "${CONTRIB}"

# --- 3. USE_GITHUB_APP repo variable (belt-and-suspenders vs the org var) ---
echo "==> Setting USE_GITHUB_APP=true repo variable"
run gh variable set USE_GITHUB_APP --body "true" --repo "${ORG}/${NAME}"
run gh variable set USE_GITHUB_APP --body "true" --repo "${ORG}/${CONTRIB}"

# --- 4. Teams --------------------------------------------------------------
# Naming follows the ai-core convention:
#   <name>-admin / <name>-team              -> source repo
#   <name>-contribution-admin / -team       -> Contribution repo
T_ADMIN="${NAME}-admin"
T_TEAM="${NAME}-team"
T_CADMIN="${NAME}-contribution-admin"
T_CTEAM="${NAME}-contribution-team"

create_team() {
  local team="$1"
  echo "==> Creating team ${team}"
  run gh api --method POST "orgs/${ORG}/teams" -f name="${team}" -f privacy="closed" \
    >/dev/null 2>&1 || echo "   (team ${team} may already exist)"
}
for t in "$T_ADMIN" "$T_TEAM" "$T_CADMIN" "$T_CTEAM"; do create_team "$t"; done

add_members() {
  local team="$1" csv="$2"
  [ -n "$csv" ] || return 0
  local IFS=','
  for user in $csv; do
    user="$(echo "$user" | tr -d '[:space:]')"
    [ -n "$user" ] || continue
    echo "==> Adding ${user} to ${team}"
    run gh api --method PUT "orgs/${ORG}/teams/${team}/memberships/${user}" -f role="member" \
      >/dev/null
  done
}
add_members "$T_ADMIN"  "$ADMINS"
add_members "$T_CADMIN" "$ADMINS"
add_members "$T_TEAM"   "$MEMBERS"
add_members "$T_CTEAM"  "$MEMBERS"

# --- 5. Team -> repo grants ------------------------------------------------
grant() {
  local team="$1" repo="$2" role="$3"
  echo "==> Granting ${team} '${role}' on ${repo}"
  if [ "$DRY_RUN" -eq 1 ]; then
    run gh api --method PUT "orgs/${ORG}/teams/${team}/repos/${ORG}/${repo}" -f permission="${role}"
    return 0
  fi
  if ! gh api --method PUT "orgs/${ORG}/teams/${team}/repos/${ORG}/${repo}" \
       -f permission="${role}" >/dev/null 2>&1; then
    echo "   custom role '${role}' rejected; retrying with '${ADMIN_ROLE_FALLBACK}'"
    gh api --method PUT "orgs/${ORG}/teams/${team}/repos/${ORG}/${repo}" \
      -f permission="${ADMIN_ROLE_FALLBACK}" >/dev/null
  fi
}
grant "$T_ADMIN"  "$NAME"    "$ADMIN_ROLE_PRIMARY"
grant "$T_TEAM"   "$NAME"    "$TEAM_ROLE"
grant "$T_CADMIN" "$CONTRIB" "$ADMIN_ROLE_PRIMARY"
grant "$T_CTEAM"  "$CONTRIB" "$TEAM_ROLE"

# --- Post-provision reminders ----------------------------------------------
cat <<EOF

==> Done. Manual follow-ups that need org-owner UI / App admin:
  1. Install the 'sap-tutorials-builder' GitHub App on ${ORG}/${NAME} and
     ${ORG}/${CONTRIB} (Contents:write on ${ORG}/tutorials-ims). Without it the
     notify workflow's App-token step is skipped and dispatch fails.
  2. Confirm org actions secrets TUTORIALS_APP_ID / TUTORIALS_APP_PRIVATE_KEY are
     visible to the new repos (they are org-wide, visibility=all).
  3. Add real tutorials under tutorials/<slug>/ on ${ORG}/${NAME}; the platform
     auto-discovers the repo (no tutorials-ims code change needed).
  4. Optionally mark the tutorial-pr-checks status as Required in branch
     protection if you want the structural checks to block merges.
EOF
