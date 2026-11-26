# Pi Orchestrator operator reference

New to Pi Orchestrator? Start with the [README quickstart](../README.md).
This reference covers the opt-in workflow for planning, isolated delegation, human approvals,
result handoffs, controlled releases, and recovery.

Do not load a second copy of the package in an existing Pi session.
The package does not replace an existing watcher, import live projects, or alter running agents.

## Request approval policy

New runs default to `request-scoped`; legacy runs without a policy remain `staged` after reload.
Use `/orchestrator policy` to inspect the policy or `/orchestrator policy staged` to opt into the staged workflow.
After reloading the extension, `/orchestrator policy request-scoped` lets the coordinator switch a legacy run for **new requests only**.
The switch itself grants no permission. Pending plans, in-flight work and subtasks do not inherit a new grant.

In request-scoped mode, propose a new root task with `orchestrator_request` before starting work.
The human reviews the complete plan, repository and actions in one TUI confirmation.
“Fix the counter” authorizes no push. For “fix the counter and push to origin/topic”,
resolve the named remote to its push URL and show `refs/heads/topic` in that same confirmation.
If the repository or branch is ambiguous, clarify first. Cancelling grants nothing.
After verification, the coordinator may use `orchestrator_scoped_push` to claim, check and record that single non-force push.
It records an attestation, not proof of remote state, and never executes Git push.
Neither example authorizes opening a PR, merging, deploying or installing; those operations retain their existing gates.

## Profiles

Each registry has a fixed process profile.

- **light** (default for new registries):
  a coordinator dispatches feature owners (at most 10 live subagents per orchestrator),
  and each owner implements, tests in its own isolated stack, rebases, verifies its evidence,
  opens and merges its own PR.
  Only deploying merged main to a shared environment is serialized, by a short deploy lock.
- **strict**: per-task human plan approval, coordinator verification,
  and one serial release lock from PR through cleanup.
  Registries created before profiles existed are strict.

Tasks marked `risky` (migrations, auth/security, data deletion, shared infrastructure)
keep strict approval and independent verification in either profile.

Light is the default because the same owner implements, verifies, and releases non-risky work.
This reduces handoffs without removing the approval and verification gates for risky work.

## Requirements

