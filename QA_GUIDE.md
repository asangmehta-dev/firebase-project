# Claude Code QA & Regression Prevention Guide

## The Core Problem

AI coding assistants are excellent at implementing requested changes,
but they are **not inherently QA systems**.

A common failure mode is:

1.  Add a feature.
2.  Fix a bug introduced by that feature.
3.  Accidentally break something else.
4.  Repeat.

This "whack-a-mole" effect is normal on larger projects.

The solution is to build a workflow that forces verification instead of
relying on the AI to remember everything.

------------------------------------------------------------------------

# 1. Always Use a Test-Driven Workflow

Every time a bug is fixed:

1.  Reproduce the bug with a failing automated test.
2.  Make the smallest possible code change.
3.  Run the new test.
4.  Run the complete test suite.
5.  Run:
    -   Type checking
    -   Linting
    -   Production build
6.  Review the final git diff.

Without the regression test, the bug can easily return later.

------------------------------------------------------------------------

# 2. Create a CLAUDE.md File

Example:

``` markdown
# Development and QA Rules

## Mandatory workflow

Before modifying code:

1. Understand the existing implementation and identify all affected call sites.
2. State the expected behavior and edge cases.
3. Run the existing tests.
4. For every bug, first create a failing regression test.

After modifying code:

1. Run tests covering the changed functionality.
2. Run the complete test suite.
3. Run:
   - type checking
   - linting
   - production build
4. Review git diff for unrelated changes.
5. Report every command that was actually run.
6. Never claim completion if checks were skipped or failed.

## Change discipline

- Make the smallest change necessary.
- Never refactor unrelated code.
- Preserve existing behavior.
- Search for every caller before modifying shared code.
- Never delete tests simply because they fail.
- Never weaken assertions.

## Error handling

- Never swallow exceptions.
- Never hide failures behind placeholder data.
- Never use silent fallbacks.
- Fallbacks must be explicit and observable.

## Completion report

Provide:

- Files changed
- Behavior changed
- Tests added
- Commands executed
- Results
- Remaining risks
```

Project-specific commands:

``` text
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npx playwright test
```

------------------------------------------------------------------------

# 3. Always Plan Before Editing

Prompt:

``` text
Do not edit code yet.

Investigate this feature.

Provide:

1. Root cause / current implementation
2. Files affected
3. Existing tests
4. Missing tests
5. Minimal implementation plan
6. Regression risks

Wait for approval before editing.
```

------------------------------------------------------------------------

# 4. Make Testing Mandatory

Do not rely on Claude remembering.

Instead enforce:

-   Unit tests
-   Integration tests
-   Type checking
-   Linting
-   Production build
-   End-to-end tests

Use GitHub/GitLab branch protection and CI so merges cannot happen until
everything passes.

------------------------------------------------------------------------

# 5. Separate Builder From Reviewer

After implementation, start a fresh Claude session.

Prompt:

``` text
Review this diff.

Assume the implementation is wrong.

Look for:

- regressions
- incomplete updates
- race conditions
- incorrect error handling
- schema incompatibilities
- authorization bugs
- happy-path-only tests
- hidden failures
- missing edge cases

Compare the implementation to the requirements.

Provide concrete findings with file references.
```

------------------------------------------------------------------------

# 6. Keep Changes Small

Avoid combining:

-   Features
-   Refactors
-   Dependency upgrades
-   UI cleanup
-   Schema changes

Instead:

1.  Add tests.
2.  Implement feature.
3.  Refactor later.
4.  Cleanup in another commit.

Prompt:

``` text
Keep the diff as small as possible.

Do not refactor unrelated code.

If a broader refactor is needed, stop and explain why.
```

------------------------------------------------------------------------

# 7. UI Apps Need End-to-End Tests

Unit tests alone are insufficient.

Add Playwright or Cypress tests for critical user journeys:

-   Create record
-   Edit record
-   Authentication
-   Permissions
-   Error handling
-   Refresh persistence
-   Navigation
-   Visual regressions

------------------------------------------------------------------------

# 8. Standard Prompt for Every Feature

``` text
Implement this using a test-driven, regression-safe workflow.

Requirement:
[Describe feature]

Acceptance criteria:
[List expected behaviors]

Before editing:
- inspect architecture
- identify affected behaviors
- run existing tests
- propose minimal implementation

During implementation:
- add tests
- add regression tests for every bug
- do not refactor unrelated code
- avoid silent fallbacks

Before completion:
- run targeted tests
- run full suite
- run lint
- run typecheck
- run production build
- inspect git diff
- report every command run
- identify remaining risks

Do not claim completion unless every required check passes.
```

------------------------------------------------------------------------

# Final Takeaway

Claude is an excellent programmer, but it is **not a replacement for
automated QA**.

The reliable workflow is:

> Claude writes code → Automated tests verify behavior → CI blocks
> regressions → Separate review examines the diff → Merge only small,
> verified changes.

This dramatically reduces regression risk and the "whack-a-mole" cycle.
