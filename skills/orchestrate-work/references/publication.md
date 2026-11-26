# Exact-snapshot draft WIP publication

Use `orchestrator_publication` only for human-requested draft publication of explicitly unverified work.
This separate ledger grants no ordinary release, verification, merge, deployment or installation authority.
The coordinator performs every call; workers report the proposed snapshot and limitations to it.
Tasks must be shipping tasks in `implementing`, `ready` or `blocked`,
with current exact-plan human approval, including ancestors, in either profile.

## Confirm, reconcile, check, observe

1. Commit the snapshot locally without rewriting history.
   Resolve its full lowercase SHA and canonical checkout path.
   The local branch named by `headBranch` must point to that exact commit;
   publication uses that same remote head branch.
   Identify the exact GitHub `owner/repository`, base branch and, for update, PR URL.
   Independently reconcile the configured remote with that repository.
2. Write an explicit `findings` summary of unresolved review findings, blockers and limitations.
   State unknowns and incomplete review honestly; this is an attestation,
   not automated discovery or proof that every finding was found.
   The dialog also displays the task state and available note/result blocker context.
3. Request authorization using the exact scope below.
   Only a genuine coordinator TUI Yes grants it;
   the paged dialog defaults to No and requires every page to be reviewed.
   RPC, workers, text references and markers confer no authority.
   Cancellation records nothing.
4. Continue from the tool result, without waiting for another prompt.
   Reconcile actual remote PR/branch state before effects or retries:
   repository, head/base, current head commit, draft status and any existing matching PR.
   Updates require the exact PR to remain open and draft.
   For create, an existing matching draft must be reconciled, not duplicated;
   if updating it requires further effects, request a fresh `update` scope naming its exact URL.
   A non-draft PR is outside this route: stop, rather than converting or updating it implicitly.
5. Call `check` with the grant ID and identical proposal immediately before effects.
   `allowed: true` is a read-only, point-in-time authority check, not remote verification.
   Use only non-force push of that exact branch/commit and draft PR create/update.
   Keep **UNVERIFIED / WIP** in the remote PR title/body,
   with the limitations/findings and existing blockers visible.
   Include the exact snapshot SHA and explain it is not verified or approved for merging.
   Check again if time passes or local/task state changes;
   any snapshot, destination, findings or task-context drift needs fresh confirmation.
   Each new confirmation supersedes that task's earlier WIP grants without deleting their audit history.
6. Obtain file-backed observations of the actual remote draft PR, head commit, repository and branches.
   Record the matching `observed` fields and existing evidence paths.
   These are explicit operator attestations, not automated proof of GitHub truth.
   A create grant binds its first observed PR URL;
   conflicting records reject rather than overwriting history.
   Exact repeated records are idempotent, including after task/local context changes or newer grants supersede execution authority.
   Historical recording uses the original scope and the same coordinator generation/session identity;
   it does not require the local branch or current task context to match the historical snapshot.
   Recording never restores execution permission.
   A recorded grant returns `allowed: false` while its execution context remains current;
   changed or superseded contexts continue to reject execution checks.

This tool executes no remote commands.
Use literal paths/argv in the separately authorized repository procedure;
confirm the SSH/1Password agent before push.
Force push, non-draft publication and every ordinary release action remain outside this grant.

## Synthetic complete flow

These calls are examples, not approval or commands to execute.
Use actual values and a genuine TUI decision in a fresh authorized session.
The SHA below is a placeholder; tests use isolated registries and injected local Git queries only.

Request a create scope:

```json
{
  "action": "request-authorization",
  "scope": {
    "taskId": "search",
    "operation": "create",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repoPath": "/tmp/synthetic-checkout",
    "repository": "example/synthetic",
    "headBranch": "wip/search",
    "baseBranch": "main",
    "draft": true,
    "findings": "UNVERIFIED: independent review unresolved; integration acceptance not run. Summary is not exhaustive discovery."
  }
}
```

After genuine confirmation, reuse that exact proposal as `scope`:

```json
{
  "action": "check",
  "grantId": "returned-create-grant-id",
  "scope": {
    "taskId": "search",
    "operation": "create",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repoPath": "/tmp/synthetic-checkout",
    "repository": "example/synthetic",
    "headBranch": "wip/search",
    "baseBranch": "main",
    "draft": true,
    "findings": "UNVERIFIED: independent review unresolved; integration acceptance not run. Summary is not exhaustive discovery."
  }
}
```

After independently observing publication, record facts:

```json
{
  "action": "record",
  "grantId": "returned-create-grant-id",
  "scope": {
    "taskId": "search",
    "operation": "create",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repoPath": "/tmp/synthetic-checkout",
    "repository": "example/synthetic",
    "headBranch": "wip/search",
    "baseBranch": "main",
    "draft": true,
    "findings": "UNVERIFIED: independent review unresolved; integration acceptance not run. Summary is not exhaustive discovery."
  },
  "observed": {
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repository": "example/synthetic",
    "headBranch": "wip/search",
    "baseBranch": "main",
    "pr": "https://github.com/example/synthetic/pull/1",
    "draft": true
  },
  "evidence": ["/tmp/synthetic-evidence/pr.json"]
}
```

For an update, request fresh authorization with `operation: "update"`,
`pr: "https://github.com/example/synthetic/pull/1"`,
the new full committed SHA and current findings.
Keep all other scope fields explicit.
After Yes, check using the returned update grant ID and identical update proposal;
reconcile the exact draft PR before effects,
then record with that proposal, the matching new observed commit and existing evidence files.
Never substitute an ordinary `orchestrator_release` call for any of these steps.

## Recovery, state and compatibility

Inspect `orchestrator_status` with the task ID for full grant and observed-record history.
The board/details show the exact WIP snapshot and whether publication was recorded;
that display is historical, not a live authority check or external-state observation.
WIP records never change task state, result, verification, blockers, locks or normal releases,
and never freeze corrections or count as shipped or complete.
`start`, correction, resubmission and independent verification keep their normal gates.
Existing normal release freezes remain in force.

If effects may have succeeded before recording, inspect actual remote truth first.
Do not repeat create/push/update merely because no record exists.
Record reconciled historical facts under the original grant and exact original proposal/destination,
even if local corrections advanced the branch or task context changed or that grant was superseded.
The original coordinator generation and session ID/file must still own the audit identity;
replacement coordinators/generations cannot adopt it implicitly.
Exact retries return the immutable original record; conflicts reject.
Fresh confirmation remains required before any new external effect under changed context,
and historical recording never revives stale or superseded execution authority.
Retain the old audit entries and evidence, and report inaccessible truth as **UNVERIFIED**.
There is no automatic replay, executor, lock stealing or cleanup authority.

Legacy version-1 registries remain readable and writable with unchanged normal release semantics.
The first confirmed WIP grant promotes the snapshot to version 2 atomically;
cancellation leaves it unchanged, and downgrade is rejected.
Older runtimes reject version-2 snapshots on open/read/transaction load,
including an already-open writer, rather than ignoring the new authority ledger.
Use only publication-aware runtimes for that registry thereafter.
Bootstrap candidate validation requires a separately approved fresh interactive Pi session
with a new isolated registry; do not reload or change existing sessions or settings.
Publication permission does not authorize installing the candidate.
