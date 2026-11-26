---
name: release-work
description: Release orchestrated work through scoped pushes, PRs, merges, deployments, exact-commit local installation, or explicitly unverified draft WIP publication. Use before these actions in an orchestrated run. Covers human permission, verification, release ownership, locks, evidence, dependencies, and migrations. Light owners release their own non-risky tasks. Strict and risky tasks require independent verification. Use recover-work for uncertain effects or interrupted releases.
compatibility: Pi 0.87.1, Node 24+, Git, and the standalone orchestrator extension; project-specific release tools only when authorized.
---

# Release work

Read [the interface and trust contract](../orchestrate-work/references/interface.md)
and [the release checklist](references/release-checklist.md) before release actions.
Use repository-specific release procedures rather than inventing deployment commands.

For explicitly unverified draft WIP publication,
follow [the separate publication flow](../orchestrate-work/references/publication.md).
It uses `orchestrator_publication`, not an ordinary release grant or verification bypass.

**Push only:** Follow the [push intent rule](../orchestrate-work/SKILL.md#push-intent-for-a-new-request) for a new eligible root in request-scoped mode.
Use `orchestrator_request` before start for one genuine TUI confirmation of the exact plan, repository, remote URL and full branch ref.
Once the human confirms, the coordinator can continue after exact-commit verification without another human prompt.
Before the push, confirm the actual push URL and destination are still eligible; for a PR, confirm it is open and this is its head repository and branch.
Check that the SSH/1Password agent is live and required checks, including any secret review, passed on the exact candidate.
Confirm the remote head has not moved and the update is a fast-forward.
Then use `orchestrator_scoped_push` as coordinator: `claim`, then `check` immediately before the effect.
Push the checked SHA to the checked URL and ref once, without force or tags.
Confirm the remote ref and, for a PR, GitHub's head equal that SHA before `record` with evidence.
Stop if checks fail or scope or head changes. If effects are uncertain, reconcile before retrying.
`abandon` consumes the claim without reporting success.
An implementation-only grant cannot push. Never substitute a PR grant for a missing push-only grant.
This route gives workers no authority and does not change staged or legacy release rules.

**Ordinary release:** Nothing ships without an exact current-plan task/action grant in this registry.
Clarify ambiguous references such as “these” and deployment targets before proposing scope.
The coordinator uses `orchestrator_release` `request-authorization` with exact
`scope: [{ taskId, action: "pr" | "merge" | "deploy", deploymentTarget? }]` pairs,
or the explicit local-install scope described below.
One genuine TUI confirmation grants only those pairs.
Its paged scope view keeps navigation/Cancel visible and defaults to No;
Yes becomes selectable on the final page only after all pages were displayed.
Resize resets the review and choice; never simulate the human's final Yes.
`pr` includes its required branch push, not merge or deployment.
`deploy` requires an explicit target that must match checks and checkpoints.
The explicit alternative is `/orchestrator authorize-releases <JSON exact pairs>`.
RPC, source labels, transcript roles, startup prompts and markers never bypass confirmation.
Historical wildcard `releaseAuthorization` requires scoped re-confirmation;
never run mixed old/new runtimes against one registry.

After Yes, continue via the tool result or slash command's durable follow-up without another nudge.
Reconcile external truth first; a repeated wake never means replay commands.
Claim for ownership/token; every external action then needs a passing `check`
(`taskId`, `operation` and, for deploy, `deploymentTarget`).
`claim`, `record` and `lock` return `next` with that check already run,
so act on `next.allowed` straight away instead of calling `check` again.
Call `check` yourself only when time has passed or something may have changed;
one check covers every command of its operation, so do not re-check between deploy commands.
As the release's owner you may omit `token`; the error for anyone else names the owner.
In light registries, tasks sharing one PR or deploy may pass `taskIds` instead of `taskId`
to `check`, `claim` or `record` together; the batch is all or nothing.
Check does not mutate state or execute commands; claim does not widen authority.
Missing permission means stop that action and ask the coordinator to propose it.
Check the SSH/1Password agent is live before fetching or pushing.

## Local installation of a verified commit

Use the separate `local-install` route for a local-only destination, not a fake PR/merge.
This requires a shipping task, current human plan approval and exact-commit verification
in either profile; only a coordinator/release role may act.
In light mode, ask the human to approve the plan before start;
approving a verified light task later keeps its result only while the plan bytes match its verification,
and the grant dialog then says the plan was approved after verification.
Any other late approval clears the result, so the owner republishes and re-verifies first.
Request scope `{ taskId, action: "local-install", commit, installationTarget }`.
The genuine TUI confirmation binds the full verified SHA and absolute normalized local path.
No PR, merge, deploy or cleanup permission is implied.
Do not mix release routes for one task/current plan.

Claim explicitly with `operation: "local-install"`, `commit` and `installationTarget`.
Claim takes the serial/family lock in both profiles and freezes the candidate.
Use `next`, or check with the same exact fields if state may have changed.
Before executing the project's separately approved install procedure,
reconcile path ownership/symlinks, current content, backups and existing consumers.
The tool executes nothing and is not a filesystem security sandbox.

After validating the installed revision and behavior,
record `stage: "installed"`, exact `installedCommit`, `installationTarget` and evidence paths.
The route is `claimed → installed → cleaned`; no fabricated merge/deploy fields.
The task becomes `deployed` with an explicit local-install history entry.
Optional cleaned bookkeeping precedes unlock; keep evidence and do not remove files implicitly.
On failure, record blocked and reconcile external truth before another action.
No taskIds batching, owner adoption, automatic install or retry on this route.
Changed commits require fresh confirmation; subsequent installs require new tasks.

When the installed commit also carries other verified tasks' results,
make it one bundled installation: add `repoPath` and an `includes` entry per delivered result
(exact `taskId`, `resultId`, `commit`) to the pair, and the same `includes` on claim.
List only results you have confirmed are in the commit; dependencies and ancestry never enroll a task.
To attach results to an installation already recorded as a singleton,
use the historical `reconcile-install` grant and `reconcile` call: a record, never a reinstall.
See [the interface](../orchestrate-work/references/interface.md#bundled-delivery) for the gates.

Do not use an older runtime to write a registry containing local-install grants.
If the loaded extension lacks this route, prepare a separately approved fresh interactive session
loading the exact verified candidate from its worktree with a new isolated registry.
Do not reload or mutate existing sessions or registries.
That fresh session must still obtain its own genuine exact-commit/target installation grant.

## Light profile: the owner ships

In light registries the top-level owner of a non-risky task ships it:

1. **Prove it in isolation.**
   Run the feature's acceptance in the owner's own Compose project/ports.
   For user-visible changes, capture a screenshot and URL for the human.
2. **Rebase on latest main.**
   Resolve conflicts in your own scope; message a sibling owner directly about shared files.
   Rerun only the focused check affected by the rebase, not every suite.
3. **Publish and verify your own evidence.**
   `result` with `status: ready`, the exact commit, report and evidence files,
   then `verify` that commit with the evidence files you actually produced.
4. **Merge.**
   `claim` (its `next` is the `pr` check), push, open the PR and record `pr`.
   Respect required checks; `record pr` returns the `merge` check. Merge the exact head,
   and record `merged` with the merge SHA (and PR URL).
   If checks fail, fix, publish and verify again; the open release follows the new commit.
   Git serializes merges; do not queue behind other owners.
5. **Deploy under the short lock, if there is a shared deployment.**
   `lock` after recording the merge with the explicit `deploymentTarget` (`record merged` names it in `next`);
   `lock` returns the `deploy` check for that target. Deploy latest main with the repository's command,
   run a short smoke check, record `deployed` with the target and deployed main SHA, then `unlock`.
   One deploy may carry several merged tasks:
   each task needs its own target-specific deploy grant and evidence-backed checkpoint
   while the deploy lock is held.
   Only the release whose owner/task/token matches that lock can pass the deployment execution check;
   other owners may attest the observed batch, not execute a competing deployment.
   Record `deployed` before `unlock`; unlocking first means taking the lock again to record.
   For a coordinator deploying several owners' merged tasks together:
   retire those owners first (you can only adopt an exited owner's release),
   `claim` with `taskIds`, `lock` with one `taskId` and the target (`lock` takes no `taskIds`),
   deploy and smoke once, `record` `deployed` with `taskIds`, then `unlock`.
   If there is no shared deployment, record `cleaned` straight after `merged`.
   In a fork family the lock is shared with sibling orchestrators;
   if a sibling holds it, wait for it rather than deploying around it.
6. **Clean up** only with separate explicit permission and safety checks.
   `cleaned` is bookkeeping, not destructive cleanup authority; report retained resources.

Follow [evidence storage rules](../orchestrate-work/references/evidence.md) for logs, hashes, commands,
shared caches and authorized ad-hoc verification worktree removal.
Write evidence files before recording; `verify` and `record` reject paths that do not exist yet.

Failures go straight back to the owner who caused them;
nobody else re-verifies unchanged evidence.
The coordinator may re-claim the release of an owner that has exited.

### Migrations without a queue

Allocate the next free migration number after rebasing, immediately before merge,
and reserve it then.
If a collision appears, renumber the unapplied migration and rerun its focused upgrade check.
Never edit, reorder or renumber an already-applied migration.

## Gated work: strict profile or risky tasks

Strict registries, and risky tasks in either profile, keep independent release gates.
The PR/merge/deploy sequence below is distinct from the explicit local-install route above.

### Verify the candidate

Inspect the approved plan file, `Task.planHash`, `approval.hash`, result commit and current Git state.
A `ready` result or done marker is only a handoff.
Compare the entire diff at the exact commit against the approved requirements,
including interface changes, unintended scope and each acceptance criterion.
Plan drift needs renewed human approval, not a rewritten marker.

Run the required tests/build and examine their actual exit codes and logs.
When the plan requires SQL, browser behavior or metrics,
collect actual observations against the intended system/version.
A compile, mock, screenshot from another build or self-authored report is not a substitute.
Missing credentials or empty/inconclusive queries leave the claim `UNVERIFIED`.
For risky light tasks, target the review at the risk,
such as a populated-database upgrade or an auth boundary, rather than every behavior.

Integrate current main before final candidate verification,
in a dedicated integration worktree that preserves dirty or unrelated changes.
For squash-merged dependencies, replay only this task's own commits onto current main;
retain the original SHAs and reverify the result.
Record `orchestrator_task` `verify` with the exact `commit` and `evidence`.

### Serialize strict effects

Only the coordinator or release role claims `orchestrator_release` for a verified strict task.
The claim takes the single release lock through push/PR, checks, merge,
current-main build, ordered deployment, post-deploy validation and cleanup.
Each external action requires a read-only check under release ownership.
Use the check in the returned `next` immediately.
Call `check` again if time passes or state may change.
One check covers every command for its operation.
Record each observed checkpoint with existing evidence files.
The deployed SHA must equal the merged SHA.
If current main has advanced, build and verify the exact authorized main commit;
do not silently include unreviewed changes.
A lower active migration reservation in the same scope must merge first.
Risky tasks in a light registry use the light release steps once independently verified.

## Stateful safety in every profile

Before stateful changes, verify backups and recovery options,
reserve shared resources and inspect actual applied migration versions.
Recheck immediately before and after apply:
a reservation or an unapplied migration file does not describe the live database.
Never force required checks, reset state, rewrite applied migrations, delete volumes
or use destructive cleanup to make a release appear successful.

On failure or uncertain external effects, record `blocked` with evidence,
stop that sequence and use the recovery skill to reconcile truth before retrying.
An old `updatedAt` is not permission to steal a lock.
`blocked` and token-owned `unlock` need no new action grant;
they permit safe reporting and relinquishment, not further external effects.

## Finish safely

Recheck the deployed revision, live mounts/resources and applied migration versions
before claiming deployment success.
Delete only confirmed-merged task branches whose exact tips have been checked.
Preserve dirty worktrees, live mounts, uncollected sessions
and Git references still needed by consumers.
Use non-force local deletion; if squash ancestry prevents it, keep the branch and report it.
Managed worktrees follow orchestrator cleanup;
authorized ad-hoc verification worktrees follow the evidence storage rules above.
Report merged/deployed commits, evidence references, `UNVERIFIED` claims
and remaining human decisions; update the task note so the board shows the outcome.
