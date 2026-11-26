# Skill evaluation

## Static validation

From the package root, run:

```sh
node evals/validate.mjs
```

The validator uses only Node built-ins.
It reads files without loading extensions, launching Pi/Zellij,
changing settings, accessing a network, or performing release actions.
It checks portable frontmatter, package skill discovery paths, local Markdown references,
and the structure of each skill's eval suite.
It reports the shared contract hash to make interface review reproducible.
This is static validation, not a Pi startup test or behavioral model evaluation.

## Behavioral fixtures

Each skill carries its own skill-creator-compatible suite:

- [orchestrate-work](../skills/orchestrate-work/evals/evals.json)
- [release-work](../skills/release-work/evals/evals.json)
- [recover-work](../skills/recover-work/evals/evals.json)
- [review-loop](../skills/review-loop/evals/evals.json)

`expectations` contains the verifiable assertions,
following the installed skill-creator schema.
Prompts supply all synthetic facts inline, so `files` arrays are empty.
Labels such as H1, C, or d2 are symbolic fixture identities,
not executable Git hashes or claims about a real repository.

No behavioral eval runs, benchmark scores, optimization sweeps,
or real PR/merge/deploy operations are included or claimed.
The parent may arrange sandboxed paired runs if feasible.

## Paired evaluation protocol

Run the same prompt with the skill and without it in fresh isolated contexts.
Keep repository instructions and synthetic facts identical between the pair.
Use the required `openai-codex/gpt-6-astra` explicitly for each agent;
if unavailable, report the blocker instead of substituting another model.
If agents are launched, use named interactive Pi tabs in a separate task-specific Zellij session,
with dedicated transcripts and exact session/tab/pane targeting.
Do not use print mode, pipes, or detached Pi processes outside Zellij.

These cases request dry-run outputs.
Do not grant either run access to live release credentials, existing user sessions,
real worktrees, databases, browsers, or deployment services.
An optional fake executor must return synthetic observations only;
never turn proposed commands into real effects.
Human approval references in fixture prompts are test data,
not authority to approve or release actual work.

Retain both outputs and transcripts.
Grade each expectation against cited output/tool evidence,
including prohibited actions actually attempted rather than just promises in final prose.
Use `text`, `passed`, and `evidence` for graded expectations.
Report missing runtime/tool exercise as a limitation:
a dry-run plan can pass these assertions without proving extension behavior.

Present paired results to the human before changing the skills based on them.
Do not invent timing, pass rates, or reliability claims for runs that did not happen.

## Interface alignment gate

The documented commands are the parent's planned surface,
and persisted vocabulary comes from `src/contracts.ts`.
Before final integration, the parent must compare actual command/tool schemas,
human-confirmation behavior, resume/receipt handling, and release transitions with
[the interface reference](../skills/orchestrate-work/references/interface.md).
In particular, no public receipt-repair action, plan-update action,
model argument in `SpawnInput`, or time-based release lock expiry is assumed.
