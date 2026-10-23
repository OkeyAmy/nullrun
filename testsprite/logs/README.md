# TestSprite run artifacts

Purpose: public transparency evidence for the TestSprite UI suite that runs
on every pull request through the TestSprite GitHub App check.

Files:

- `YYYY-MM-DD-run-<runId>-junit.xml` — the JUnit report produced by the
  TestSprite CLI during a suite run. Each `<testcase>` element carries the
  test name, test id and run id so any result can be cross-checked against
  the TestSprite dashboard.
- `YYYY-MM-DD-run-<runId>-summary.json` — the execution summary the CLI
  writes alongside the report (per-test statuses and the execution report),
  from the same run.

The `2026-10-20` artifacts were captured while the suite was also wired
through a GitHub Actions workflow. That workflow has since been retired in
favour of the App check, which runs the same suite automatically on every
pull request deploy.

The suite executes against the pull request's deploy preview
(`deploy-preview-1--nullrun.netlify.app`), which is redeployed automatically
on every push. The runner navigates, clicks, types and pans the live
application — nothing about the application state is stubbed or teleported.
