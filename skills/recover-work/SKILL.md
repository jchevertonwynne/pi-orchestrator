---
name: recover-work
description: Recover interrupted orchestrated work without duplicating external effects or touching foreign sessions. Use when a Zellij task session closes, an agent stalls or exits, a release lock appears stale, notifications repeat, recorded Git/deployment state disagrees with reality, or draft WIP publication is interrupted.
compatibility: Pi 0.87.1, Node 24+, Git, Zellij, and the standalone orchestrator extension.
---

# Recover work

Read [the interface and trust contract](../orchestrate-work/references/interface.md)
and [the recovery checklist](references/recovery-checklist.md) before resuming or closing anything.

## Establish identity and preserve evidence

Inspect `orchestrator_status` and the affected `orchestrator_agent` once.
Capture the task, plan/approval hash, agent generation, process/session identity,
transcript location, last messages/results, release owner/token, and resource reservations.
Preserve logs and dirty worktrees before changing state.

A closed Zellij session is not proof that its Pi process is gone.
An old heartbeat is not proof of failure;
an idle agent may simply be waiting for a dependency or human decision.
Distinguish a stalled or uncertain observation from an evidenced failed attempt.
Use `Result.status: blocked` for unresolved prerequisites/identity,
and `failed` for an observed failed attempt;
neither `stalled` nor `failed` is a `Task.state`.

An idle-owner notice means actionable work has no recorded blocker or human question.
First message the owner with its concrete next step or ask it to record a blocker note;
most stalls are a missed handoff, not a dead process.
Move to process inspection only if the owner does not respond or its process is absent.

Check the recorded session, tab, pane, PID, process command/start identity,
worktree, and transcript against current OS/Zellij observations.
A matching name or reused PID alone is insufficient.
Do not type into, adopt, kill, or close a same-name foreign pane/session.
If the old process is still running, do not create a second writer.
If its absence cannot be proven, report a blocker and ask for reconciliation.

## Reconstruct external truth first

For interrupted draft WIP publication,
use [publication recovery](../orchestrate-work/references/publication.md#recovery-state-and-compatibility).
Inspect the separate grant/observed ledger and actual remote draft/head/base/repository state;
missing records are not permission to replay a create or push.

Read actual Git commits, refs, worktree changes, remote PR head/merge/check state,
live service revisions and mounts, and applied migration versions/checksums as relevant.
Compare them with recorded checkpoints and the approved plan.
Do not blindly replay a push, merge, migration, deployment, or cleanup
because a transcript or registry entry stopped before its acknowledgement.

Recover successful external actions by recording observed facts through supported operations
under valid release ownership.
In a light registry, the coordinator may re-claim the release of an owner proven exited,
receiving a new token, then record the observed stages.
If that release held the deploy lock, the coordinator adopts the lock too:
reconcile whether a deployment was in flight, record what actually happened,
then unlock with a reason.
While the owner may still be live, neither the release nor its lock can be adopted.
A fork family's shared deploy lock follows the same rule inside the holder's own registry:
only that orchestrator's coordinator can adopt it.
Never attach to, edit or adopt a sibling fork's registry;
if a sibling orchestrator itself is gone while holding the lock, escalate to the human.
Do not infer approval from old markers or acquire authority from stale state.
Keep required but inaccessible evidence explicitly `UNVERIFIED`.
Use the release skill if further authorized external actions are needed.

An apparently stale release lock has no time-based expiry in this contract.
Reconcile the owner and external effects before a token-matched `unlock` with a reason.
If ownership/token recovery is unsupported or the owner may be live,
escalate to the human instead of editing the registry or stealing the lock.

## Resume exactly once

After proving the old process is gone, use `orchestrator_agent` resume
for the exact recorded Pi transcript and worktree,
with a fresh `Agent.generation` so stale producers cannot masquerade as the resumed agent.
Keep the `piSessionId`/`sessionFile` tied to that transcript;
do not choose the newest session, a partial ID, or a fork by convenience.
If the file is missing or mismatched, stop rather than silently create a replacement history.

Resume with the worker's recorded model and effort.
New nested launches default to the parent's current model and medium effort;
optional `model: "provider/model-id"` and `thinking` override these defaults on spawn or fork.
Report model unavailability without fallback.
Resume only in a named interactive Pi tab in a separate owned task-specific Zellij session,
with terminal stdin/stdout and the dedicated session directory.
No print mode, output pipes/redirection, or detached Pi process outside Zellij.
Verify the TUI using its exact registered session/tab/pane after launch.
Live siblings remain in the same shared task session when one worker resumes.
If the entire session was lost,
prove all old worker PIDs dead before the runtime elects a fresh short session name;
do not attach to an EXITED session and resurrect its old commands.
A failed creator proven not to have attempted a worker tab can be retried with a new agent ID,
branch and worktree while retaining failed artifacts.
This includes recorded Git-preflight or artifact-creation failures before a launch manifest exists,
but only without a PID, tab, pane, transcript or heartbeat.
A corrupt manifest or a failure after artifact creation remains ambiguous and blocks recovery.
If artifact creation rejected directory permissions (its launch error names the cause),
restore private (0700) runtime/session directory permissions before retrying.
Never create runtime directories or launch manifests by hand:
`mkdir -p` makes them 0755, which fails every later launch.
A missing launch record is not a reason to create one; `retire` and `close` handle it.
A tab attempt with no PID handshake remains ambiguous and requires operator investigation.

Restore durable inbox state and notification receipts through the runtime's supported recovery path.
Reconcile `Message.id`, `generation`, `deliveredAt`, and `acknowledgedAt`
with the exact transcript before deciding whether an outstanding message needs redelivery.
Preserve notification deduplication receipts;
do not clear them, forge acknowledgements, or type prompts into the pane.
If receipt repair is not exposed safely, report the gap to the coordinator rather than editing JSON.
A delivered message is not evidence its requested external action occurred.

## Observe, collect, and close only owned resources

Send a concise reconciliation/handoff via `orchestrator_message`.
To a live worker it steers by default, arriving after its current tool batch;
pass `followUp` when the handoff should wait until the worker is idle.
Let the cheap watcher notify on changes;
it cannot verify crash recovery, test success, or effect idempotence.
When waiting, explain the blocker and end the turn rather than repeatedly sleeping or polling.

Collect reports, transcript references, and diagnostic logs, then end owned workers with `retire`.
`close` also finishes a worker that is provably gone:
dead PID with its session, tab or launch record already absent.
When recovery finishes the orchestrator's work, close its worker session with `close-session`;
a closed session is never reused, so later spawns or resumes create a fresh one.
Never kill or close worker sessions or tabs with `zellij` directly; the tools record what they closed.
Leave unrelated sessions, services, mounts, worktrees, and branches untouched.
No automatic directory or volume deletion.
Report what was observed, reconciled, resumed, retained, and still blocked.