- Node.js 24 or newer, including built-in `node:sqlite`.
- Pi 0.87.1-compatible extension APIs.
- Git and Zellij for managed worker lifecycle.
- The selected model available in Pi for workers and forks.
  Missing availability is an error, not permission to substitute another model.
  New launches inherit the parent's current model by default;
  pass `model: "provider/model-id"` to spawn or fork to select another exact model.
  See [Thinking defaults](#thinking-defaults) to configure effort for new launches.

Pi supplies the declared peer packages.
No additional runtime dependencies or daemon are required.
SQLite stores private local coordination state;
use a local filesystem, not a shared/network filesystem.

### Thinking defaults

Set the optional `implementationThinking` and `judgementThinking` fields in `~/.pi/agent/model-roles.json`.
If you set `PI_CODING_AGENT_DIR`, use `model-roles.json` in that directory instead.
For example:

```json
{
  "judgement": "provider/judgement-model",
  "implementationThinking": "high",
  "judgementThinking": "high"
}
```

For each new worker or fork, the orchestrator uses `judgementThinking` if the selected model exactly matches `judgement`.
It uses `implementationThinking` for every other model, regardless of the worker's role.
A missing file or missing setting gives `high`.
Pass `thinking` on a launch to override the file.
Valid levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

When you resume a worker, the orchestrator uses its recorded model and thinking level.
Older worker records with no thinking level still use `medium`.

## Try in a new session

Use an absolute path to this checkout:

```sh
pi --extension /absolute/path/pi-orchestrator/src/extension.ts \
  --skill /absolute/path/pi-orchestrator/skills
```

Loading registers commands/tools but launches no processes or timers by itself.
In that new interactive session:

```text
/orchestrator init <run name> [--light|--strict]
/orchestrator
/orchestrator status
/orchestrator board
/orchestrator preflight /absolute/path/repo
```

`/o` is a shorthand for `/orchestrator` and accepts the same arguments.
`/os` is a shorthand for `/orchestrator status`.
`/o a <workitem> [reference]` approves one task's plan;
`/o aa [reference]` approves all pending plans.
Both keep the existing confirmation dialog and plan-hash checks.
The `a` and `aa` aliases also work under `/orchestrator`.

The model can also start orchestration itself with the `orchestrator_init` tool
(optional `name` and `profile`, same rules as the command),
so you need not run init before asking for subagents.
It refuses sessions launched as managed workers or forks.

A run name such as `sample-project` becomes a new timestamped directory,
`~/.local/share/pi-orchestrator/runs/sample-project-20260304-050607`
(spaces become `-`),
so reusing a name never attaches to an earlier run.
A `~/` path or an absolute directory is used as given;
pass one to reopen an existing registry deliberately.
Relative paths and placeholders are rejected,
so a registry is never created inside the checkout.

The directory holds the registry, worker prompts, worker transcripts and launch metadata.
The coordinator keeps its original Pi transcript in its existing session directory.
Pi defers a new transcript's first disk write until an assistant response exists;
initialization alone does not establish a recoverable coordinator transcript.
Treat it as private: prompts and evidence may contain sensitive information.
Do not put it inside a public repository or publish it as an artifact without review.

When you want permanent installation for future sessions:

```sh
pi install /absolute/path/pi-orchestrator
```

Installation changes Pi settings; it is deliberately not part of the development or test process.
Remove that explicit package source with `pi remove` if no longer wanted.

## Workflow

1. Create a task with `orchestrator_task`,
   passing its plan as `planText` (stored as `<run>/plans/<task>.md`) or `planPath` for an existing file.
   The registry records the exact content hash, dependencies and lifecycle separately from agent processes.
   Pass `risky: true` for work that needs strict gates in a light registry.
   Pass `ships: false` for design, research, review or investigation work:
   it is done once ready (light) or verified (gated) and never takes a release.
2. Gated tasks (strict, or risky) need explicit approval of their plan hash:

   ```text
   /orchestrator approve task-id [Crit-session-or-user-approval-reference]
   /orchestrator approve-all [Crit-batch-reference]
   ```

   The reference is optional context recorded with the approval;
   the TUI confirmation is what approves.

   The interactive board's `a` and `A` keys run the same approvals;
   `a` also covers light shipping and verified tasks lacking current recorded approval (see the board keys below).
   Each command asks the human to confirm the exact hashes;
   `approve-all` covers every planned task in one dialog,
   plus a separate section of light verified tasks whose result approval keeps,
   and skips plans or tasks that changed meanwhile.
   A confirmed approval wakes the coordinator to continue,
   so no follow-up prompt is needed.
   A tool result or worker message cannot invoke that approval path.
   A Crit reference is an attestation supplied by the human;
   this package does not silently interpret an arbitrary review file as approval.
   Light non-risky tasks start without per-task approval;
   the human agrees the roadmap in conversation or Crit.
   Local installation, bundling into an installation and draft WIP publication
   still need current plan approval in light mode, ideally before start;
   the board tags such tasks "no plan approval (needed for local install, bundle or WIP)",
   and light `verify` results say so in `next`.
   Approving a light verified task later keeps its result
   only when the confirmed hash, plan file, registered hash and verification hash all match.
   The approval is then recorded as retrospective (`approval.retained`),
   not a review or re-verification, and the install and bundle dialogs say the plan was approved after verification.
   Otherwise approval clears the result and verification:
   a light ready or verified task returns to implementing,
   and implementing or blocked tasks keep their state.
3. Start the task and use `orchestrator_agent` to spawn a worker.
   Spawn and resume automatically run preflight checks before launching;
   failed checks stop the launch and report what needs fixing.
   It gets a dedicated worktree, branch, transcript and named interactive Pi tab.
   Omit `worktree` to create it under `~/.local/share/pi-orchestrator/worktrees`
   rather than beside the repository.
   Sibling and nested workers share one task-specific detached Zellij session,
   separate from the user's current session, so they are easy to inspect together.
   New worker sessions use the bundled minimal layout with one `workers` bootstrap tab,
   rather than the user's default tabs; existing sessions are left unchanged.
   Workers first receive a harmless bootstrap prompt,
   not the task or a resumed-task continuation.
   The task is queued once for that generation only after inspection verifies
   the exact terminal pane, Pi TUI, and live process/persisted-transcript handshake.
   Until then, worker tool calls and normal inbox deliveries are blocked;
   orderly shutdown control remains available, even with monitoring paused.
   A live PID or heartbeat without a visible owned pane is not a successful launch.
   Incomplete launches retain their prompt, manifest, transcript and worktree for inspection.
   This is a workflow gate, not an OS security sandbox;
   do not mix old and new runtimes on the same registry.
   Spawn does not fetch or push; prepare the appropriate local base after checking credentials.
4. Reserve overlapping resources with `orchestrator_resource`:
   files, migration numbers, ports and Compose project names.
   Ports and Compose project names are host-wide:
   their optional `scope` is only a label, and a port reservation may be a range such as `23100-23115`.
   A migration's `scope` is its migrations directory, absolute or relative to the caller's worktree;
   it is keyed by repository and repository-relative path, so every worktree shares one sequence.
   Conflicts name the task that holds the resource.
   Reservations coordinate this registry only;
   inspect actual Git, listening ports and applied database migrations before use.
5. Send work through `orchestrator_message`.
   Messages go to a durable inbox bound to the target generation,
   not terminal keystrokes that could accidentally execute in a shell.
   By default a message to a worker steers:
   Pi delivers it after the worker's current tool batch, without aborting it,
   so a busy owner sees new information mid-task.
   Messages to the coordinator, explicit `followUp` and shutdown wait until the recipient is idle.
6. A worker publishes a result and report through `orchestrator_task`.
   `ready` is not `verified`.
   In strict or risky scope the coordinator reads actual evidence
   and records verification for the exact commit and plan hash.
   Light owners record verification of their own non-risky commit with their evidence files.
   A short commit SHA is resolved to the full SHA in the caller's worktree;
   starting a task that is already implementing is a no-op.
   Before correcting blocking review findings on a ready or verified task, call `start` again.
   It returns the task to `implementing`, retains the submitted result and history,
   and clears verification until the corrected result is resubmitted and freshly verified.
   Existing strict-release, local-install and merged-task freezes still apply.
   Busy workers, notes and review messages alone never change the task lifecycle.
7. Owners keep a one-line status with `orchestrator_task` `note`;
   `needsHuman: true` flags a decision for the human.
   A flag raised by a worker's `ask_user` clears when someone replies to that worker
   or the task becomes ready.
   This clears an attention flag, not an unanswered decision or an approval.
   Worker questions require stable unique IDs and self-contained `context` explaining facts,
   constraints and trade-offs, with the recommended option first and explained in its description.
   The nonblocking proxy sends the complete batch as JSON through the durable inbox;
   the coordinator relays it through its existing `ask_user` selector,
   preserving IDs, context, option order, recommendations and qualifications.
   Replies must retain each question ID and exact custom text/notes;
   clarification and cancellation remain unanswered, never consent.
   Historical requests without context are explicitly marked as missing context,
   not treated as an investigation that found no constraints.
   Incomplete batches and handoffs exceeding 12,000 UTF-8 bytes are rejected before notes or messages are written;
   reduce repeated prose without dropping constraints, or split independent questions into smaller batches.
   Only the one-line status note is abbreviated, never the question payload.
8. When only waiting, finish the model turn.
   The monitor wakes the appropriate parent on new results, lifecycle observations,
   idle owners and human questions.
   A worker message carrying `resultId` is still delivered, but skips its own wake
   only after the matching result's wake is durable on the current branch and generation and answered;
   otherwise, and for every other message, it wakes as usual.

Tasks may be added during a run, and workers may delegate child tasks.
Model independently usable foundations as separate tasks.
In strict or risky scope a dependency must be verified before consumers start;
in light scope consumers may stack on its ready commit.
Each orchestrator runs at most 10 live subagents, helpers and read-only agents included.
Light spawning stays flat: owners may spawn helpers, and helpers may not spawn or release.
More features of one workstream become more tasks under one coordinator,
never nested managers; the registry allows exactly one coordinator.
A separate workstream can be forked into an independent orchestrator (below).
Planner/reviewer workers get `bash` alongside read-only tools, but no `edit` or `write`.
They may use it for read-only Git inspection and task-relevant tests in their own worktree.
Tests may generate artifacts; workers disclose resulting tracked changes rather than resetting, cleaning or fixing them.
Source edits, destructive commands, dependency installation, credential changes
and release or other externally effective actions remain unauthorized.
`bash` is not a filesystem or process sandbox:
this boundary is an instruction and authorization rule, not enforcement.
On their own `ships: false` task they may start it, note progress and publish a result with `reportText`,
which the runtime stores as `<run>/reports/<task>/report.md`, outside any worktree;
the coordinator still verifies gated work.
Otherwise they send proposals and findings to the coordinator, who records artifacts and approvals.
Gated nested work still requires explicit task approval,
and all nested work needs non-overlapping resources;
parent approval does not silently approve unrelated scope.

## Forks

`orchestrator_fork` hands a separate workstream to a new, independent orchestrator.
It opens as a named tab in the human's own Zellij session, and focus moves to it.
The fork has its own registry, profile, coordinator, 10-subagent cap and detached worker session,
and attaches itself at startup through `--orchestrator-coordinate`.
It never reports back: the human talks to each orchestrator directly,
and the parent keeps only a pointer on its board.

Forks from one origin form a family of up to 3 orchestrators under `<origin registry>.family/`.
Members share one deploy lock and can read each other's boards
(`orchestrator_status` `view: "family"`), so they avoid overlapping work and concurrent deploys.

When an orchestrator's work is done and every agent is closed,
`orchestrator_agent` `close-session` kills and deletes its worker session.
It refuses while agents are open.
Worker sessions are disposable, so panes added later (Session Manager, a shell) go with it.

## Tools

| Tool | Purpose |
| --- | --- |
| `orchestrator_status` | Read task, agent, reservation and release metadata; `view: "board"` for one line per task. Ordinary unattached discovery (default/board/family, without task/agent filters) returns `attached: false` and an initialization next step, without creating a run. Managed/stale failures still block. |
| `orchestrator_preflight` | Recheck signing, remote access, GitHub authentication and Zellij; works before initialization. |
| `orchestrator_task` | Create/start/skip tasks; publish results; record verification; `note` owner status. |
| `orchestrator_agent` | Spawn, inspect and resume workers; `retire` finished ones in one step; close the worker session when done. |
| `orchestrator_fork` | Start an independent orchestrator tab for a separate workstream. |
| `orchestrator_message` | Send durable messages (steering to workers, follow-up to the coordinator by default); request orderly shutdown. A worker's optional `resultId` names its own current result, so a pure handoff of it wakes the coordinator at most once with the result notice. |
| `orchestrator_resource` | Reserve/release scoped resources. |
| `orchestrator_release` | Request scoped TUI authorization, check permission before external effects, claim/lock, and record evidence-backed checkpoints. |

Use the tools' schemas for exact arguments.
No arbitrary shell pipeline, Docker command, GitHub action or credential is stored in a tool configuration.

## Interactive board

`/orchestrator` with no arguments needs no command syntax.
In a session that is not attached, it first offers to start orchestration:
accept the suggested private run directory under `~/.local/share/pi-orchestrator/runs/`
or enter a run name (created there with a timestamp suffix, spaces become `-`), a `~/` path or an absolute directory,
then pick the light or strict profile.
It also offers the preflight checks.

In the coordinator, `/orchestrator` opens a full-screen board.
It lists tasks in the same order as the board widget, with details for the selected one,
and repaints as workers update the registry.
On wide terminals, task names and owner/activity columns expand to fit their content, and notes use the remaining width.
Narrow terminals and tool responses keep the compact layout.
When a replacement task supersedes a blocker, use `orchestrator_task` with `action: "skip"` on the old task and name the replacement in `reason`.
The board puts skipped tasks last and shows the skip reason as historical.
Task details retain the previous note and result. Neither requests human attention.
A note alone does not mark a task as skipped.
Use ↑/↓ to select a task. The footer lists only the keys that apply to it:

| Key | Action |
|---|---|
| Enter | Show task details: plan, approval, owner, branch, note, result and release. |
| `p` | Read the plan file. |
| `o` | Open the task's recorded HTTPS PR link in the default browser, even after its owner retires. Navigation only; no remote lookup or release change. |
| `a` / `A` | Approve this planned task, or every planned task (including light non-risky tasks), through the usual hash-bound confirmation. `a` also approves a light shipping task or verified task whose recorded approval does not match its plan hash, for example before bundled local delivery, unless a release record or bundle freezes it. Its confirmation says whether approval keeps a verified result bound to the exact plan bytes (retrospective approval, not a review or re-verification) or clears the result and verification, so the same candidate needs republishing and fresh verification; neither is permission to install. `A` adds only verified tasks whose result approval keeps, in their own section. |
| `i` | Inspect the owner's pane, as `orchestrator_agent inspect` does. |
| `g` / `G` | Go to the live owner's tab after re-verifying its pane: `g` opens its worker session in a new Ghostty window, `G` switches this window to it. The board stays open here. |
| `m` | Message the owner, labelled as coming from the human; a busy owner sees it after its current tool batch. |
| `r` | Resume the owner's original transcript after a confirmation; refused while it is live. If the new launch returns without verified readiness, the board warns instead of reporting success. Inspect the worker before retrying. |
| Esc | Close the current view. |

While reading a planned task's plan in the coordinator, use `a approve` for the displayed version's usual confirmation,
or `c critique in Crit` to review an exact snapshot in your browser.
Both actions require a readable, complete plan and enough terminal space for their controls.
Crit is optional (`crit` must be on PATH); ordinary approval works without it.
Scrolling and Esc back remain available.

Finish a Crit review with comments to automatically ask the coordinator to revise the plan,
clarify ambiguous requirements with you and present the revision for fresh review.
Opening Crit, draft comments, cancellation, comment-free completion and Crit's own approval indicator never approve implementation.
After revision, reopen the plan and explicitly approve the new version.
Tasks already underway and worker plan views stay read-only.

Crit runs locally with sharing disabled and its own data, configuration and process context,
without using existing Crit sessions or your Crit hooks and agent commands.
Duplicate keypresses do not open another active review for the same version and coordinator context.
If the plan, task or coordinator context changes during review, feedback is retained as stale rather than delivered as current.
Errors leave ordinary approval available;
the notification identifies recovery artifacts under the run's `crit-reviews` directory.
Enqueueing feedback is not delivery: an active transcript receipt must also be persisted on disk.
If Pi discards a queued request, the pending handoff retries automatically while the same task, plan and coordinator context remain current.
Deferred transcript persistence does not create duplicate revision requests.
Pending handoffs survive a reload on the same branch;
stale feedback stays available for recovery rather than being replayed into another context.

In a worker's tab, `/orchestrator` opens the same board read-only, on that worker's task:
Enter, `p`, `o` and `g`/`G` work as above,
and `c` switches this window back to the coordinator's tab.
Approvals, messages, inspections and resumes carry the coordinator's authority, so the worker board does not offer them.
The coordinator records its Zellij session and pane when it attaches;
a coordinator started outside Zellij records none, and `c` is not offered.

The board only picks a target.
The `/workers` panel from `pi-workflow` can open it on a task with `o`,
over the `orchestrator:open-board` event-bus channel;
only a Pi attached to that run accepts (a worker with its read-only board),
and `/workers` asks first so it offers `o` only where it works.
Each action revalidates the current registry and keeps its existing confirmations,
and agent-written text is shown with terminal controls replaced.

## Cheap monitoring and delivery

Attached sessions write heartbeats every five seconds.
Record routine progress with `orchestrator_task` `note`.
The board shows the note without a notification, sound or inbox wake.
Set `needsHuman: true` for a decision.
Result and inbox checks run every fifteen seconds without model calls when nothing is new.
Steering messages (the default to workers) are delivered after the recipient's current tool batch;
follow-up messages (the default to the coordinator) wait for idle.
A shutdown message waits for idle instead of terminating an in-flight deployment.

```text
/orchestrator watch
/orchestrator stop
```

`stop` pauses inbox/result delivery; heartbeats continue while the session is attached.
It does not pause a confirmed release command's continuation.

Stall handling is also event-driven.
An owner idle for 10 minutes on actionable work, with no blocker or human question noted,
wakes its parent once; at 20 minutes the human's UI is alerted directly.
A gated `ready` result left unverified for 10 minutes re-wakes the coordinator.
The coordinator's session shows a status-bar summary,
`/orchestrator board` shows a live one-line-per-task widget,
and human decisions, failures, merges and deployments raise deduplicated UI alerts.
The shipped count covers top-level tasks only:
child tasks ship inside their top-level task's release,
so once that task merges or deploys its children show as shipped (✓) too, except skipped ones.
None of these make model calls; existing history is not replayed on reload.

`/orchestrator status` adds a status card to the transcript without a model call:
what needs you (with the exact approve command), problems, work in flight with each owner's latest note,
ready work and, when expanded, shipped work.
The card is display-only and never enters the coordinator's context.
Once every task has ended and no worker PID is alive, the idle coordinator automatically cleans up this run's safe leftovers, once per run.
There is no routine checklist or confirmation.
It removes clean, integrated worktrees, takes down reserved Compose projects with their volumes kept,
closes stale worker records and closes the owned worker session.
Reservations of ended tasks are released automatically, even while other tasks are still open.
A transcript summary reports what was removed, kept or failed without starting a model turn.

Automatic worktree removal requires Git proof: the tip is an ancestor of the default branch, or its tracked tree is identical to that branch.
Task completion or a merge attestation alone is not enough.
Dirty, active and uncertain worktrees stay, and branches are kept.
Identical trees cover squash merges when main has not moved on;
otherwise an uncertain squash merge stays for manual review.
If the run has Docker volumes, one confirmation names the projects and warns that deletion permanently removes their data.
Declining keeps the volumes and still cleans up the other safe leftovers.
Every item is re-checked immediately before removal, and worktrees are never removed with `--force`.

Use `/orchestrator cleanup` for manual review of retained items and earlier runs.
It lists the worker session, worktrees, reserved Compose projects and volumes, ended reservations and stale agent records,
each marked removable or kept with a reason.
Earlier runs qualify after their coordinator has had no heartbeat for an hour;
they are never included in automatic cleanup.
The manual command works from any interactive session, attached or not.
Removable items start selected, including volumes.
Press Enter to review the selection.
Review all pages, then press Tab to select Remove and Enter to confirm.
Enter alone does not cancel or confirm removal. Press Esc to cancel.
Cleanup checks each confirmed item again before removal.
Manual confirmation can discard clean, unmerged worktrees of ended tasks, while keeping their branches.
Attaching a coordinator mentions earlier runs with leftovers;
when you ask the coordinator to clean up, it calls `orchestrator_cleanup` to open this manual review.
Unreserved Compose projects are not listed.
The coordinator can read this run's inventory with `orchestrator_status` `view: "cleanup"`.

For an audited list outside that inventory, call `orchestrator_cleanup` with `worktrees`:

```json
{"worktrees":[{"repoPath":"/absolute/primary-checkout","worktreePath":"/absolute/linked-worktree","retainedRef":"refs/heads/retained-integration"}]}
```

This reviews only the supplied list (1–200 entries), without changing task state or adding registry records.
Each entry needs canonical directory paths and an independently named local branch containing its current HEAD and ancestors.
Review open PRs and external installation dependencies before proposing the list; those are not inferred from Git ancestry.
The scrolling checklist shows the exact worktree commit and retained-branch commit.
The same paged confirmation applies to this list. Aborting the tool closes either dialog.
Dirty or ignored files, hidden-index flags (`assume-unchanged` or `skip-worktree`), interrupted Git operations and worktree-local refs block removal.
If the HEAD reflog contains commits outside the retained branch, every affected hash is listed in the paged confirmation.
Confirming Remove also authorizes discarding that worktree-local undo history, which may contain superseded commits or recoverable unfinished work.
A changed set of affected commits requires fresh confirmation.
Locked worktrees, primary checkouts, the current session, the loaded extension and live agents block removal.
Open files and process working directories are checked with `lsof`; an unavailable check or Git inspection warnings block removal.
Immediately before each non-force Git removal, paths, filesystem identities, commits, branch names and safety checks must still match the reviewed snapshot.
Branches are kept; Git and process checks are point-in-time protection, not a filesystem sandbox against concurrent writers.
The tool reports `no-eligible`, `no-ui`, `busy`, `cancelled`, `completed` or `failed` separately.
An empty run inventory means there are no eligible registered items, not that the TUI is unavailable or the human declined.

Typing just `status` in the coordinator shows the same card,
then asks the model only for what the registry lacks, such as progress seen by inspecting workers.

When a separately installed extension answers the `jev:classify` event-bus channel,
such as a personal Jev classifier extension,
each idle episode gets one diagnosis appended to the nudge and the stall alert:
waiting on human, done unreported, blocked unrecorded or paused midway.
The request carries only the task's title, state and latest note, its result and PR status,
the idle time and the owner's last assistant message (at most 1,500 characters).
The nudge waits up to 25 seconds for the answer;
without a listener, or on any failure, the texts are unchanged.
A diagnosis is advisory: it never changes task state, records a blocker or implies approval.

On macOS, fresh coordinator UI alerts also play system sounds through `/usr/bin/afplay`:
**Ping** for human decisions, blocked/failed results and escalated idle owners;
**Hero** for merges, deployments and the reminder to close the worker session after all tasks end.
Workers never play these sounds.
Sounds follow the same alert deduplication and silent history seeding as UI notifications.
Set `PI_ORCHESTRATOR_SOUNDS=0` in the environment when starting Pi to disable them.
Other platforms, missing system sounds/player and playback failures fall back silently.
Playback is best effort and does not delay monitoring or imply release verification.

You do not need to run preflight manually:
every worker spawn and resume (including from the board) runs it before launch.
It checks that commit signing works without a prompt (writing one unreferenced Git object),
that the origin remote and GitHub CLI are authenticated, and that Zellij is available.
Failed checks block that launch; fix the reported problem and retry.
Overlapping checks for the same canonical repository and current attachment/context share only the pending probe and its one UI notice.
Every caller retains its own launch and authority checks.
The pending entry is removed on success or failure;
a later attempt performs fresh checks, with no credential or permission cache.
Pi can also call `orchestrator_preflight` with an optional `repo` path
for a fresh check before leaving already-running agents unattended, without needing a registry.
`/orchestrator preflight [repo]` remains available for manual diagnosis.
Both interfaces show PASS/FAIL/SKIP lines and the first error line only;
neither unlocks credentials or grants release permission.
Checks are point-in-time observations, not a guarantee that credentials will stay available.
The pause survives reload/tree navigation for the same worker generation.
Directory binding is restored from the Pi transcript on reload/resume.
Message IDs and generation fencing prevent an old worker from acknowledging a replacement's messages.
Delivery acknowledgement requires the exact entry ID in the on-disk transcript and current branch,
not merely Pi's in-memory message queue.
It does not mean the requested work passed acceptance.
Shutdown uses a non-model control receipt and acknowledges only after the receipt is on disk
and the orderly shutdown request returns without throwing;
it does not prove process termination.
Before Pi's first assistant response, shutdown waits rather than acknowledging an unpersisted receipt.
A crash at a delivery/persistence boundary can require replay;
operations triggered by messages must remain idempotent and verify external state.

A stale heartbeat is an observation, not proof of failure.
The monitor never kills or restarts live workers, merges or deploys.
No monitor runs after the owning Pi process exits;
resume the saved coordinator transcript to restore it.
Tree navigation does not rewind the external registry, Git or deployments.

## Review loop

`/review-loop [PR | --base ref] [--threshold blocker|major|minor|nit] [--rounds N] [--reviewer model] [--fixer model]`
runs the [review-loop skill](../skills/review-loop/SKILL.md) on a GitHub PR,
or, without a PR, on the branch checked out in the session's working directory,
compared with `--base` (default: `origin`'s default branch).
Uncommitted changes are not reviewed; the skill asks before continuing without them.
A fresh reviewer (default `judgement` in `~/.pi/agent/model-roles.json`, an exact `provider/model`) reports findings as
*blocker*, *major*, *minor* or *nit*.
A fixer (default `defaultProvider` + `defaultModel` in `~/.pi/agent/settings.json`) commits fixes for open findings
at or above the threshold (default `major`) in its own worktree,
then a new reviewer checks the whole change again.
The loop ends when nothing at or above the threshold is open,
or asks the human after the round cap (default 3), a stalled round or a disputed finding.
Fixes reach a PR as one fast-forward push,
after the human approves the fix task's plan and grants its `pr` release action.
For a local branch, nothing leaves the machine:
the skill asks, then fast-forwards the branch to the final fix commit,
or leaves the fix branch if the branch moved or the checkout has conflicting changes.
The command only expands the skill when Pi is idle.

## Unverified draft WIP publication

`orchestrator_publication` is a separate, coordinator-only route for human-requested
**UNVERIFIED / WIP** draft PR create/update of an exact committed snapshot.
It requires current exact-plan human approval for an implementing, ready or blocked shipping task,
and genuine TUI confirmation of the full SHA, canonical checkout, GitHub repository,
head/base branches, exact update PR and explicit unresolved findings/limitations summary.
The dialog includes recorded task/blocker context; these summaries are attestations,
not automated discovery of every finding.

Use `request-authorization`, then a read-only exact-scope `check` immediately before effects,
then `record` with matching independently observed draft/head/base/repository/commit/PR and existing evidence files.
Independently reconcile actual remote truth before any effect or retry;
keep UNVERIFIED / WIP, the snapshot SHA and unresolved limitations visible in the remote PR.
Only non-force snapshot push and draft create/update are covered.
There is no executor or automatic replay.
Changed snapshots, destinations, findings or task context require fresh confirmation.
Recorded grants cannot execute again; conflicting observations reject.
Historical evidence recording and exact retries remain available under the original grant/destination
and same coordinator generation after local corrections, task drift or supersession,
without restoring execution authority.

Publication never changes task/result/verification/blockers, normal release records or locks,
never freezes corrections, and never counts as verified, merged, deployed or complete.
Normal verification and release gates remain intact in light, strict and risky cases.
Status/details expose WIP history separately from ordinary release advancement.
The first confirmed WIP grant promotes the snapshot to version 2;
legacy registries stay readable, but old runtimes reject publication-bearing registries,
including already-open readers/writers.
Use a separately approved fresh candidate session and new isolated registry for validation;
do not reload existing sessions or infer installation permission.
See [the complete synthetic flow and recovery contract](../skills/orchestrate-work/references/publication.md).

## Releases are explicit

Conversation proposes exact task/action pairs;
the current coordinator calls `orchestrator_release` with `action: "request-authorization"`:

```json
{
  "action": "request-authorization",
  "scope": [
    { "taskId": "search", "action": "pr" },
    { "taskId": "search", "action": "merge" },
    { "taskId": "inbox", "action": "deploy", "deploymentTarget": "staging cluster / demo namespace" }
  ]
}
```

One genuine TUI confirmation displays the registry, task titles, current plan paths/hashes,
and exact actions/targets in a viewport-sized paged overlay, not a clipped input-dock title.
Use the shown page keys (by default Up/Down or Page Up/Page Down) to inspect every page.
Cancel/navigation stay visible; the choice defaults to No.
After every page has been displayed, return to the final page,
select Yes with Tab and confirm with Enter.
Resizing reflows the scope and resets page review and the choice to No;
terminals smaller than 40 columns by 10 rows cannot approve.
Scope fields are JSON-quoted;
remaining raw terminal controls or bidi formatting are rejected before opening the dialog.
Only Yes records a grant; work then continues through the tool result without another nudge.
Clarify ambiguous references such as “these” before proposing scope.
The optional `source` is untrusted proposal metadata, not proof of approval.
RPC, non-TUI sessions, workers, changed plans and stale coordinator/session/tree contexts cannot grant authority.
No transcript role, startup prompt, input source, summary or marker is a substitute for this dialog.

The explicit slash alternative uses the same confirmation:

```text
/orchestrator authorize-releases [{"taskId":"search","action":"pr"},{"taskId":"search","action":"merge"}]
```

The old source-only syntax returns usage; it never guesses task scope.
`pr` includes the branch push required to open/update that PR,
but never implies `merge` or `deploy`.
Deploy permission requires an explicit, matching `deploymentTarget`.
Grants bind each pair to its current registered plan hash in this registry;
there is no task/action cross-product, descendant, future-task or sibling-fork expansion.
A changed plan requires explicit scoped re-confirmation.
Historical `releaseAuthorization` entries confer no authority in this runtime.
Do not mix old and new runtimes on a registry: old versions do not enforce these scoped grants.

After verification, `claim` takes ownership and returns a token;
it requires at least one permitted action, but authorizes no additional action.
Before **each external effect**, a `check` must pass for that `taskId`,
`operation: "pr" | "merge" | "deploy"` and, for deploy, `deploymentTarget`.
`claim`, `record` and `lock` return `next`: the next step with that check already run,
or what is missing (the deploy lock, a grant, the merge).
A check stays valid for every command of its operation until the release, its grant or the lock changes.
In light registries `taskIds` checks, claims or records several tasks sharing one PR or deploy, all or nothing.
The release's owner may omit `token` on `check`, `lock`, `record` and `unlock`:
every call is already fenced by agent generation and process.
Any other caller is told who owns the release.
The check is read-only and point-in-time, preserving role, verification, ownership and lock gates;
it does not intercept shell commands or execute releases.
Record `pr`, `merged` or `deployed` only after independently observing the corresponding effect.
Each record requires its respective `pr`, `merge` or `deploy` permission.

On the PR/merge/deploy route, light releases run concurrently per owner:
`claim`, check PR permission before pushing/opening the PR, record `pr`,
check merge permission before merging, and record `merged` (Git serializes merges).
Then `lock` with `deploymentTarget`, check deploy permission,
deploy merged main and run a short smoke check,
record `deployed` with the target and deployed main SHA, and `unlock`.
One deployment may carry several merges;
each recorded task needs its own deploy permission for that target and evidence,
while the deploy lock remains held.
Only the matching lock owner/task/token can pass the deployment execution check;
other owners may attest the observed batch, not launch a competing deployment.
Stages that did not happen may be skipped, for example `claimed → merged` or `merged → cleaned`.
An open light release follows the owner's latest verified commit until a merge is recorded.
Migration numbers are allocated after rebase, not queued by reservation order.

Strict releases retain the serial lock from claim through the release sequence.
Check each action before its external effect:
verify current main integration, push/create PR, respect checks, merge the exact head,
build merged main, back up and deploy deliberately, and verify live behavior.
`cleaned` is bookkeeping, not permission for destructive cleanup;
branch deletion requires separate explicit permission and safety checks.
`blocked` reporting and token-owned `unlock` remain available without a new grant.

### Local installation without a PR

For a local-only repository, use the separate `local-install` route.
It requires a shipping task with current human plan approval and an exact verified result,
even in a light registry.
Only the coordinator or release role may execute it.

Request a genuine release confirmation with this scope shape:
`{ taskId, action: "local-install", commit, installationTarget }`.
`commit` is the full verified Git SHA;
`installationTarget` is an absolute normalized local path, not a URL or deployment label.
The dialog displays both alongside the plan hash.
This permission grants no PR, merge, deployment or cleanup authority.
The same task/plan cannot mix local-install and PR/merge/deploy routes.

After confirmation:

1. `claim` with `taskId`, `operation: "local-install"`, `commit` and `installationTarget`.
   This explicitly selects the local route and takes the serial/family lock in either profile.
2. Use the returned `next` check, or `check` with the same operation, commit and target
   if state may have changed.
   Reconcile destination ownership, symlinks, live consumers, backups and current content
   before performing the separately specified installation commands.
3. Validate the actual installed revision and behavior,
   then `record` stage `installed` with `installedCommit`, `installationTarget` and evidence files.
   Both must match the authorized and claimed values.
   No PR, merged SHA or deployed SHA is fabricated.
4. Optionally record `cleaned` while still locked, then `unlock` with a reason.
   This is bookkeeping, not file removal.

Installed releases use `claimed → installed → cleaned`;
the task is marked `deployed`, with history explicitly identifying local installation.
Claimed candidates are frozen, including in light registries.
Changed candidates need new confirmation; subsequent installations need new tasks.
Local installation is single-task only: `taskIds` is rejected.
On uncertainty, record `blocked`, retain evidence and reconcile before continuing;
there is no automatic installer or retry.

Older runtimes cannot write registries containing this new route.
To validate a candidate before installing it, use a separately approved fresh Pi session
loading that exact candidate from its worktree with a new isolated registry.
Never reload existing sessions or run mixed runtimes against the same registry.
Loading a candidate does not authorize installation: its genuine confirmation is still required.

### Bundled local installation

When one integrated candidate also carries other verified tasks' results,
name each delivered result explicitly in the installing task's local-install pair:
`{ taskId, action: "local-install", commit, installationTarget, repoPath, includes: [{ taskId, resultId, commit }] }`.
`resultId` and `commit` are each included task's exact current ready result;
`repoPath` is the canonical checkout root.
Nothing is inferred from dependencies, parents or Git ancestry.

- Each included task must be an unskipped top-level shipping task in `verified` state,
  with current plan bytes, human approval and exact verification (independent when risky or strict),
  no release of its own and no other bundle.
- The dialog lists every included task, result, commit, title and plan hash.
  Before it opens, Git must show each included commit in the history of `commit` within `repoPath`;
  this is supporting evidence only, and the human attests actual inclusion.
- Claim with the same `includes`; check and record use the bundle frozen at claim.
  A singleton grant never satisfies a bundle claim and vice versa.
  Any included result, plan or verification drift makes the grant unusable.
- Included tasks freeze at claim and gain no release permission.
  After `installed`, the single receipt delivers each included result:
  the board counts it shipped once, shows it as `delivered`,
  and keeps its own state `verified` with no fabricated install, PR or merge.

### Historical bundle reconciliation

To record that an already installed receipt delivered other verified results,
confirm `{ taskId, action: "reconcile-install", commit, installationTarget, repoPath, includes }`
with the receipt's exact installed commit and destination,
then call `reconcile` with `taskId`, `grantId`, the same `includes` and evidence files.
It records history only: no installation, lock, stage change, replay or release authority.
An exact retry returns the existing record;
different evidence, widened or changed includes, a superseded grant, another coordinator generation
or task drift since confirmation are rejected.

Bundle grants and receipts raise the registry snapshot to version 3.
Older runtimes reject that version outright,
so they can neither install a bundle as a singleton nor drop its receipt.
Never introduce bundles into a registry an older runtime still uses.

### Release command continuation

The slash command commits its grant and pending continuation intent together.
It sends a grant-ID follow-up immediately when idle, or queues `followUp` when busy, never `steer`.
Cancellation, stale confirmation or a failed commit creates no intent or wake.
The tool path needs no additional wake.
A void `sendMessage` return is not acknowledgement:
delivery is acknowledged only when its entry is on disk and on the active branch.
Deferred first-assistant persistence remains unacknowledged without repeated enqueueing.
Discarded queues retry after settlement; undelivered intents reconcile on restart/timer ticks,
even with inbox/result watch paused.
Session, generation and branch-anchor mismatch leave the intent pending rather than misrouting it.

Ordinary delivery is deduplicated, not an exactly-once external-action guarantee.
A crash before transcript persistence can repeat a continuation notice.
Reconcile actual PR/Git/deployment state and check current authority before continuing;
never automatically replay release commands.
The durable registry, not a transcript marker, holds authority.

The durable lock has no automatic expiry or stealing.
On the ordinary PR route in light registries, a coordinator may adopt the release, and any deploy lock it holds,
of an owner proven exited, to reconcile and unlock deliberately.
An interrupted release requires inspection and explicit reconciliation/unlock,
not blindly replaying effects or destructive rollback.
Strict checkpoints require deployed SHA to equal the recorded merged SHA;
if newer main must deploy instead, reconcile the release record deliberately rather than asserting false equality.

Strict migration reservations are ordered within their scope.
A later migration-bearing task cannot release ahead of unfinished lower reservations.
External changes can invalidate reservations: recheck the live migration ledger and current main,
then reallocate only unapplied work through the owning agents.
Never edit an applied migration or remove a volume to make a ledger match.

## Recovery and cleanup

Use `orchestrator_agent` inspection before resume.
Resume requires proof that the previous worker process and its old pane are no longer live,
uses the exact saved transcript, and creates a new generation in a named tab of the owned shared session.
Live peers can remain in that session.
If the whole session is gone or listed as EXITED,
recovery requires every old worker PID to be dead and elects a fresh short session name.
It never resurrects the old Zellij session's commands.
A session-creation failure before any worker tab attempt can be retried with a new agent ID,
branch and worktree; retained failed artifacts are not reused.
An ambiguous launch after a tab attempt with no PID handshake requires operator investigation.
Old-generation messages are not silently retargeted.
No automatic adoption of arbitrary existing panes or existing worktrees is provided.

`retire` asks the worker to shut down, waits for the PID to exit,
collects its result report and closes its verified owned tab.
A worker still mid-turn is reported for a later retry, not killed.
`close` also finishes a worker that is provably gone:
dead PID with its session, tab or launch record already absent.
It closes the tab with whatever else it holds, except another agent's pane.
Closing one worker must not kill the shared session or its peers.
Transcripts, evidence and volumes are not deleted by lifecycle tools.
When a coordinator attaches, it deletes worktrees under `~/.local/share/pi-orchestrator/worktrees`
with no activity for 14 days, along with their local branches, merged or not.
It keeps worktrees of live agents in its registry and never touches worktrees elsewhere.
Merged branch cleanup is a separate verified release step.

## Trust and limitations

This is workflow enforcement, not an OS security sandbox.
Processes running as the same user can read or change local files outside these tools.
Role checks, explicit approval commands, generation fencing and private files primarily prevent accidents.

Reports and verification records are attestations, not independent proof.
The package cannot determine whether a test log is truthful,
whether a GitHub check passed, or whether a service is healthy without explicit external verification.
No credentials are required by the registry itself.
Do not put credentials in prompts, messages, resource values or evidence summaries.

The package targets local Git/Zellij/Pi workflows.
It does not provide distributed scheduling, hosted execution, automatic Crit scraping,
or unattended infrastructure rollbacks.

## Development and checks

Develop only in a dedicated Git worktree.

```sh
npm run check
```

Tests use temporary registries/repositories and injected process runners.
The skill checks validate scenario definitions, not behavioral model execution.
To also run the optional installed-Pi SessionManager compatibility tests:

```sh
PI_HOST_PACKAGE=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

Without that environment variable, the host compatibility tests are explicitly skipped.
Real interactive smoke testing must use its own detached Zellij session,
not existing user/production sessions.
See [verification](../VERIFICATION.md) for exercised checks and remaining limitations.
