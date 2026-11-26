# Pi orchestrator development

This is a standalone Pi package.
Work in dedicated Git worktrees only.
Do not install or load this package into existing Pi sessions or modify existing watchers, settings, or skills.
Leave unrelated agents, services, and worktrees unchanged.
Use built-in Node APIs and Pi-provided peers; no new runtime dependencies.
Target Node 24+ and Pi 0.87.1; read installed Pi docs/examples before using extension APIs.
Use semantic line breaks in Markdown/comments and Conventional Commits.
Tests must be synthetic and isolated; never push/PR/merge/deploy as part of package tests.
The extension is workflow tooling, not a security sandbox against other same-OS-user processes.

Shared contract is src/contracts.ts.
Coordinate changes before editing it.
All filesystem/process actions must use literal paths/argv, not shell string construction.
User approvals and release facts are recorded attestations, not proof that external actions succeeded.
No tool may silently promote an agent result to verification or infer approval from marker contents.
Automatic cleanup is limited to the coordinator's finished current run:
clean worktrees proven integrated into the default branch (ancestry or identical tracked trees),
reserved Compose projects with volumes kept, stale worker records, ended reservations and the owned worker session.
Every task must have ended and every worker PID must be gone; keep branches and re-check each item before removal.
Docker volume deletion requires explicit TUI confirmation, including during automatic cleanup.
`/orchestrator cleanup` keeps manual selection and confirmation for this run and abandoned earlier runs.
Never force worktree removal, deploy automatically or force-reset.
The coordinator's existing pruning of stale worktrees under `~/.local/share/pi-orchestrator/worktrees` is separate.

## Agent skills

### Issue tracker

Issues and specs live in `.scratch/<feature>/`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage roles as status strings.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`.
See `docs/agents/domain.md`.
