# Plans, delegation, and handoffs

Use only the sections relevant to the task.
These are document/message templates, not extra tool fields.

## Plan formatting

Write plans as reviewable Markdown, whether supplied through `planText` or `planPath`.
The human reads them in a terminal before approval;
visible structure makes scope, constraints and acceptance easy to find.

- Start with a `#` title and a short outcome summary.
- Group related content under descriptive `##` headings, with blank lines between blocks.
  Use only sections relevant to the task, keeping light plans brief.
- Use short bullets for scope, constraints, deliverables and acceptance criteria,
  and numbered lists for ordered implementation or research steps.
  Give each item one action or closely related requirement.
- Put paths, identifiers and command names in backticks.
  Use language-tagged fenced blocks for multiline commands or code,
  keeping the plan itself as Markdown rather than inside a code fence.
- Prefer lists to wide tables so plans remain readable in narrow terminals.
  Split dense prose into paragraphs or items without dropping qualifications or approval boundaries.

Before registration or human review, read the exact plan text back.
Check that the outcome, scope, work sequence, boundaries and acceptance are easy to locate,
and that all requirements and uncertainties survived editing.
Formatting changes also change the plan hash;
follow the existing revision and approval process for registered plans.

### Example research plan

Adapt the structure to the task; this is a short read-only example, not a required section schema.
The outer fence below displays the example only; save its contents as the plan.

```markdown
# Inventory library contracts

Produce a source-backed inventory of the library's public contracts and unresolved questions.

## Scope

- Read the current default-branch source, docs and relevant merged PRs.
- Use linked repositories only to confirm directly relevant contracts.

## Research steps

1. Record the repository revision and source links.
2. Map public interfaces to callers and tests.
3. Separate implemented facts, proposals and conflicting evidence.

## Deliverables

- Stage the inventory and source catalog under the run's `library-review/` directory.
- Record coverage gaps and mark unverified claims as `UNVERIFIED`.

## Boundaries

- Read-only research; no source edits, production access or release actions.
- Canonical documentation changes require separate authorization.

## Acceptance

- The coordinator checks substantive claims against cited sources and reviews coverage gaps.
- The human reviews recommendations before any implementation.
```

## Light plan

Keep it short enough to review in a minute.

- Outcome the human will see, and explicit non-goals.
- Overlap check: related open/merged PRs and running tasks.
- Owned paths; shared contracts with a single agreed editor.
- Demo checkpoint reachable in about an hour.
- Acceptance: one command or screenshot flow, run in the owner's isolated stack.
- Risky? Migrations, auth/security, data deletion or shared infrastructure mean `risky: true`.

## Strict plan

