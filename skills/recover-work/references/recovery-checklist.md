# Recovery checklist

## Evidence before intervention

| Question | Observe | Do not infer |
| --- | --- | --- |
| Which agent? | Registry ID/generation, exact session/tab/pane, process identity | Display name identifies ownership |
| Is the old writer gone? | OS process identity and Zellij observations agree | Missing tab or stale heartbeat proves exit |
| Which transcript? | Exact `sessionFile`, header ID, `piSessionId`, `sessionDir`, cwd | Latest session is the right session |
| Was the plan approved? | Matching current hash and human source | A done file or assistant sentence is approval |
| Did a release effect happen? | Actual PR/Git/runtime/database evidence | Missing record means retry is safe |
| Was a message handled? | ID/generation, inbox receipts, transcript and resulting facts | `deliveredAt` means successful action |

Retain diagnostic references in reports without exporting secrets.
Use read-only observations first and satisfy environment/credential preflights before remote access.
If required access is unavailable, state `UNVERIFIED` and stop the affected action.

## Exact transcript resume

The runtime owns generation allocation and process launch.
Inspect its exposed resume schema rather than inventing extra fields.
For Pi 0.87.1, `--session <exact file>` opens a known transcript;
`--session-id <exact ID>` opens or creates an ID,
so checking that the intended file exists is essential before relying on an ID.
These two options cannot be combined.
Use the dedicated `--session-dir` and correct worktree.
Do not use `--continue`, a partial ID, the session picker, or `--fork` for exact recovery.
Check the intended active transcript branch;
entries from abandoned branches are not all part of the resumed context.

A generation changes process incarnation, not the historical approval or verification evidence.
Reject or quarantine stale-generation input through supported runtime behavior;
do not relabel old producers as current.
If the runtime cannot fence the old generation or prove single-writer ownership,
keep the recovery blocked.

Explicit model selection is still required even though Pi can restore a transcript's prior model.
Verify the worker's recorded model and effort, not the parent's current model.
Older records without effort default to medium.
Report the detached task session name so the human can attach if desired,
without switching their terminal automatically.

## Receipt reconciliation

1. Preserve registry messages and `notifications` before recovery.
   Notification entries are runtime-managed string-array receipts;
   do not invent their meaning or a reset command.
2. Compare message IDs, recipient, generation, and delivery/acknowledgement timestamps
   with the selected transcript's accepted messages.
   Delivered-but-unacknowledged is ambiguous, not automatically unprocessed.
3. Allow the supported runtime path to restore outstanding delivery and deduplication.
   Check that already-receipted notifications are not repeatedly announced.
   If interrupted acceptance may cause a duplicate, tell the recipient the existing message ID
   through a supported reconciled handoff rather than silently reissuing effects.
4. Before any repeated external request, inspect external truth.
   Inbox delivery and side effects are not a transaction across Git, hosting, databases, and services.

There is no public receipt-edit action in the shared contract.
If the implementation lacks sufficient recovery support,
report that limitation rather than promising exactly-once behavior.

## Scoped release continuation

Preserve `releaseGrants` and each slash grant's pending continuation intent.
The grant and intent commit atomically; a transcript marker cannot create authority.
Match the coordinator, session file/ID, generation and branch anchor before delivery.
A branch entry not yet on disk deduplicates enqueueing but is not acknowledged;
Pi may defer persistence until its first assistant response.
A void send return is not delivery success.
The runtime retries absent-branch undelivered intents after settlement or restart/timer ticks,
even when inbox/result watch is paused.
It does not retarget a stale session/generation or replay external commands.

Treat a repeated grant-ID wake as a reconciliation request, not a second authorization.
Read the exact registry task/hash/action/target scope and actual external state,
then run the read-only pre-action `check` under a valid claimed token.
Historical singleton `releaseAuthorization` is not scoped permission;
ask the coordinator for one genuine TUI re-confirmation of explicit pairs.
Do not use mixed old/new runtimes on the same registry.
If no safe supported path can reconcile a stale continuation, report it rather than editing receipts.

## External reconciliation order

- Preserve local changes and logs; identify immutable commits, original bases, and dependency refs.
- Confirm remote repository and PR identities, current head, checks, merged state, and merge SHA.
- Inspect actual running revision/image and mount source paths before touching a worktree.
- Query applied migration versions and checksums against the actual database.
  Investigate applied-but-unrecorded changes before considering another apply.
- Reconstruct release progress with the coordinator under its existing valid token.
  Unlock only after ownership and effects are resolved,
  never from age alone.

Read [the companion release checklist](../../release-work/references/release-checklist.md)
for squash-base integration, backups, safe branch cleanup,
and post-deployment evidence requirements.

## Recovery report

```text
Task / approved plan hash:
Agent / old generation / exact transcript:
Observed process and session identity / proof old writer gone:
Git, PR, running revision, mounts, applied migrations:
Messages and notification receipts reconciled / ambiguities:
Release lock owner / reconciliation / unlock reason if applicable:
Resume generation / model / owned session-tab-pane:
Collected logs / retained dirty worktrees and dependency refs:
Blocked or UNVERIFIED facts / next decision owner:
```

Do not claim recovery complete merely because a TUI is visible.
The resumed transcript, generation, inbox, ownership, and relevant external facts must agree.
