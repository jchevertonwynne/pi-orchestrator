# Verification

## Run the checks

Run the following command from the package root with Node.js 24 or later:

```sh
npm run check
```

The tests use temporary Git repositories, registries and transcripts.
They use injected process runners for Pi, Zellij and external actions.
The static check validates skill discovery, local references and synthetic scenario definitions.
It does not run the model or evaluate its responses to those scenarios.

To include the installed-Pi compatibility tests, point `PI_HOST_PACKAGE` to the installed Pi package:

```sh
PI_HOST_PACKAGE=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent npm run check
```

Without `PI_HOST_PACKAGE`, the runner skips those tests.
The package has no separate build or type-check command.

## Coverage

- Task ownership, dependency and approval gates, and release claims.
- Git worktree isolation, worker launch and resume identity, and peer-preserving tab cleanup.
- Durable inbox delivery, transcript receipts, reload behavior, and orderly shutdown.
- Board, approval and resume dialogs, including plan changes and cancelled confirmation.
- Cleanup eligibility and preservation checks for Git worktrees and Docker resources.

The [plan viewer smoke test](evidence/plan-markdown/verification.md) records an isolated interactive Pi and Zellij check with a scripted provider and a synthetic task.
The retained terminal captures are synthetic fixtures, not evidence from a private session.

## Limits

Passing the checks does not verify a real GitHub PR, deployment, or installation.
Release records are attestations that require separate evidence.
Whole-session recovery has automated coverage with injected processes.
These checks do not demonstrate abrupt power-loss recovery or compatibility with every combination of Pi, Zellij, and operating system.
