# Repository change guardrails

## Before editing

- Write concrete acceptance criteria and map every planned behavior change to one.
- Do not remove, weaken, or replace existing user-visible behavior unless the request requires it. If it becomes necessary, explain the impact before editing.
- Performance work requires evidence from profiling, logs, or a reproducible benchmark. Keep unrelated optimization in a separate change.
- When replacing an existing mechanism, verify the replacement in the actual runtime path and add regression coverage for the preserved behavior.

## Before committing

- Review every changed line and deletion; each must trace to the request or its required verification.
- For bug fixes, first add a test that fails for the reported behavior, then make it pass.
- List user-visible behavior changes and removed mechanisms explicitly in the pull request description.
- Do not mix unrelated cleanup, refactoring, or formatting into the same pull request.
