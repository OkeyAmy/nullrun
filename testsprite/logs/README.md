# TestSprite run artifacts

Purpose: public transparency evidence for the TestSprite UI suite that runs
on every pull request through GitHub Actions (workflow `.github/workflows/testsprite.yml`).

Files:

- `YYYY-MM-DD-run-<runId>-junit.xml` — the JUnit report produced by the
  TestSprite CLI (`0.13.0`) during that GitHub Actions run. Each `<testcase>`
  element carries the test name, test id and run id so any result can be
  cross-checked against the TestSprite dashboard.
- `YYYY-MM-DD-run-<runId>-summary.txt` — the batch/dispatch lines from the
  Actions log of the same run.

The suite executes against the Netlify pull-request preview
(`deploy-preview-1--nullrun.netlify.app`, environment `github-pr-1`), which is
redeployed automatically on every push to `ci/run-tests-on-prs`. The agent
runner navigates, clicks, types and pans the live application — nothing about
the application state is stubbed or teleported.
