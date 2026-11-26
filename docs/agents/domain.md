# Domain Docs

This repo uses a single-context domain model.

## Before exploring

Read root `GLOSSARY.md` and any ADRs in `docs/adr/`
that touch the area you are about to work in.

If these files do not exist, proceed silently.
Domain modeling creates them lazily
when terms or decisions are resolved.

## File structure

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/`: architecture decision records.

## Use the glossary's vocabulary

Use glossary terms when naming domain concepts
in issues, proposals, hypotheses, and tests.
Avoid synonyms the glossary explicitly rejects.

If a concept is missing, reconsider whether it belongs,
or note the gap for `/domain-modeling`.

## Flag ADR conflicts

Surface contradictions with existing ADRs explicitly,
identifying the ADR and why reopening it may be worthwhile.
