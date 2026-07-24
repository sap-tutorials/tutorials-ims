# Add PROD role-collection authors to a Teams shared channel

**Date:** 2026-07-24
**Status:** Approved (design), pending implementation plan

## Problem

We need to add every "author" in the PROD environment to a Microsoft Teams
**shared** channel. "Authors in PROD by assigned role" means the users assigned
a specific **BTP role collection** in the PROD subaccount. The list must be
sourced automatically (not hand-maintained) and pushed into the Teams channel.

An online snippet was found that uses `Add-MgTeamChannelAllMember` with the
`Group.ReadWrite.All` scope. Both are wrong (see Correctness below); this spec
records the corrected approach.

## Decisions (from brainstorming)

- **Author source:** BTP role collection in the PROD subaccount.
- **Extract method:** one PowerShell script — `btp` CLI reads members, then
  feeds them directly into the Teams-add loop. No manual CSV hand-off.
- **Identity:** authors log into BTP with the same corporate email that is their
  Teams/Entra UPN. No identity-resolution layer needed.
- **Run safety:** the script previews the list and confirms before writing;
  supports `-WhatIf` for a zero-change dry run.

## Architecture

A single script, `Add-AuthorsToTeamsChannel.ps1`, in three stages.

### Stage 1 — Fetch
- Read role-collection members via the BTP CLI:
  `btp --format json get security/role-collection "<name>" --subaccount <guid>`
- Parse JSON, extract assigned **user** emails (ignore any non-user assignments).
- De-duplicate the email list.

### Stage 2 — Preview + confirm
- Print the resolved emails and count.
- `-WhatIf`: show what would be added, make no changes, exit 0.
- Otherwise prompt for explicit confirmation before any write.

### Stage 3 — Add
- Loop over emails calling **`New-MgTeamChannelMember`** against the target
  channel (correct cmdlet for adding a member to a channel).
- Each add wrapped in try/catch. Already-present members and per-user failures
  are caught and recorded — never fatal to the run.

### Parameters
`-RoleCollection`, `-SubaccountGuid` (defaults to current BTP target),
`-TeamId`, `-ChannelId`, `-WhatIf`.

## Correctness points

- **Cmdlet:** use `New-MgTeamChannelMember`, NOT `Add-MgTeamChannelAllMember`
  (the latter is not a real cmdlet).
- **Graph scope:** adding channel members requires `ChannelMember.ReadWrite.All`,
  NOT `Group.ReadWrite.All`.
- **Shared channel semantics:** in a shared channel members are added directly
  and do NOT inherit team membership, so adding to the channel is required and
  correct. This design assumes all authors are **in-tenant** (matches the
  "same email in BTP and Teams" decision). The script guards against
  cross-tenant members by flagging any email whose domain differs from the
  tenant domain and reporting it as **skipped-external** rather than failing.
- **Auth:** two independent sessions — `btp login` (CLI) for the fetch and
  `Connect-MgGraph -Scopes "ChannelMember.ReadWrite.All"` for the add. Both are
  validated up front; the script stops with a clear message if either is
  missing.
- **Idempotency:** re-running is safe. Existing members raise a specific Graph
  error that is caught and logged as "already a member."

## Output / error handling

- End-of-run summary counts: added / already-present / failed / skipped-external,
  with the offending emails listed under each non-empty category.
- Non-zero exit code if any hard failures occurred (CI-friendly).

## Testing

- Structure the fetch/parse logic so it can be exercised against a captured
  `btp` JSON sample without live calls.
- Verify live behavior via: (a) a `-WhatIf` run showing the fetched list with
  zero writes, and (b) a real confirmed run against the channel.

## Run-time inputs required (not needed to author the script)

- Exact role collection name.
- Teams **Team ID** and shared **Channel ID**.
- Subaccount GUID defaults to the current BTP target (`tutorial-system`).

## Out of scope

- Cross-tenant / external (guest) sharing setup.
- Identity resolution between differing BTP and Entra usernames.
- Scheduling / continuous sync (this is a run-on-demand script).
