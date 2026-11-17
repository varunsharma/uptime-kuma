# CI test failure containment and replay

The backend Jest command runs serially with a custom Circus environment. At the
first test-body or hook failure, it marks unstarted tests and unentered suites
to skip. The current test's teardown and cleanup hooks in suites that already
started still run. Jest exits nonzero, which fails that matrix leg. Each matrix
stage uses fail-fast with at most five active legs.

CI uses three dependent matrix jobs, each with the same OS/Node matrix: the
previous-failure and interrupted-test stage, the historically risky stage, and
the canonical full-suite stage. A stage starts only after every matrix leg in
the prior stage passes. This creates a workflow-wide barrier: no OS/Node leg
starts risk replay while another leg is still replaying previous failures, and
no canonical leg starts while any risk replay remains. A failed stage causes
GitHub Actions to skip all later stages; fail-fast cancels unfinished legs in
that matrix run. The existing `auto-test` job name remains on the canonical
stage. Linters run only after it succeeds; E2E also remains behind lint and the
canonical backend matrix.

Within the first stage, recorded failures and interrupted tests run in separate
Jest invocations: failures first, then interrupted tests. A failure or
unverifiable result in either group stops before the next group. Historically
risky tests run in the second stage, before the canonical suite. The adapter
selects them by bounded failure count with test name as a deterministic
tie-breaker; Jest itself executes the selected tests in file declaration order.
The canonical stage runs the complete backend suite. A prior failure or
interruption remains recorded until that test reports a completed passing
assertion; missing, pending, skipped, or todo results do not resolve old
history.

The complete configured Jest suite is currently the affected set:
`jest-backend.config.js` selects `test/backend.spec.js` and
`test/ci-test-replay.spec.js`, and there is no test-to-source-file map. If the
repository adds Jest files, this assumption must be revisited before claiming a
narrower changed-file pre-pass.

History scope is stable across commits and includes repository, PR-or-branch
identity, head and base refs, backend lane, operating system, and Node major
version. SHA, run ID, attempt, job, workflow, and event are stored as bounded
provenance context, not as stable key inputs, so a later commit can replay
earlier failures in the same scope. Each unresolved test ID has its own origin
record. That origin remains attached until the ID has a completed passing
assertion. The one-time v1 cache import restores the old cache at its original
workspace-relative path, stages its validated files separately, then restores
v2 history into the new path. It accepts only an exact repository, pull
request number (or branch), lane, OS, and Node scope match. It preserves every
old failed, pending, and risk ID. Since v1 did not map individual test IDs to
run contexts and did not record base refs, imported unresolved IDs are marked
`legacy: true`; their per-test origin run, commit, and base fields remain
explicitly unknown. The old rolling run contexts are retained as global legacy
context, but are not attributed to specific tests. Ambiguous, malformed, or
scope-mismatched v1 history stops the job before tests rather than silently
discarding it. The imported source digest is stored in the v2 state so a later
passing assertion is not undone by importing the same v1 snapshot again.

The Actions cache prefix is derived from the same stable scope digest as the
state file. Each phase saves an immutable key for that run and attempt. The
initial previous-failure stage may start from an ordinary cache miss; the risk
and canonical stages require the immediately prior phase's exact snapshot and
fail before tests if it is missing. Cache-service errors can still interrupt
the initial import/save path, and missing/evicted snapshots from earlier runs
cannot be reconstructed. This transport remains best-effort and cannot
guarantee complete history.

GitHub Actions cache is best-effort history storage. Cache expiry, hard
termination before the save step, and concurrent runs on the same scope can
lose history. Concurrent runs may restore the same older snapshot and save
separate run-scoped snapshots; this workflow does not serialize those runs or
guarantee a union of their histories. It does not cancel another workflow run,
commit, or pull request.
