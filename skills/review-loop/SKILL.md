---
name: review-loop
description: Run a review and repair loop on a GitHub PR or the current local branch with orchestrator subagents. A fresh reviewer reports findings in tiers (blocker, major, minor, nit), a fixer repairs findings at or above a threshold, and re-reviews continue until none remain or a round cap is hit. Fixes stay on the fixer branch unless a PR update or a local fast-forward is authorized. Use when the human runs /review-loop or asks to review a PR or branch and fix findings until it is clean.
compatibility: Pi 0.87.1, Node 24+, Git, gh for PRs, and the standalone orchestrator extension.
---

# Review loop

This skill runs on top of [orchestrate-work](../orchestrate-work/SKILL.md).
PR pushes go through [release-work](../release-work/SKILL.md).
Follow both; this skill only adds the loop.
Use [the prompt templates](references/prompts.md) for every reviewer and fixer.

## Inputs

| Input | Default |
| --- | --- |
| Target | a PR number or URL; without one, the branch checked out in the session's cwd |
| Base (local branch only) | `origin`'s default branch |
| Threshold tier | `major` |
| Fix rounds cap | `3` |
| Reviewer model | `judgement` in `~/.pi/agent/model-roles.json` |
| Fixer model | `defaultProvider/defaultModel` in `~/.pi/agent/settings.json` |

