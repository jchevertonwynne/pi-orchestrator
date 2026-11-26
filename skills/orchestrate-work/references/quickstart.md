# Quickstart

These examples describe tool calls.
They do not grant permission or execute a release.
Replace example IDs, paths, commits, and URLs with actual values.
Do not execute independent examples as one sequence.

## Identify each value

| Value | Meaning | Use |
| --- | --- | --- |
| Task ID | The `id` from task creation | Task calls and release `taskId` |
| Agent ID | The `id` from worker creation | Messages, inspection, and retirement |
| Reservation ID | The `id` from resource reservation | Resource release |
| Session name | The worker's `zellijSession` | Agent `close-session` |
| Commit | A Git commit SHA | Results, verification, and release evidence |

A task ID is not an agent ID or reservation ID.
A session name is not an agent ID.

These terms describe different actions:

- **Start** changes a task to `implementing`.
- **Launch** creates a worker process.
- **Check** reads current permission or actual state.
- **Verify** records an attestation after examination of actual evidence.
- **Confirm** describes the human's approval in the TUI.

## Start a run

1. Inspect repository instructions and existing work.
2. Call `orchestrator_status` with `view: "family"` to check existing tasks.
3. If ordinary discovery returns `attached: false` and the request needs tasks or workers,
   call `orchestrator_init`; no failed call is required.
   Recover managed/stale attachment failures explicitly instead of initializing.
4. Check the family board after initialization if this run belongs to a family.

Example initialization:

```json
{"name":"storage-research","profile":"light"}
```

Use strict mode for production, cloud, or shared infrastructure.
Use strict mode when repository instructions or the human require it.
Worker spawn and resume run preflight automatically and stop on failed checks.
Do not ask the human to run the command.
For a fresh check before unattended work, call `orchestrator_preflight` with `repo` set to the checkout path;
it also works before initialization.

## Create one research task

Call `orchestrator_task`:

```json
{
  "action":"create",
  "id":"storage-research",
  "title":"Investigate storage options",
  "ships":false,
  "planText":"Read existing storage code. Do not change source files or external systems. Produce a report with source references and limitations."
}
```

Use `planText` to create the plan within this call.
Alternatively, supply an existing file through `planPath`.
Do not create that file in a parallel call.

Strict and risky tasks require human approval of the exact plan hash.
For a new eligible root in request-scoped mode, call `orchestrator_request` before start for one exact-plan TUI confirmation.
In staged mode or for an ineligible task, the human uses `/orchestrator approve <task-id>` or `/orchestrator approve-all`.
A conversational statement does not replace that approval.

## Create the worker

Call `orchestrator_agent`:

```json
{
  "action":"spawn",
  "id":"storage-researcher",
  "taskId":"storage-research",
  "role":"planner",
  "repo":"/home/user/project",
  "base":"HEAD",
  "branch":"research/storage-options",
  "prompt":"Read the registered storage-research plan. Start your task through orchestrator_task after any required human approval. Do not change source files or external systems. Publish your report through reportText."
}
```

For `spawn`, supply all seven fields after `action` in this example.
Use the absolute path to the primary checkout for `repo`.
Resolve aliases and symlinks first.
Do not supply a linked worktree as `repo`.

Use a base revision that resolves to a commit.
Choose a branch that does not exist.
Omit `worktree` to use the managed worktree directory.
Omit `thinking` to use the selected model's default from `model-roles.json` (`high` if unset).
Omit `model` to inherit the parent's current model.
To select another model, pass `model: "provider/model-id"` on spawn or fork;
this does not change the parent's model.
The selected model must be available; launch never substitutes another model.

Inspect the new agent once through `orchestrator_agent`:

```json
{"action":"inspect","id":"storage-researcher"}
```

An incomplete launch does not prove the process stopped.
Use the recovery skill before you retry an uncertain launch.

## Start and report

Spawned workers use [the worker guide](worker.md) instead of this coordinator quickstart.
Follow [evidence storage rules](evidence.md) before producing or retaining evidence.

The worker starts its task through `orchestrator_task`:

