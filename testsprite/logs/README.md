# TestSprite run artifacts

Purpose: public transparency evidence for the TestSprite UI suite that runs
on every pull request through GitHub Actions (workflow `.github/workflows/testsprite.yml`).

Files:

- `YYYY-MM-DD-run-<runId>-junit.xml` — the JUnit report produced by the
  TestSprite CLI (`0.15.0`) during that GitHub Actions run. Each `<testcase>`
  element carries the test name, test id and run id so any result can be
  cross-checked against the TestSprite dashboard.
- `YYYY-MM-DD-run-<runId>-summary.json` — the execution summary the CLI
  writes alongside the report (per-test statuses and the execution report),
  from the same run.
- The earlier `2026-10-20-run-39498676016-*` files were captured while the
  workflow still used the official action; they are kept as history.

The suite executes against the Netlify pull-request preview
(`deploy-preview-1--nullrun.netlify.app`, environment `github-pr-1`), which is
redeployed automatically on every push to `ci/run-tests-on-prs`. The runner
navigates, clicks, types and pans the live application — nothing about the
application state is stubbed or teleported.
