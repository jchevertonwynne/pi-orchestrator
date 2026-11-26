---
name: orchestrate-work
description: Coordinate Pi subagents with /orchestrator. Use when the human requests workers or asks to spawn subagents. Also use for delegated research, delegated reviews, parallel tasks, or an existing orchestrated run. This includes one worker and read-only work. Covers initialization, task ownership, worktrees, messages, status, retirement, and independent forks. Use release-work for releases and local installation. Use recover-work for interrupted or invisible workers. Do not introduce orchestration for simple solo work unless the human requests it or delegation provides a clear benefit.
compatibility: Pi 0.87.1, Node 24+, Git, Zellij, and the standalone orchestrator extension.
---

# Orchestrate work

**Spawned worker:** read [the worker guide](references/worker.md) instead of this coordinator guide,
`quickstart.md` and `interface.md`; follow only its conditional release/recovery links as needed.
The remaining sections are for coordinators.

Read [the quickstart](references/quickstart.md) first.
It gives complete calls and defines each ID.
Read [the interface and trust contract](references/interface.md) before you use the extension.
Read [plan formatting and templates](references/planning.md) before writing or revising any plan,
including single-worker research and review tasks.
Resolve reference paths relative to this skill directory.

## Select the next action

- For one worker or read-only research, create one task with a named owner.
  Set `ships: false` for work that needs no release.
- For parallel features, create one task and owner per independent feature.
  Keep these tasks under the same coordinator.
- For a separate conversation with the human, use an independent fork.
- For an interrupted or invisible worker, use the recovery skill.
  Do not create a second writer.
- For a PR, merge, deployment, local installation, or explicitly unverified draft WIP publication, use the release skill.
  WIP publication follows [its separate exact-snapshot flow](references/publication.md),
  preserving ordinary verification and release gates.
  Implementation permission does not grant release permission.

## Choose the process weight first

Read repository instructions for a stated rigour level before anything else.
Pick the registry profile at init;
it is fixed once work exists.
Pass a run name,
for example `/orchestrator init sample-project --light`;
it becomes a fresh `~/.local/share/pi-orchestrator/runs/sample-project-<timestamp>`.
A `~/` path or an absolute directory outside any repository also works;
init rejects relative paths such as `./run` and placeholders such as `<private dir>`.
When unsure, run bare `/orchestrator` and accept its suggested run directory.
For explicit work needing subagents or tasks in an ordinary unattached session,
call `orchestrator_init` yourself instead of asking the human to run init.
`orchestrator_status` default/board/family discovery returns `attached: false` without creating a run;
no prerequisite failed tool call is needed.
Managed, stale or failed attachments require explicit recovery rather than initialization;
when initializing,
omit `name` for a run named after the working directory,
and pass `profile: strict` when the rules below call for it.

- **light** (default): prototypes, hackathons, demos, personal tooling.
  Feature owners verify and merge their own non-risky tasks;
  consumers may stack on a dependency's ready commit;
  a deploy lock covers only deploying merged main plus a short smoke check.
- **strict**: production, customer-facing, cloud or shared infrastructure,
  or whenever the repository or human asks for it.
  Per-task human plan approval, coordinator verification and one serial release lock.

In either profile, create a task with `risky: true` for migrations, auth/security,
data deletion or shared infrastructure.
Risky tasks and their subtasks keep per-task human approval and independent verification.
Create design, research, review or investigation tasks with `ships: false`:
they are done once ready (light) or verified (gated), count as done rather than ready,
and never take a release. Do not skip finished work just to clear it from the board.
State the chosen profile and risky tasks to the human in one line;
ask only if the repository's intent is unclear.

## Keep the team flat

At most 10 subagents run at once per orchestrator, helpers and read-only agents included.

- **Coordinator (you): a dispatcher.**
  Track owner, next action, blocker and shipped status.
  Do not re-read every log, re-run owners' tests, write tickets for routine steps,
  or integrate other owners' branches.
  Answer status questions from `orchestrator_status` with `view: "board"`.
- **Feature owners:** one `implementer` per feature,
  owning implementation, tests, rebase, PR, merge and the feature's smoke check.
- **Helpers:** an owner may split its feature into child tasks with disjoint files
  and a frozen shared contract.
  Helpers finish their slice and report to the owner; they cannot spawn or release.
- **Read-only fan-out:** planners, researchers, persona reviewers
  and targeted reviewers for risky tasks.
  Each one rereads the code and its context, so give each a distinct question or area.
  Give each its own `ships: false` task: it starts it, keeps a note and publishes its result
  with `reportText` (stored under the run), so you read the report instead of relaying or rewriting it.
  A reviewer attached to a shipping task can only message its parent.
  They get bash for read-only Git inspection and task tests, but no edit/write tools;
  bash is not a sandbox, so the role, not the shell, bounds them.

