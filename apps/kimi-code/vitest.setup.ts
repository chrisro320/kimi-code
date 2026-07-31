/**
 * Strip deployment-wrapper env leakage before any test runs.
 *
 * `~/.local/bin/kimi` exports `KIMI_CODE_NO_AUTO_UPDATE=1`, so a shell spawned
 * from (or profiled alongside) the deployed wrapper carries it into vitest.
 * `runUpdatePreflight` then returns before it reads the update cache and all 34
 * preflight tests fail — a failure mode indistinguishable from a real
 * regression unless you already know to look for it. Deleting the variable here
 * makes the suite independent of whichever shell launched it.
 */
delete process.env.KIMI_CODE_NO_AUTO_UPDATE;
