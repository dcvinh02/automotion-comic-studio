# AutoMotion Comic Studio — Project Documentation

This folder is the shared project knowledge base for AI-assisted development.

## Documents
- `MASTER_TECHNICAL_SPEC.md` — product scope, architecture, modules, core technical decisions.
- `MASTER_DEVELOPMENT_PROMPT.md` — instructions for AI coding agents.
- `PROJECT_ROADMAP.md` — phased development plan and milestone tracking.
- `DATABASE_SCHEMA.md` — initial domain model and persistence rules.
- `DEVELOPMENT_RULES.md` — code safety, testing, Git, and change-control rules.

## How to use
1. Keep these files in the repository root or a clearly visible `docs/` folder.
2. Attach/reference the documents when starting a new AI coding session.
3. Before implementation, ask the AI to read all documents and inspect the current repository.
4. Update roadmap and schema documents when the implementation materially changes.
5. Treat source code as the implementation truth; documentation must be updated to match tested behavior.

## Current status
- Product vision and architecture: defined at planning level.
- Version 0.1: planned; implementation status must be verified in the repository.
- No feature should be marked complete without a real test or demonstrated working workflow.
