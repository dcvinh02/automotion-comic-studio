# DEVELOPMENT RULES
## AutoMotion Comic Studio

## 1. Source control
- Use Git from the beginning.
- Commit only coherent, tested milestones.
- Use descriptive commit messages.
- Inspect `git status` before modifying or committing.
- Never reset, force-push, discard, or overwrite user work unless explicitly instructed.
- Keep secrets out of source control; use environment files and provide safe examples.

## 2. Change safety
Before editing:
1. Read the relevant code.
2. Find callers, contracts, and related tests.
3. Inspect the working tree for user changes.
4. Define the smallest safe scope.
5. Identify potential regressions.

After editing:
1. Review the diff.
2. Run focused tests.
3. Run type checks/lint/build as available.
4. Run regression tests for impacted workflows.
5. Report failures honestly.

## 3. Architecture
- Keep UI, domain, persistence, API, media, and AI provider layers separated.
- Avoid god files and circular dependencies.
- Do not duplicate services or models.
- Use typed interfaces.
- Validate untrusted inputs.
- Document intentional architectural deviations.

## 4. UI integrity
- Every enabled control must work.
- No fake progress or fake success.
- Mock/demo data must be clearly isolated from production workflows.
- Provide empty/loading/error/success states.
- Keep interaction patterns consistent.
- Avoid unrelated UI redesigns during bug fixes.

## 5. Data integrity
- Stable IDs.
- Schema/project version.
- Backup before risky migrations.
- Atomic writes where practical.
- Validate project loading.
- Never silently discard unknown data.
- Do not delete source assets when removing an index/reference unless the user explicitly chooses destructive deletion.

## 6. Media reliability
- Keep expensive processing off the UI thread.
- Use background jobs.
- Handle cancellation and cleanup.
- Validate output files after export.
- Check duration, FPS, dimensions, audio presence, and basic playback.
- Use a single timeline/frame conversion convention.

## 7. Testing
Use appropriate layers:
- Unit tests for domain logic and utilities.
- Component tests for interaction behavior.
- Integration tests for frontend/backend and persistence.
- End-to-end tests for major workflows.
- Manual verification for graphics/audio/render quality.

Tests must be meaningful. Do not weaken or delete tests just to obtain a green build without explaining why.

## 8. Feature acceptance
A feature is DONE only when:
- Its actual logic is implemented.
- It is connected to the workflow.
- Relevant edge/error states are handled.
- Persistence works where required.
- Tests/checks pass.
- Documentation is updated.
- Any remaining limitations are stated.

## 9. AI task protocol
For complex tasks, AI should:
1. Audit current state.
2. Summarize findings.
3. Plan implementation.
4. Implement scoped changes.
5. Test and inspect.
6. Review regressions.
7. Update docs and roadmap.
8. Report results.

Do not claim files were changed, tests passed, or functionality works without direct evidence.

## 10. Task report template
- **Task:**
- **Status:** DONE / PARTIAL / BLOCKED
- **Summary:**
- **Files created/modified:**
- **Behavior verified:**
- **Tests/checks:**
- **Known issues:**
- **Risks/regressions:**
- **Roadmap/documentation updates:**
- **Next recommended task:**
