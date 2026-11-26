# Native plan Markdown verification

Verified on 2026-10-28 with Pi 1.4.0.
The orchestrator plan viewer uses Pi's public `Markdown` and `getMarkdownTheme()` APIs.
Press `m` to switch formatted/raw source;
mode and scroll position survive cancelled approval.
Generic task-details and terminal-dump viewers remain plain text.
Approval revalidation, original source hashes and Crit snapshots are unchanged.
No new runtime dependency was added.

## Automated checks

Ran `PI_HOST_PACKAGE=<installed Pi 1.4.0 package> npm run check`:
521 tests passed, zero failures or skipped tests,
followed by successful static skill/reference validation.
`git diff --check` passed.
There is no separate build script in this package.

Host-double tests cover cache/mode behavior,
readonly plan controls,
and existing approval/staleness/cancellation checks.
Installed-host component tests additionally cover real Markdown parsing/styling,
tables, nested lists, code, links and Unicode,
raw mode,
source-control sanitization,
resize bounds and dark/light theme invalidation.
Installed-host bridge tests exercise real Markdown through both approval and Crit paths,
checking original plan hashes/source bytes after toggling to raw.
These component/bridge checks are not real-terminal proof.

## Real Pi TUI

Launched an isolated interactive Pi in detached Zellij session `planmd-1028`,
with temporary HOME/agent/session directories,
only explicit candidate and finite offline fixture extensions,
and discovery/network/MCP disabled.
`test/plan-markdown-tui.ts` is a finite synthetic provider, not a reasoning worker.
Initialized a synthetic strict registry and created one non-shipping fixture task.
No workers launched.

At 50 columns by 47 rows,
opened the actual orchestrator board and plan viewer,
observed formatted headings, emphasis, inline/fenced code, nested lists, a table and quote,
then toggled raw source.
Opened the existing approval confirmation and cancelled it;
the viewer resumed in raw mode.
Verified the synthetic task remained `planned`,
with no approval and unchanged SHA-256 of the original plan file.
Exited Pi via `/fixture-exit`.

Retained synthetic screen dumps:
`formatted.ansi`, `raw.ansi`, `confirmation.txt`, `resumed-raw.ansi`.
Temporary absolute paths are replaced by `<fixture>`.
Real-terminal wide-layout/theme switching and Crit browser launch were not exercised;
those paths were checked through installed-host/synthetic tests.
No merge, installation, release or user-registry changes occurred during verification.
