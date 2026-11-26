# Release checklist and evidence

Use project-specific commands with literal argv and paths.
The following is decision guidance, not an executable pipeline or permission grant.

## Exact authorization before effects

1. Clarify task IDs, individual actions and explicit deployment targets with the human.
   “These” does not mean every current/future task or a task/action cross-product.
2. The coordinator proposes exact pairs through `request-authorization`,
   or the human uses `/orchestrator authorize-releases <JSON exact pairs>`.
   One genuine TUI confirmation is required; there is no zero-dialog/RPC grant.
   PR permission includes its required branch push; merge and deploy are independent.
   For push alone, use the previously confirmed `orchestrator_request` grant and `orchestrator_scoped_push` instead.
   Stop if the task, verified commit, repository, URL or destination ref does not match; never substitute PR permission.
3. Read the persisted grant and current plan hash, not a marker, summary or legacy wildcard.
   Claim only after verification to obtain the release token; claim is ownership, not expanded permission.
4. Each external action requires a read-only check after claim.
   `claim`, `record`, and `lock` return `next` with that check complete.
   If `next.allowed` is true, use that check immediately.
   If `next.allowed` is false, stop the external action.
   Call `check` again if time passes or state may change.
   Supply task ID, token, and operation.
   Deploy checks also require the exact `deploymentTarget`.
   One check covers every command for its operation.
   Inspect actual state after interruptions.
5. Continue after confirmation through the tool result or grant-ID slash follow-up,
   without asking for another nudge.
   Paused inbox/result watch does not pause the command's durable continuation.
   A repeated wake or missing checkpoint never means blindly replay an external effect.
6. Require a separate grant for each task recorded in a batched deployment.
   The deployment executor's pre-action check must match the held lock's owner/task/token;
   other owners may record evidence-backed batch attestations under that lock,
   but cannot pass their own deployment execution check or deploy concurrently.
   `cleaned` is bookkeeping, not permission to delete anything.
   Separately authorize cleanup; blocked reporting and token-owned unlock remain safe without new grants.

## Local-install checklist

This is a separate, single-task route, not an exception to ordinary deploy gates.

1. Confirm a shipping task's current human-approved plan and exact verified result SHA.
2. Obtain genuine TUI authorization for `local-install`, full `commit`
   and absolute normalized `installationTarget`.
   A PR/merge/deploy grant is not sufficient; route mixing is rejected.
3. As coordinator/release role, claim with `operation: "local-install"`
   and the exact commit/target; this takes the serial/family lock in either profile.
4. Use the returned pre-action check or recheck when state changes.
   Independently reconcile the destination, symlink resolution, current files,
   live consumers and rollback evidence before the approved external install commands.
5. Validate the installed content and behavior at that exact revision.
   Record `installed` with `installedCommit`, `installationTarget` and existing evidence files.
   Do not supply fictitious PR, mergedCommit or deployedCommit values.
6. Optionally record `cleaned` while locked, then unlock with a reason.
   No destructive cleanup is authorized; the task's deployed state denotes attested local installation.

For a bundle, every included task/result/commit appears in the confirmed scope and on claim;
included tasks freeze with it and are delivered only by the `installed` receipt.
Record an earlier singleton install's bundle only through `reconcile-install`, with evidence.

A changed candidate needs new confirmation; a claimed local candidate is frozen.
Subsequent installs need a new task, and taskIds batching is unsupported.
On uncertainty, record blocked and reconcile before retrying anything externally.
Use only a matching runtime; never introduce the new route into a live old-runtime registry.
A separately approved fresh candidate session/new registry can validate this workflow,
but must obtain its own genuine local-install grant before installation.

## Candidate evidence matrix

Follow [evidence storage rules](../../orchestrate-work/references/evidence.md):
retain small logs, diffs, hashes and exact commands, not binaries or caches.

| Requirement | Evidence to retain | Stop condition |
| --- | --- | --- |
| Approved scope | Plan file/hash, human source, exact diff and commit | Hash drift or unapproved behavior |
| Build/test | Command, cwd, commit, exit code, durable output | Failure or results from a different commit |
| SQL acceptance | Target database identity, read-only query, observed rows/schema/version | Wrong target, denied access, inconclusive result |
| Browser acceptance | Running revision, tested flow, observed result and capture if useful | Unexercised flow or stale build |
| Metrics acceptance | Data source, query, time range, revision/context, actual values | Missing series or unsupported causal inference |
| Release target | Registry/task/current plan hash, exact action grant, remote/repository, explicit environment target | Ambiguous, missing, stale or mismatched authorization |

Do not pipe builds/tests through `head` or another command that hides their exit status.
A green CI label is insufficient when it belongs to a different head or excludes required runtime checks.
Before cluster/cloud operations, perform the user's environment preflight,
including confirming Tailscale is running when required.

## Integrating main and squash bases

