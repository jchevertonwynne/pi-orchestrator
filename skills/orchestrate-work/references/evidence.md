# Evidence storage

Keep small, inspectable evidence: logs, diffs, hashes, the exact build/test command,
its exit code and the candidate commit.
Inspect actual output before attesting verification;
label missing or inconclusive checks **UNVERIFIED**.
Write evidence files before calls that reference them, not in the same parallel batch.

Never copy compiled binaries, module caches or vendor trees into a run.
Use the shared Go module cache rather than a per-run `GOMODCACHE`.
Build transient outputs outside the retained evidence directory;
retain their hashes and build logs instead of the binaries.

Once an ad-hoc verification worktree's evidence is saved outside that worktree,
review ownership and cleanliness before removing it.
Run `stacks` before cleanup and obtain the human's agreement on the candidate;
then use `git worktree remove` with its literal path, never `--force`.
Keep dirty, active or uncertain worktrees and retain branches.
Managed agent worktrees follow coordinator retirement and orchestrator cleanup rules,
not this ad-hoc removal path.
These rules authorize no cleanup of existing unrelated runs or data.