`/review-loop` passes all of these. A bare invocation, even with a PR number or URL, does not request a push.
Apply [the push intent rule](../orchestrate-work/SKILL.md#push-intent-for-a-new-request) only to the human's actual request, not the expanded command.
For review-only work, report findings without creating a fix task.
If invoked directly without model arguments, read only the missing defaults from the Pi agent directory (`PI_CODING_AGENT_DIR` when set).
If a required default is missing or invalid, ask for an explicit model before spawning.
Pass the models explicitly on every spawn so neither inherits the coordinator's model.
If a model is unavailable, report the blocker; never substitute another.

## Tiers

Reviewers assign exactly one tier per finding:

| Tier | Meaning |
| --- | --- |
| *blocker* | Wrong behaviour, data loss, a security hole, a broken build or failing tests. Must not merge. |
| *major* | A likely bug, a missed requirement, a missing test for changed behaviour, or a design problem that will cost real rework later. |
| *minor* | A small correctness, clarity or robustness issue that is cheap to fix now. |
| *nit* | Style, naming or taste. |

"At or above the threshold" means that tier and every tier above it in this table.
Findings below the threshold are reported but never fixed by the loop.

## 1. Resolve the target

Both targets end with `H0` (the commit to review first), the base ref and `<name>` for task IDs.

### PR

1. Run `gh pr view <pr> --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,headRepository,headRepositoryOwner,isCrossRepository` from the repository checkout.
2. Stop if the PR is closed or merged.
   If `isCrossRepository` is true and the human requested a push, check ownership and target eligibility before proposing the scope.
3. Confirm the SSH agent is live, then `git fetch origin <headRefName> <baseRefName>`.
   Check that the fetched head equals `headRefOid`; if not, fetch again or stop.
4. `H0` is `headRefOid`, the base is `origin/<baseRefName>` and `<name>` is `pr<N>`.

### Local branch

1. In the given cwd, run `git rev-parse --show-toplevel` and `git branch --show-current`.
   Stop if it is not a repository or HEAD is detached.
   Use the primary checkout's path as the spawn `repo` (`git rev-parse --git-common-dir` points to it when cwd is a linked worktree).
2. If no base was given, use `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `origin/main` and then `main`.
   Stop if the base does not resolve, or if `git log <base>..HEAD` is empty.
3. If `git status --porcelain` lists changes, tell the human that uncommitted changes are not reviewed,
   and ask whether to continue or stop so they can commit first.
4. `H0` is `git rev-parse HEAD`, and `<name>` is `local-` plus the branch name with every run of characters other than letters, digits and `-` replaced by `-`.

## 2. Set up the run

1. Attach with `orchestrator_init` if this session is not attached (light profile unless the repository or change is risky).
   Mark the fix task `risky` if the change touches migrations, auth, security, data deletion or shared infrastructure.
2. For a repair loop, create the fix task `<name>-fix`.
   Its plan states the target, `H0`, the base, the threshold and the round cap.
   If the human requests a push and no applicable route is available, report the blocker instead of substituting PR authority.
   - PR with a requested push through an applicable route: `ships: true`.
     Name the confirmed remote and exact head ref in the plan. Limit the release to one fast-forward push to that ref.
     For a new eligible root in request-scoped mode, include the destination in `orchestrator_request` before start.
     The TUI grant does not cover reviewer plans. Staged and legacy rules still apply where applicable.
   - PR with no push requested: `ships: false`. Keep any fixes on the local fixer branch. Offer no push.
   - Local branch: `ships: false`; nothing is released, and fixes land by a confirmed local fast-forward.
3. Create the first review task `<name>-review-0` with `ships: false`.

## 3. Loop

Keep `C` as the commit under review (start with `H0`) and `k` as the fix round (start with 0).

### Review

1. Spawn a `reviewer` on `<name>-review-<k>` with the reviewer model, `base: C`, branch `review-loop/<name>-review-<k>`, and the reviewer prompt.
   For `k > 0`, include the previous review's report path so it can carry the ledger forward.
2. When its result arrives, read the report and `retire` the reviewer.
3. Tell the human, in one line, the count per tier and the open count at or above the threshold.

Each round uses a fresh reviewer.
It reviews the whole change from the base to `C`, not only the last fix,
and marks every earlier finding *resolved*, *open*, *disputed* or *withdrawn*.

### Decide

- Review-only request: report the findings and stop.
- No open findings at or above the threshold: go to [Land the fixes](#4-land-the-fixes).
- `k` equals the round cap: stop and [ask the human](#5-ask-the-human).
- A finding the fixer disputed is still open after review: [ask the human](#5-ask-the-human) about it; continue with the rest only if they say so.
- The open findings at or above the threshold match the previous round's ID for ID: the fixer is not making progress, so [ask the human](#5-ask-the-human).
- Otherwise: fix.

### Fix

1. Increment `k`.
   If `<name>-fix` is `ready`, call `orchestrator_task` `start` on it first.
2. Spawn an `implementer` on `<name>-fix` with the fixer model, `base: C`, branch `review-loop/<name>-fix-<k>`, and the fixer prompt with the latest review report path.
3. When its `ready` result arrives, record its commit as the new `C` and `retire` the fixer.
   A `blocked` or `failed` result stops the loop: [ask the human](#5-ask-the-human).
4. Create `<name>-review-<k>` with `ships: false` and review again.

Spawn each worker only after the previous one is retired, so the cap of 10 is never an issue.
When everything is waiting on a worker, end your turn; the watcher wakes you.

## 4. Land the fixes

If `C` is still `H0`, nothing changed: report the clean review and stop.
Otherwise confirm `H0` is an ancestor of `C` (`git merge-base --is-ancestor H0 C`).

### PR

1. Verify `<name>-fix` at `C` as the profile requires.
   If the task is local-only, report `C` and the local fixer branch, then stop without a push offer.
2. Check the PR head again with `gh pr view <pr> --json state,headRefOid`.
   If the PR is no longer open or its head moved from `H0`, stop and report; never force.
3. For a confirmed push-only request, use `orchestrator_scoped_push` as described in release-work
   and record evidence of the remote and PR head at `C`.
   In staged or legacy mode, use the `pr` action only when the human expressly authorizes updating the existing PR;
   record its URL at the `pr` stage. A plain push request is not a request for PR authority.

### Local branch

1. Show the human `git log --oneline H0..C` and ask with `ask_user` whether to fast-forward `<branch>` to `C`.
   The other option leaves `review-loop/<name>-fix-<k>` for them to merge.
2. On yes, check the branch still points at `H0` (`git rev-parse <branch>`).
   If it moved, leave the fix branch and say so.
3. In the checkout that has `<branch>` checked out (the cwd), run `git merge --ff-only C`.
   If it refuses because of uncommitted changes, leave the fix branch and say so; never stash, reset or force.
   If no checkout has `<branch>` checked out, run `git branch -f <branch> C` only after the ancestry check above.

Finish with the target, rounds used and the final count per tier, including findings left below the threshold.

## 5. Ask the human

Use `ask_user` with the open findings at or above the threshold (ID, tier, one line each) and these options:

- Run more fix rounds (say how many).
- Land what is fixed so far, leaving the rest open. Include this option only for a requested PR update with an applicable route or a local fast-forward.
  An answer here does not replace a release grant.
- Stop without landing; the fix branches stay for manual work.

For a disputed finding, offer: keep it and fix it, drop it, or lower its tier.
Record the answer in the next fixer or reviewer prompt as the human's decision.

## Rules

- Only the coordinator lands fixes, once, using the matching push-only, PR-update or local fast-forward permission.
- Workers never push, force, rebase the target or edit a PR description.
- Reviewers do not edit files.
- Fixers fix only open findings at or above the threshold, plus anything their fix breaks.
- A finding the fixer thinks is wrong is *disputed* in its report with a reason, not silently skipped.
