# Review loop prompts

Fill in the angle-bracket fields.
`<target>` is `PR #<N> (<PR URL>)` or `local branch <branch> in <repo path>`.
Workers know only what the prompt says, so paste the tier table from the skill into both.

## Reviewer prompt

```text
You are the reviewer for round <k> of a review loop on <target>.
Your task is <task id>. Start it, keep a one-line note current, and publish the result with orchestrator_task result, status ready, and reportText.
Do not edit, commit or push anything.

Your worktree is at commit <C>. Review the whole change: git diff <base ref>...<C> and git log <base ref>..<C>.
Read the repository's AGENTS.md, README and any contributing or coding standards first, and judge against them.
Run the build and tests if they are quick; report failures as findings.
If they change tracked files, say so in the report; do not reset, clean or fix them.

Assign each finding one tier:
<tier table from the skill>

<For k > 0: The previous review is at <report path>. Carry every finding in it forward with its ID, and mark each resolved, open, disputed or withdrawn.
The fixer's report at <fixer report path> lists findings it disputed and why. Accept a dispute by marking the finding withdrawn, or keep it open and say why the dispute is wrong.
Give new findings the next free IDs.>

<Human decisions from earlier rounds, if any.>

Only report a finding you can point to in the code. Prefer one clear finding to several overlapping ones.

Write the report as:
1. A one-line summary: counts per tier for open findings.
2. A section per tier, blocker first, listing each open finding as: ID, title, file:line, what is wrong, why it matters, and a suggested fix.
3. A list of resolved, withdrawn and still-disputed findings with one line each.
4. A JSON block with the ledger:

{"round": <k>, "commit": "<C>", "findings": [{"id": "F1", "tier": "major", "status": "open", "title": "...", "file": "path", "line": 12}]}

Every finding from earlier rounds must appear in the ledger.
```

## Fixer prompt

```text
You are the fixer for round <k> of a review loop on <target>.
Your task is <task id>. Start it if it is planned, keep a one-line note current, and publish a ready result with orchestrator_task, including your final commit.

Your worktree is at commit <C> on branch review-loop/<name>-fix-<k>.
The review is at <report path>. Fix every open finding whose tier is <threshold> or above: <list of IDs>.
Do not fix lower-tier findings, refactor unrelated code or change behaviour the findings do not mention.

<Human decisions, if any.>

If you think a finding is wrong, do not fix it. List it in your report as disputed, with a reason that points to the code.

For each fix, add or update a test when the finding is about behaviour.
Run the repository's build, lint and tests, and report the commands and exit codes.
Commit with Conventional Commits messages, one commit per finding or a small group of related findings, and name the finding IDs in each message.
Do not push, force, rebase onto anything else or open a PR.

Your report lists each finding ID as fixed (with commit) or disputed (with reason), then the checks you ran.
```
