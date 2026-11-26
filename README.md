# Pi Orchestrator

Delegate work to [Pi](https://pi.dev) agents you can inspect, steer, and resume.
Each worker runs as an interactive Pi session in a named Zellij tab,
with its own Git branch, worktree, and saved transcript.

Use `/orchestrator` when agents need to research, review, or implement separate parts of a project.
The coordinator tracks each task and collects reports and evidence.
You can see who owns the work, what is blocked, and what needs your decision.

## Try it

You need Pi, Node.js 24 or later, Git, Zellij, and an available Pi model.
Worker launch also checks GitHub CLI authentication, `origin` access if configured,
and Git signing if enabled.

From the Git checkout you want to work on, start a new Pi session with the package:

```sh
pi -e git:github.com/jchevertonwynne/pi-orchestrator
```

This loads the package for one invocation without adding it to your Pi settings.
If you already load it from a local checkout, use that source instead of loading both copies.
To add the Git source to future sessions, run:

```sh
pi install git:github.com/jchevertonwynne/pi-orchestrator
```

See the [local checkout instructions](docs/operator-reference.md#try-in-a-new-session) for development.

## Give it a task

Try a read-only task first:

> Use `/orchestrator` to have one subagent trace how this project runs its tests.
> Ask for a short report with file references and the command I would run.
> Do not edit files or push.

The coordinator can start the run for you.
Review the proposed plan if Pi asks for confirmation.
After the worker starts, you can check its tab or keep working in the coordinator.

| Command | What it does |
| --- | --- |
| `/orchestrator` | Start a run or open the interactive task board. |
| `/orchestrator status` | Show what needs attention and where work stands. |
| `/orchestrator board` | Show a live, compact task board. |
| `/orchestrator preflight` | Check Git, GitHub, and Zellij before launching workers. |
| `/orchestrator cleanup` | Review and confirm removal of eligible leftover resources. |

From the interactive board, select a task to inspect its worker, send a message, or resume a stopped worker.
See the [board key reference](docs/operator-reference.md#interactive-board) for details.

## How it works

- **Separate work.** One coordinator manages up to 10 live workers in a detached Zellij session.
  Workers have separate worktrees. The coordinator keeps the task state and results in a private local registry.
- **Keep context.** Steering messages reach a worker after its current tool batch.
  The worker can resume from its own transcript after it stops.
- **Verify before release.** A worker's `ready` result is not verification.
  Light runs let owners verify non-risky work. Strict runs and risky tasks require independent verification.
  Permission to implement does not by itself grant permission to push, open a PR, merge, deploy, or install.

## Limits and cleanup

The extension coordinates local processes. It is not a sandbox or an always-on supervisor.
The coordinator monitors the run while its Pi session is open.
Treat transcripts, reports, and test evidence as private.

**Worktree retention:** When a coordinator attaches, the extension can remove managed worktrees and their local branches after 14 days of inactivity,
even if the branches are not merged. This is separate from end-of-run cleanup.
See [recovery and cleanup](docs/operator-reference.md#recovery-and-cleanup) before leaving work in those worktrees.

## More information

- [Operator reference](docs/operator-reference.md): setup, configuration, tools, approvals, releases, and recovery.
- [Coordinator skill](skills/orchestrate-work/SKILL.md): how to assign tasks and collect results.
- [Verification](VERIFICATION.md): what the tests cover and what they do not.

For development, run `npm run check` in a dedicated Git worktree.