1. Inspect worktrees, dirty/untracked files, branches, upstreams, and remote identity.
   Fetch only after the required credential-agent preflight.
   Record the current main SHA and the task's immutable original base/dependency tip.
2. Enumerate the task-owned commits after that dependency tip.
   Review the actual changes;
   a merge-heavy history may need manual commit selection rather than a blanket range.
3. Confirm the dependency PR is merged and identify its squash SHA on main.
   In a fresh owned integration worktree based on current main,
   replay only the task-owned commits in dependency order.
   Do not merge/replay the whole old stacked branch.
4. Resolve conflicts within approved scope, compare the resulting diff with the plan,
   and rerun acceptance checks at the new candidate SHA.
   Keep original dependency tips reachable until all consumers have been rebuilt and checked.

If ownership or the base boundary cannot be proven, block integration instead of guessing.
No force reset, forced push, or rewrite of another agent's worktree is part of this procedure.

## Light owner checkpoints

| Observed external fact | Record |
| --- | --- |
| Own isolated acceptance passed at the rebased commit | `result` ready, then `verify` with those evidence files |
| Ready for a PR or merge | `claim` without `operation`. Retain the token. Use the returned `next` check immediately. |
| PR opened at the expected head | `stage: pr`, `pr`, evidence (optional if merging directly) |
| PR merged; merge SHA on main | `stage: merged`, `mergedCommit`, `pr` if not yet recorded |
| Ready to deploy shared main | `lock` with `deploymentTarget`. Use its returned `next` check immediately. Wait if another owner holds the lock. |
| Main deployed and short smoke passed | `stage: deployed`, exact `deploymentTarget`, `deployedCommit` of deployed main; record all authorized batch tasks before `unlock` |
| No shared deployment, or branch cleanup done | `stage: cleaned`, evidence |

Keep the lock only for deploy and smoke.
Other owners may merge while it is held; the next deploy picks up their merges.

## Strict serialized release checkpoints

| Observed external fact | Record |
| --- | --- |
| Verified candidate and valid ownership | `claim` for `taskId`; retain returned token |
| Authorized PR exists at the expected head, with checks inspected | `stage: pr`, `pr`, existing evidence files |
| PR actually merged; merge SHA verified on main | `stage: merged`, `mergedCommit`, evidence |
| Exact main build is running; required post-deploy checks pass | `stage: deployed`, exact `deploymentTarget`, `deployedCommit`, evidence |
| Authorized cleanup finished with retained resources documented | `stage: cleaned`, evidence |
| Failure, collision, missing evidence, or ambiguous effect | `stage: blocked`, evidence |

Re-read state before a retry.
If an external action succeeded but recording failed,
recover that fact from the external system rather than repeating the action.
A checkpoint is not an exactly-once execution guarantee.

## Stateful ordering

- Identify dependencies among services, schema changes, data backfills, and clients.
  Prefer backward-compatible sequences and a documented rollback/roll-forward decision.
- Check backups exist for the correct target,
  record their location and restoration evidence appropriate to the risk,
  and obtain approval before irreversible changes.
  “Backup configured” is not proof of a usable backup.
- Reserve `migration`, `port`, `compose`, and shared `file` resources as applicable.
  Compare reservations with live users/mounts;
  the registry cannot fence outside processes.
- Query applied migration versions and checksums before allocating/applying a new migration,
  then recheck just before apply under the serialized release owner.
  A collision with an applied version requires investigation and a new forward change where appropriate,
  not renumbering history or marking a missing migration applied.
- Requery after apply and inspect actual service revisions and mounts after restart/deploy.
  Build files and desired compose configuration are not proof of live configuration.

## Branch cleanup without data loss

Confirm repository/remote identity, merged PR head, expected local and remote branch tips,
and that no unmerged new commits appeared after merge.
Recheck just before deletion;
if refs may be changing concurrently, defer or use an explicit expected-tip guard supported by the tool,
not an unrestricted force option.

Check every attached worktree for dirty/untracked files and active users/live mounts.
Check dependent tasks for retained base SHAs and active agents for uncollected logs.
Keep needed objects reachable through durable Git refs before deleting any source branch.
Do not rely on reflog lifetime or a SHA written in Markdown.

Delete only the exact authorized task branch remotely,
then attempt safe non-force local branch deletion when it is no longer checked out.
If it is checked out, dirty, needed by a dependency, or rejected as unmerged after squash,
retain it and explain the blocker.
Never delete main, remove directories, force branch deletion,
or use volume pruning as task cleanup.
Partial cleanup is a reported limitation, not proof all resources were removed.

## Compact release report

```text
Task / approval hash / source:
Release grant ID / exact action pairs / explicit deployment target:
Candidate SHA / verification evidence:
PR / mergedCommit / main-build SHA:
Target / deployedCommit / runtime evidence:
Backups / applied migration versions / live mounts:
Retained branches, worktrees, dependency refs, resources:
Release stage / owner / unlock reason:
UNVERIFIED or blocked items / next human decision:
```