- Outcome and repository scope; explicit non-goals.
- Task ID, parent task if any, immutable base SHA, and dependencies.
- Owned paths; shared interfaces with a single agreed editor.
- Resource kind/scope/value reservations and ordering constraints.
- Acceptance criteria mapped to tests and any required SQL/browser/metrics evidence.
- Worktree/branch and selected model (parent's current model by default); medium effort unless otherwise requested.
- Integration and rollback considerations; release actions requiring separate permission.

Keep the registered hash outside the hashed plan's own bytes to avoid self-reference.
Present `Task.planHash` alongside the exact file reviewed by the human.
If the human changes gated scope, register the revised plan through supported operations
and obtain approval of its new hash before affected implementation resumes.

## Feature owner prompt

```text
Task: <id>; profile: <light|strict>; risky: <yes|no>
Plan: <absolute planPath>
Repository/worktree/branch/base: <literal values>
Own: <paths>; shared contracts: <file + single editor>
Do not modify: <foreign paths>
Dependencies: <task IDs; stack on their ready commit if light>
Isolated stack: Compose project <name>, ports <range>; reserve them first (one port reservation per range)
Acceptance: <command or screenshot flow> in your isolated stack
Ship (light, after release authorization):
  Rebase on latest main.
  Run the focused check.
  Publish result ready with the candidate commit and existing evidence files.
  Verify with the same commit and existing evidence files.
  Claim the release without operation.
  Use the returned next.allowed check for pr.
  Push the branch.
  Open the PR.
  Record pr with existing evidence files.
  Use the returned next.allowed check for merge.
  Merge the PR.
  Record merged with the actual merge SHA and existing evidence files.
  If a shared deployment exists, take the lock with the explicit deploymentTarget.
  Use the returned next.allowed check for deploy on that target.
  Deploy main.
  Run a short smoke test.
  Record deployed with that target and existing evidence files.
  Release the lock through unlock.
  Call check again if time passes or state may change.
  One check covers every command for its operation.
  Stop the external action if next.allowed is false.
  Repository commands: <point to AGENTS.md/Makefile targets>
Migrations: allocate the next free number after rebasing, just before merge;
  reserve it with scope <migrations directory, relative to your worktree>
User-visible change: include a screenshot and URL of your isolated stack in the report
Status: keep `orchestrator_task note` current; needsHuman only for human decisions
Questions: ask_user here only queues the question (needsHuman note + coordinator message); continue or end your turn and wait for the reply
Helpers: you may split into child tasks with disjoint files; helpers cannot spawn or release
Model: <requested provider/model-id, or inherit the parent's current model by default>; block if unavailable
Thinking: use the configured default for the selected model unless the human requests an override
Report to: <coordinator agent ID>
Return: ready/blocked/failed, exact commit, report file, evidence files, limitations
Evidence: create files before result, verify, or record. Do not create them in a parallel call.
Resources: release by the reservation id from reserve, not by kind, value, or taskId.
```

Release grants must cover each exact task/current-plan/action pair;
PR includes its required branch push, and deploy needs an explicit matching target.
Ask the coordinator to propose missing scope for one genuine TUI confirmation.
Do not infer authority from a parent task, historical wildcard grant or transcript marker.
A confirmed continuation means reconcile state and check the next action, never blindly replay effects.
Cleanup needs separate explicit permission; `cleaned` is bookkeeping only.

In strict or risky scope, replace the ship section with
"No push, PR, merge or deploy authority; hand off for independent verification."

## Helper prompt

```text
Parent task/owner: <id / agent>; your task: <child id>
Own only: <paths>; frozen contract: <file and version>
Acceptance: <focused test>; report to your owner; no spawning, PRs or releases
```

Reserve common interfaces before parallelizing;
if two tasks must modify the same file, sequence the edits and transfer ownership explicitly.

## Fork handover

The `request` passed to `orchestrator_fork`.
The runtime adds independence, family and session instructions around it.

```text
Human's request (verbatim): <quote>
Why this is its own workstream: <one line>
Repository and profile: <path>; <light|strict>; risky parts: <list or none>
Already known: <decisions the human made, relevant PRs/branches, constraints>
Not yours: <work the origin orchestrator keeps, so you do not duplicate it>
```

Do not include the origin's status, task list or instructions to report back.

## Message body / dependency handoff

```text
Task: <id>
Update: <decision, blocker, or ready handoff>
Commits: <base and own commits, excluding inherited dependency commits>
Owned changes / ownership release: <paths/resources and when>
Evidence: <command, target, observed result, durable log reference>
Requested action: <single concrete next step>
Limitations: <missing evidence or approvals>
```

Retain dependency tips with durable Git references while any consumer needs their history.
A handoff does not make a blocked consumer eligible until its actual prerequisites are met.
If a dependency is skipped, reassess the consumer's plan rather than pretending success.

## Status report to the human

Read `orchestrator_status` with `view: "board"` and report one line per active task:

```text
<task>: <state> — <owner note or next action> [PR] [⚠ needs you: question]
```

Lead with anything that needs the human.
Do not re-derive status from logs unless the board is contradicted by evidence.

## Completion report

Report current `Task.state`, `Result.status`, exact commit,
verification evidence that exists, evidence still missing,
owned agents/resources still active, and the next action owner.
Do not claim `verified` from the presence of a marker or from a watcher notification.