Do not add integrator, verifier or executor layers to speed things up.
If throughput is poor, remove a handoff instead of adding an agent.
At the cap, queue new tasks as planned and start them when an agent is closed.

### Several requests arrive: add tasks or fork

- **More features of the same workstream: add tasks** under this coordinator, one owner each.
- **A separate workstream that deserves its own conversation with the human: fork it.**
  For example a different product area, a different set of decisions,
  or work that would push you past the subagent cap.

Never nest a manager or orchestrator beneath yourself:
a child that reports back re-plans, re-verifies and relays, adding latency at every level.
A fork is different because it never reports back.
`orchestrator_fork` opens an independent orchestrator as a named tab in the human's Zellij session;
focus moves to it by design, so do not switch back.
It gets its own registry, profile, coordinator, 10-subagent cap and detached worker session.
The human talks to it directly; you keep only a pointer on your board.

To fork well:

1. Tell the human in one line what you are forking and why.
2. Pass their request verbatim plus only the notes the fork needs
   (use [the fork handover template](references/planning.md#fork-handover)).
   Do not keep a copy of that work in your own plan.
3. Do not message the fork, poll it or relay for it afterwards.
   If the human asks you about forked work, point them at its tab.

Forks from one origin form a family of at most 3 orchestrators.
Family members share one deploy lock, because they usually deploy the same target,
and can read each other's boards with `orchestrator_status` `view: "family"`.
Read it before planning to avoid overlapping a sibling's tasks,
and message the human rather than the sibling about a conflict.
A fork confirms its scope with the human before spawning anyone.

## Plan in proportion

1. Inspect current Git/worktree state and preserve unrelated work.
   Resolve [push intent and target](#push-intent-for-a-new-request) before planning a new request-scoped root.
2. Check for overlap before planning:
   open and recently merged PRs (`gh pr list`, `gh pr list --state merged --limit 30`),
   teammates' branches, and tasks already in the registry.
   Fold or drop duplicated work, and tell the human which PR already covers it.
3. Prefer visible, demoable slices over depth.
   Give each owner a checkpoint the human can see in about an hour.
   Name explicit non-goals, especially production hardening the human did not ask for.
4. Finish the plan's readability check before registering it with `orchestrator_task`,
   passing its Markdown as `planText` (stored as `<run>/plans/<task>.md`) or `planPath` for an existing file.
   Tool calls in one batch can run in parallel,
   so never write a plan file and create its task in the same batch.
   Keep light plans short: outcome, non-goals, owned paths, shared contracts,
   demo checkpoint and one acceptance command or screenshot.
   When the human adds scope to a task already in flight,
   create it as a separate shipping task with its own PR, depending on the original,
   unless it cannot land separately.
   Growing an in-flight branch kept one owner busy for 7.5 hours and put three features in one PR.
5. Check `approvalPolicy` in `orchestrator_status` before starting.
   For a new eligible planned root in `request-scoped` mode, call `orchestrator_request` with the task ID and canonical repository path.
   If the rule calls for a push, also supply the named remote and full `refs/heads/...` destination.
   One genuine TUI dialog binds the exact plan, repository and, if present, the resolved push URL and ref.
   On Yes, start the confirmed plan; on cancellation, stop. The grant does not cover other tasks or children.
   For staged or legacy runs, older work and children, use the existing profile rules:
   - Light: the human agrees the roadmap in conversation or Crit.
     Only risky tasks need `/orchestrator approve <task> [reference]` before start.
     A risky task's helper tasks need approval too,
     so ask its owner to create them all up front for one `/orchestrator approve-all`.
     Local installation, bundling into an installation and draft WIP publication
     also need current plan approval in light mode;
     ask for it before start, ideally with one `/orchestrator approve-all`.
     Late approval keeps only a verified result bound to the exact approved plan bytes,
     as retrospective approval that is not a review or re-verification;
     it clears any other result or verification, so the owner republishes and re-verifies.
   - Strict: every task needs approval of its exact `planHash`.
     After the human reviews a batch, `/orchestrator approve-all <source>` confirms them in one dialog.
   A review comment, agent sentence or done marker is never approval.

### Push intent for a new request

Use the push intent rule in the human's `AGENTS.md`, subject to stricter repository rules.
Propose one non-force push to the human's clearly identified eligible feature branch for an explicit push request.
If the human's policy treats a request to change an identified existing PR on that branch as a push request,
count it as an explicit push for this proposal. Otherwise require an explicit push request.
Confirm the head repository and ref, actual push URL, branch ownership and eligibility before work.
Observe the starting remote head. State the exact target in the first progress update.
Ask once upfront if intent, ownership or target is unclear.
Default or protected branches, other people's branches, unowned forks and unknown eligibility are outside this route.
A no-push instruction takes precedence. A local-only change gets an implementation-only request and no push offer.
Review-only work stays read-only. Neither a bare PR reference nor a bare `/review-loop` requests a push.
This rule selects the destination to propose. Chat is not authorization, and staged and legacy gates do not change.

Implementation permission alone does not authorize push, PR, merge or deployment.
For a confirmed push-only request, follow [release-work](../release-work/SKILL.md) for `orchestrator_scoped_push`, not a PR grant.
Clarify ambiguous conversational references such as “these” before proposing any ordinary release.
For an explicitly requested ordinary release propose exact task/action pairs with `orchestrator_release` `request-authorization`.
One genuine TUI confirmation grants only those current-plan pairs and explicit deploy targets.
`pr` includes its required branch push, not merge or deployment.
Alternatively use `/orchestrator authorize-releases <JSON exact pairs>`.
Legacy source-only syntax and historical wildcard grants confer no scope.
RPC, input-source guesses, transcript roles and marker contents cannot replace confirmation.
After Yes, continue through the tool result or the slash command's durable follow-up;
do not wait for another human nudge.
Owners claim a release to obtain its token.
Each external action requires a read-only check.
`claim`, `record`, and `lock` return `next` with that check complete.
If `next.allowed` is true, use that check immediately.
If `next.allowed` is false, stop the external action.
Call `check` again if time passes or state may change.
One check covers every command for its operation.
Permission never expands to future tasks, descendants or sibling forks.

## Delegate with ownership

Spawn each owner through `orchestrator_agent` with a dedicated branch/worktree from current main.
Omit `worktree` so it lands in a fresh directory under `~/.local/share/pi-orchestrator/worktrees`;
never place worktrees beside the repository.
Give it the plan, owned paths, acceptance, the repository's exact
"worktree → isolated stack → rebase → PR → merge → deploy" commands
(point at the repository's instructions rather than restating them),
and your agent ID for reports.
Use [the owner prompt template](references/planning.md#feature-owner-prompt).

Runtime checks belong in the owner's own Compose project with unique ports and volumes,
not the shared demo; reserve `compose` and `port` resources for them
(one port reservation may cover a range such as `23100-23115`).
Full stacks are heavy: agree with the human how many may run at once
(two is a sensible start on a laptop),
and tell owners to stop theirs, keeping volumes, as soon as its evidence is saved.
The shared deployment is a final short confirmation, not where a feature is first tested.
Allocate migration numbers after rebasing, immediately before merge, and reserve them then,
with the migrations directory as `scope` so every worktree shares one sequence;
reserving at planning time serializes unrelated work.

New workers and forks default to their parent's current model, including helpers.
When another model is requested, pass its exact `provider/model-id` as `model` on spawn or fork.
When the human's instructions map kinds of work to models,
pass the mapped model explicitly on every spawn and fork,
so routine workers do not inherit a premium coordinator model.
Omit `thinking` to use the selected model's default from `model-roles.json` (`high` if unset).
Pass `thinking` on spawn or fork only when the human requests an override.
Resume preserves the worker's recorded model and effort.
If the required model is unavailable, report a blocker rather than substituting another model.
Workers run as named interactive Pi tabs in one task-specific detached Zellij session,
separate from the human's session.
No `--print`, pipes, redirection or detached Pi processes outside Zellij.
Inspect each new agent once through its registered session/tab/pane;
names alone are not identity.
Do not move or restart already-running agents to tidy sessions.

## Coordinate without polling

- Send handoffs through `orchestrator_message`.
  Messages to workers steer by default, arriving after the worker's current tool batch;
  pass `followUp` only when the update can wait until the worker finishes.
  A busy owner may not finish for hours:
  confirmations and FYIs sent as follow-ups have arrived up to ten hours late and already obsolete,
  so steer anything about the worker's current task.
  Light sibling owners may message each other directly about overlaps and rebases.
- Owners keep a one-line status current with `orchestrator_task` `note`.
  `needsHuman: true` is only for decisions the human must make.
  Workers never block on the human: their `ask_user` is a stand-in that records a `needsHuman` note,
  messages the parent and coordinator with the full question, and returns at once.
  Replying to that worker, or its ready result, clears the flag;
  a blocked or failed result keeps it.
- When notified that a task needs the human, relay the question to the human immediately,
  with options and a recommendation; do not decide for them.
- When notified that an owner is idle with actionable work, send its concrete next step
  or ask it to record a blocker.
  After a second threshold the human is alerted directly, so do not wait on stalls.
- When all useful work is waiting, say what it waits on and end the turn.
  The watcher wakes you on results, messages and stalls; never run sleep or status loops.
- The human sees a status-bar summary, `/orchestrator board`, and alerts for decisions,
  failures, merges and stalls, without model calls.
  Keep your own status reports short: one line per active task.

Spawn and resume automatically check commit signing, remote and GitHub credentials, and Zellij,
and stop before launching a worker if a check fails.
Do not ask the human to run preflight themselves.
Before the human leaves agents unattended, call `orchestrator_preflight` with the repository path
for a fresh check, even if workers are already running.
Report failed checks and ask the human only for credential unlocking or other intervention Pi cannot perform;
then retry the check or launch.
Credential prompts previously stalled whole runs overnight.
A passing preflight is a point-in-time check, not a guarantee that credentials will stay unlocked.

## Keep the human in the UX loop

For user-visible changes, owners report a screenshot and URL from their isolated stack.
Surface those to the human for sign-off; route feedback straight to the owner,
who iterates and ships without re-planning.
Human feedback on what they see beats any verifier's reading of a plan.

## Run review rounds

Reviews cost a full reread each time, so each round earns its scope:

1. Before building a multi-PR stack, settle cross-cutting decisions
   (schemas, identities, dependency direction, naming) on one small slice.
2. Run one full independent review on a stable commit,
   with reviewers split by concern rather than repeating each other.
3. Keep a findings ledger in the run:
   each finding with its fixing commit, its test,
   and whether it needs wider re-review.
4. Later rounds review the delta since the last reviewed commit,
   plus the areas the ledger marks for wider re-review.
5. Start another full review only for a stated reason:
   an architectural change, an unresolved correctness concern or invalidated evidence.
   Record the reason in the review task's plan.

For stacked PRs, batch accepted fixes and rebuild the stack once per batch.
Run the per-layer build, test and signature checks from one script
that reports failures, and investigate only those.

## Correct review findings

Before correcting a `ready` or `verified` task, call `orchestrator_task` with `action: "start"` and its task ID.
This explicitly returns the task to `implementing`, retains the submitted result and history,
and clears its verification.
Keep prior report/evidence files unchanged; submit corrected artifacts through a new `result` when corrections are complete,
then examine the evidence and record fresh verification using the profile's existing verifier role.
Existing release freezes still apply; a frozen candidate needs a new task or explicit recovery, not a bypass.
Worker activity, status notes and reviewer messages alone do not record rework.

## Collect and close

Read [evidence storage rules](references/evidence.md) before collecting or retaining evidence.
Use `orchestrator_agent` collection to retain reports and transcript references.
Results use `ready`, `blocked` or `failed` with a report file, exact commit and evidence files.
`ready` is a handoff; `verified` is recorded by the owner (light, non-risky)
or independently by you (strict or risky) against that exact commit.
End a finished worker with one `orchestrator_agent` `retire` call.
It requests shutdown, waits up to a minute for exit,
collects `report` (default: the task's recorded result report) and closes its tab.
If the worker is still mid-turn it says so; end your turn and call `retire` again later.
Pass `closeSession: true` on the last one to close your detached worker session too,
or call `close-session` (its `id` is the session name on your board or in `orchestrator_status`).
Worker sessions are disposable; never kill them with `zellij` directly.
Reservations of ended tasks are released automatically.
Once every task has ended and no worker PID is alive, the idle coordinator automatically cleans up this run's safe leftovers and shows a summary.
It removes only clean worktrees with Git integration proof (ancestry or identical tracked trees),
reserved Compose projects with volumes kept, stale worker records and the owned worker session.
Dirty, active or uncertain worktrees stay; branches are kept.
Volume deletion still asks the human for explicit confirmation;
declining keeps the volumes and allows the other safe cleanup to continue.
Earlier runs stay on the manual path.
Whenever the human asks you to tear down or clean up, call `orchestrator_cleanup`:
it opens selection and confirmation for eligible retained items and abandoned earlier runs.
For audited worktrees outside that inventory, use its explicit-list mode in the [interface contract](references/interface.md#commands-and-tools).
Inspect the returned status and reasons when no prompt appears, rather than retrying blindly.
Use that tool rather than `git`, `docker` or `zellij` so live safety checks and registry bookkeeping stay aligned.
Report retained resources from the summary; branch deletion remains separately authorized.
Use the companion recovery skill for lost sessions or ambiguous process state,
and the release skill for shipping.
