# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- The spec is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are individual files at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`, never a combined tickets file.
- Triage state is a `Status:` line near the top of each issue file.
  See `triage-labels.md` for the role strings.
- Append comments and conversation history under `## Comments`.

## When a skill says "publish to the issue tracker"

Create a file under `.scratch/<feature-slug>/`,
creating the directory if needed.

## When a skill says "fetch the relevant ticket"

Read the referenced file.
The user will normally provide its path or issue number.

## Wayfinding operations

Used by `/wayfinder`.
The map is a file with one child file per ticket.

- Map: `.scratch/<effort>/map.md`,
  containing Notes / Decisions-so-far / Fog.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`,
  numbered from `01`, with the question in the body.
  A `Type:` line records `research`, `prototype`, `grilling`, or `task`.
  Wayfinding lifecycle uses `Status: claimed` or `Status: resolved`.
- Blocking: a `Blocked by: NN, NN` line near the top.
  A ticket is unblocked when every listed ticket is resolved.
- Frontier: scan for open, unblocked, unclaimed tickets;
  first by number wins.
- Claim: set `Status: claimed` and save before work.
- Resolve: append the answer under `## Answer`,
  set `Status: resolved`,
  then append a gist and link to the map's Decisions-so-far.