```json
{"action":"start","id":"storage-research"}
```

The worker publishes its report through the same tool:

```json
{
  "action":"result",
  "id":"storage-research",
  "status":"ready",
  "reportText":"Findings with source references. State any unverified claims and remaining decisions."
}
```

A light, non-risky research task ends at `ready`.
A gated research task requires independent verification by the coordinator.
For this commitless result, the coordinator omits `commit`:

```json
{
  "action":"verify",
  "id":"storage-research",
  "evidence":["/home/user/run/reports/storage-research/report.md"]
}
```

If a non-shipping result includes a commit, repeat that commit during verification.
Do not add a repository commit to a commitless result during verification.

## Report and verify source changes

Use a shipping task for source changes that require a release.
Publish the ready result with its exact candidate commit:

```json
{
  "action":"result",
  "id":"storage-fix",
  "status":"ready",
  "commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "report":"/home/user/run/reports/storage-fix/report.md",
  "evidence":["/home/user/run/evidence/storage-fix/tests.log"]
}
```

Then call `verify` with the same commit and existing evidence:

```json
{
  "action":"verify",
  "id":"storage-fix",
  "commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "evidence":["/home/user/run/evidence/storage-fix/tests.log"]
}
```

`verify` requires the repeated commit.
The tool does not infer it from the ready result.

Only a light, non-risky owner can verify its own task.
Gated work requires the coordinator's independent verification.
Do not treat either example as automatic verification.
Examine actual evidence before you attest verification.

## Reserve and release a resource

Call `orchestrator_resource`:

```json
{"action":"reserve","kind":"port","value":"23100-23115","taskId":"storage-fix"}
```

Retain the `id` from its result.
For release, supply that reservation ID:

```json
{"action":"release","id":"00000000-0000-4000-8000-000000000001"}
```

Do not substitute the task ID, port range, or Compose name for `id`.
Check actual resource use before you reserve or release it.
A reservation does not stop external processes from using the resource.

## Request and record a PR

Read [the release skill](../../release-work/SKILL.md) before any release action.
The coordinator requests exact permission through `orchestrator_release`:

```json
{
  "action":"request-authorization",
  "scope":[{"taskId":"storage-fix","action":"pr"}]
}
```

The human must confirm this scope in the TUI.
The task must also pass its separate plan and verification requirements.
PR permission permits the required branch push.
It does not permit merge, deployment, or local installation.

For an ordinary release claim, omit `operation`:

```json
{"action":"claim","taskId":"storage-fix"}
```

If `next.allowed` is true, use that check immediately.
If `next.allowed` is false, stop the external action.
Resolve the reason before you continue.
Call `check` with `operation: "pr"` if time passes or state may change.
The local-install route instead requires `operation: "local-install"` on claim.
It also requires separate permission for the exact commit and installation target.

After the authorized PR action succeeds, create evidence from the actual remote state.
Then record the PR:

```json
{
  "action":"record",
  "taskId":"storage-fix",
  "stage":"pr",
  "pr":"https://example.test/project/pull/1",
  "evidence":["/home/user/run/evidence/storage-fix/pr.json"]
}
```

Every release record requires 1 to 256 existing evidence files.
A PR URL does not replace an evidence file.
Create evidence files before the record call, not in a parallel call.
If recording fails, inspect remote state before you retry any external action.

## Retire the worker

After the worker finishes, call `orchestrator_agent`:

```json
{"action":"retire","id":"storage-researcher","closeSession":true}
```

The tool requests shutdown and waits at most one minute.
It collects the task result report and closes the worker tab.
If the worker remains busy, end your turn.
Call `retire` again later.

If no task report exists, supply an existing diagnostic report through `report`.
Use an absolute path without symlinks or aliases.
`collect` always requires an explicit `report` path.
`closeSession` closes the session only after its last agent closes.

Never kill worker sessions directly with `zellij`.
Finished current runs clean up safe leftovers automatically and report the outcome; Docker volume deletion still asks for confirmation.
Use `orchestrator_cleanup` when the human requests manual review of retained worktrees, stacks, volumes or earlier runs.
