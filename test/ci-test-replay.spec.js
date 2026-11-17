const fs = require("fs");
const os = require("os");
const path = require("path");
const { ReplayHistory, importLegacyCache, stageLegacyCache, statePath, testId, validateState } = require("./ci-test-replay-state");
const { contextFromEnvironment, requirePriorStageCacheHit, runPrioritizedSuites, runReplayPhase, verifyReplayResults } = require("./ci-test-replay");
const { clearNewSkippedTest, pendingIdForEvent, stopUnstartedTests } = require("./ci-test-stop-environment");

describe("CI test replay policy", () => {
    let directory;

    function workflowJobBlock(workflow, name) {
        const lines = workflow.split(/\r?\n/);
        const start = lines.indexOf(`  ${name}:`);
        if (start === -1) {
            return "";
        }
        const block = [];
        for (let index = start; index < lines.length; index++) {
            if (index > start && /^  [a-z][\w-]*:$/.test(lines[index])) {
                break;
            }
            block.push(lines[index]);
        }
        return block.join("\n");
    }

    const context = () => ({
        repository: "varunsharma/uptime-kuma",
        branch: "ci-replay-test",
        headRef: "ci-replay-test",
        baseRef: "master",
        headSha: "abc123",
        baseSha: "base123",
        pr: "24",
        event: "pull_request",
        workflow: "Auto Test",
        scopeKind: "pr",
        scopeId: "pr:24",
        lane: "backend",
        os: "linux",
        node: "18",
        sha: "abc123",
        run: "100",
        attempt: "1",
        job: "auto-test",
    });

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-kuma-replay-test-"));
    });

    it("holds the complete matrix behind global previous, risk, then canonical barriers", () => {
        const workflowDirectory = path.join(__dirname, "..", ".github", "workflows");
        const workflow = fs.readFileSync(path.join(workflowDirectory, "auto-test.yml"), "utf8");
        const stageWorkflow = fs.readFileSync(path.join(workflowDirectory, "..", "actions", "auto-test-stage", "action.yml"), "utf8");
        const previous = workflowJobBlock(workflow, "auto-test-previous");
        const risk = workflowJobBlock(workflow, "auto-test-risk");
        const canonical = workflowJobBlock(workflow, "auto-test");
        const linters = workflowJobBlock(workflow, "check-linters");
        const e2e = workflowJobBlock(workflow, "e2e-tests");

        [previous, risk, canonical].forEach((job) => {
            const checkout = job.indexOf("uses: actions/checkout@v3");
            const localAction = job.indexOf("uses: ./.github/actions/auto-test-stage");
            expect(checkout).toBeGreaterThanOrEqual(0);
            expect(localAction).toBeGreaterThan(checkout);
        });
        expect(previous).not.toMatch(/^    needs:/m);
        expect(risk).toMatch(/^    needs:\s*\[\s*auto-test-previous\s*\]$/m);
        expect(canonical).toMatch(/^    needs:\s*\[\s*auto-test-risk\s*\]$/m);
        expect(linters).toMatch(/^    needs:\s*\[\s*auto-test\s*\]$/m);
        expect(e2e).toMatch(/^    needs:\s*\[\s*check-linters\s*,\s*auto-test\s*\]$/m);
        [previous, risk, canonical].forEach((job) => {
            expect(job).toMatch(/^    timeout-minutes: 15$/m);
            expect(job).toMatch(/fail-fast:\s*true/);
            expect(job).toMatch(/max-parallel:\s*5/);
            expect(job).toMatch(/os:\s*\[macos-latest, ubuntu-latest, windows-latest\]/);
            expect(job).toMatch(/node:\s*\[\s*14, 16, 17, 18\s*\]/);
        });
        expect(workflow).toMatch(/auto-test-previous:[\s\S]*?uses:\s*\.\/\.github\/actions\/auto-test-stage/);
        expect(workflow).toMatch(/auto-test-risk:[\s\S]*?needs:\s*\[\s*auto-test-previous\s*\][\s\S]*?uses:/);
        expect(workflow).toMatch(/auto-test:[\s\S]*?needs:\s*\[\s*auto-test-risk\s*\][\s\S]*?uses:/);
        expect(workflow).toMatch(/stage:\s*risk\s+prior-stage:\s*previous/);
        expect(workflow).toMatch(/stage:\s*canonical\s+prior-stage:\s*risk/);
        expect(workflow).not.toMatch(/cancel-in-progress:\s*true/);
        expect((workflow.match(/just-for-test:\s*\$\{\{ secrets\.JUST_FOR_TEST \}\}/g) || [])).toHaveLength(3);

        expect(stageWorkflow).toMatch(/name:\s*Backend test stage/);
        expect(workflow).toMatch(/stage:\s*previous/);
        expect(workflow).toMatch(/stage:\s*risk/);
        expect(workflow).toMatch(/stage:\s*canonical/);
        expect(stageWorkflow).toMatch(/CI_TEST_REPLAY_PHASE:\s*\$\{\{ inputs\.stage \}\}/);
        expect(stageWorkflow).toMatch(/if: always\(\)/);
        expect(stageWorkflow).toMatch(/key: uptime-kuma-replay-\$\{\{ steps\.replay-scope\.outputs\.key \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ inputs\.stage \}\}/);
        expect(stageWorkflow).toMatch(/key: uptime-kuma-replay-\$\{\{ steps\.replay-scope\.outputs\.key \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ inputs\.prior-stage \}\}/);
        expect(stageWorkflow).toMatch(/path: \.ci-test-replay/);
        expect(stageWorkflow).not.toMatch(/continue-on-error:\s*true/);

        const lintersJob = workflowJobBlock(workflow, "check-linters");
        const e2eJob = workflowJobBlock(workflow, "e2e-tests");
        expect(lintersJob).toMatch(/^    timeout-minutes: 15$/m);
        expect(e2eJob).toMatch(/^    timeout-minutes: 30$/m);

        // The complete configured Jest suite is the affected set until this
        // repository has an explicit test-to-source-file map.
        const jestConfig = require("../config/jest-backend.config");
        expect(jestConfig.testRegex).toBe("./test/(?:backend|ci-test-replay)\\.spec.js");
    });

    afterEach(() => {
        fs.rmdirSync(directory, { recursive: true });
    });

    it("stops unstarted siblings while leaving the current test for cleanup", () => {
        const root = { type: "describeBlock", name: "ROOT", children: [] };
        const suite = { type: "describeBlock", name: "Suite", parent: root, children: [] };
        const current = { type: "test", name: "first", parent: suite, status: null, startedAt: 1 };
        const next = { type: "test", name: "second", parent: suite, status: null, startedAt: null };
        const laterSuite = { type: "describeBlock", name: "Later suite", parent: root, children: [] };
        laterSuite.children.push({ type: "test", name: "third", parent: laterSuite, status: null, startedAt: null });
        suite.children.push(current, next, laterSuite);
        root.children.push(suite);

        stopUnstartedTests(root, current);

        expect(current.mode).toBeUndefined();
        expect(next.mode).toBe("skip");
        expect(laterSuite.mode).toBe("skip");
    });

    it("records Jest 27 add_test events from testName and currentDescribeBlock", () => {
        const root = { type: "describeBlock", name: "ROOT_DESCRIBE_BLOCK", parent: null, children: [] };
        const suite = { type: "describeBlock", name: "Outer suite", parent: root, children: [] };

        expect(pendingIdForEvent({ name: "add_test", testName: "first case" }, { currentDescribeBlock: suite }))
            .toBe("Outer suite first case");
    });

    it("retains interrupted IDs when a later run skips them", () => {
        const file = path.join(directory, "history.json");
        const history = new ReplayHistory(file, context());
        const interrupted = "Suite interrupted case";
        const newlySkipped = "Suite newly skipped case";
        history.addPending(interrupted);
        const unresolvedAtStart = new Set(history.state.pending);
        history.addPending(newlySkipped);

        clearNewSkippedTest(history, interrupted, unresolvedAtStart);
        clearNewSkippedTest(history, newlySkipped, unresolvedAtStart);

        expect(new ReplayHistory(file, context(), false).priorityGroups()[1]).toContain(interrupted);
        expect(new ReplayHistory(file, context(), false).priorityGroups()[1]).not.toContain(newlySkipped);
    });

    it("retains failed and interrupted history until each test completes successfully", () => {
        const file = path.join(directory, "history.json");
        const history = new ReplayHistory(file, context());
        const parent = { name: "Suite", parent: { name: "ROOT" } };
        const test = { name: "case", parent, errors: [new Error("failed")], status: "done", failing: false };
        const id = testId(test);

        history.addPending(id);
        history.recordTestDone(test);
        const afterFailure = new ReplayHistory(file, context(), false);
        expect(afterFailure.priorityGroups()[0]).toContain(id);
        expect(afterFailure.priorityGroups()[1]).not.toContain(id);

        afterFailure.recordTestDone(Object.assign({}, test, { errors: [], status: "skip" }));
        expect(new ReplayHistory(file, context(), false).priorityGroups()[0]).toContain(id);
        afterFailure.recordTestDone(Object.assign({}, test, { errors: [], status: "pending" }));
        expect(new ReplayHistory(file, context(), false).priorityGroups()[0]).toContain(id);
        afterFailure.recordTestDone(Object.assign({}, test, { errors: [], status: undefined }));
        expect(new ReplayHistory(file, context(), false).priorityGroups()[0]).toContain(id);

        new ReplayHistory(file, context(), false).recordTestDone(Object.assign({}, test, { errors: [], status: "done" }));
        const resolved = new ReplayHistory(file, context(), false);
        expect(resolved.priorityGroups()[0]).not.toContain(id);
        expect(resolved.priorityGroups()[1]).not.toContain(id);
    });

    it("retains each unresolved test's originating run context until a passing assertion", () => {
        const file = path.join(directory, "history.json");
        const id = "Suite case";
        const origin = context();
        const history = new ReplayHistory(file, origin);
        history.addPending(id);
        const captured = history.state.origins[id];
        expect(captured).toMatchObject({
            repository: origin.repository,
            pr: origin.pr,
            headRef: origin.headRef,
            baseRef: origin.baseRef,
            headSha: origin.headSha,
            baseSha: origin.baseSha,
            run: origin.run,
            attempt: origin.attempt,
            event: origin.event,
            workflow: origin.workflow,
        });

        const nextRun = new ReplayHistory(file, Object.assign({}, origin, { run: "101", attempt: "2" }));
        nextRun.recordTestDone({
            name: "case",
            parent: { name: "Suite", parent: { name: "ROOT" } },
            errors: [],
            status: "skip",
            failing: false,
        });
        expect(new ReplayHistory(file, origin, false).state.origins[id]).toEqual(captured);
        expect(new ReplayHistory(file, origin, false).priorityGroups()[1]).toContain(id);

        const failure = new ReplayHistory(file, Object.assign({}, origin, { run: "102" }), false);
        failure.recordFailure(id);
        expect(new ReplayHistory(file, origin, false).state.origins[id]).toEqual(captured);

        const pass = new ReplayHistory(file, Object.assign({}, origin, { run: "103" }), false);
        pass.recordTestDone({
            name: "case",
            parent: { name: "Suite", parent: { name: "ROOT" } },
            errors: [],
            status: "done",
            failing: false,
        });
        const resolved = new ReplayHistory(file, origin, false);
        expect(resolved.state.origins[id]).toBeUndefined();
        expect(resolved.priorityGroups()[0]).not.toContain(id);
        expect(resolved.priorityGroups()[1]).not.toContain(id);
        expect(resolved.priorityGroups()[2]).toContain(id);
    });

    it("orders failed, interrupted, and historically risky IDs before the full affected suite", () => {
        const file = path.join(directory, "history.json");
        const history = new ReplayHistory(file, context());
        history.addPending("Suite interrupted");
        history.recordFailure("Suite failure");
        history.state.failed = ["Suite failure"];
        history.state.pending = ["Suite interrupted", "Suite failure"];
        history.state.risk = {
            "Suite failure": 4,
            "Suite risk-high": 3,
            "Suite risk-low": 1,
        };
        history.checkpoint();

        const [failed, interrupted, risky] = new ReplayHistory(file, context(), false).priorityGroups();
        expect(failed).toEqual(["Suite failure"]);
        expect(interrupted).toEqual(["Suite interrupted"]);
        expect(risky).toEqual(["Suite risk-high", "Suite risk-low"]);

        const calls = [];
        const status = runPrioritizedSuites([failed, interrupted, risky], (ids) => {
            calls.push(...ids);
            return 0;
        }, () => {
            calls.push("canonical affected suite");
            return 0;
        });
        expect(status).toBe(0);
        expect(calls).toEqual([
            "Suite failure",
            "Suite interrupted",
            "Suite risk-high",
            "Suite risk-low",
            "canonical affected suite",
        ]);
    });

    it.each([
        ["previous", [["failed"], ["interrupted"], ["risky"]], ["replay:failed", "replay:interrupted"]],
        ["risk", [["failed"], ["interrupted"], ["risky"]], ["replay:risky"]],
    ])("runs only the %s phase and does not enter later work", (phase, groups, expected) => {
        const calls = [];
        const status = runReplayPhase(groups, phase, (ids) => {
            calls.push(`replay:${ids.join(",")}`);
            return 0;
        }, () => {
            calls.push("canonical");
            return 0;
        });

        expect(status).toBe(0);
        expect(calls).toEqual(expected);
    });

    it("does not start a later replay phase or canonical work after a phase failure", () => {
        const calls = [];
        const status = runReplayPhase([["failed"], ["interrupted"], ["risky"]], "previous", (ids) => {
            calls.push(`replay:${ids.join(",")}`);
            return 1;
        }, () => {
            calls.push("canonical");
            return 0;
        });

        expect(status).toBe(1);
        expect(calls).toEqual(["replay:failed"]);
    });

    it("fails closed before tests when an intermediate stage cache is missing", () => {
        expect(() => requirePriorStageCacheHit("true")).not.toThrow();
        expect(() => requirePriorStageCacheHit("false"))
            .toThrow("Required prior-stage replay history was not restored");
        expect(() => requirePriorStageCacheHit(undefined))
            .toThrow("Required prior-stage replay history was not restored");
    });

    it.each(["skipped", "pending", "todo", "missing"])(
        "does not accept a %s previous replay as resolution",
        (status) => {
            const id = "Suite previously failing case";
            const assertions = status === "missing" ? [] : [{ fullName: id, status }];
            const unresolved = verifyReplayResults({ testResults: [{ assertionResults: assertions }] }, [id]);
            expect(unresolved).toEqual([{ id, status: status === "missing" ? "missing" : status }]);
        }
    );

    it("accepts only passed assertions for every previous replay candidate", () => {
        const report = { testResults: [{ assertionResults: [
            { fullName: "Suite first", status: "passed" },
            { fullName: "Suite second", status: "passed" },
        ] }] };
        expect(verifyReplayResults(report, ["Suite first", "Suite second"])).toEqual([]);
    });

    it.each(["missing", "skipped", "pending"])(
        "stops before later replay groups and the canonical suite when an old ID is %s",
        (status) => {
            const calls = [];
            const oldId = "Suite old failure";
            const groups = [[oldId], ["Suite interrupted"]];
            const replay = (ids) => {
                calls.push(`replay:${ids[0]}`);
                if (ids[0] !== oldId) {
                    return 0;
                }
                const assertions = status === "missing" ? [] : [{ fullName: oldId, status }];
                return verifyReplayResults({ testResults: [{ assertionResults: assertions }] }, ids).length ? 1 : 0;
            };
            const canonical = () => {
                calls.push("canonical");
                return 0;
            };

            expect(runPrioritizedSuites(groups, replay, canonical)).toBe(1);
            expect(calls).toEqual([`replay:${oldId}`]);
        }
    );

    it("rejects malformed or cross-scope cached history", () => {
        const scope = context();
        const valid = {
            version: 2,
            scope: {
                repository: scope.repository,
                scopeKind: scope.scopeKind,
                scopeId: scope.scopeId,
                headRef: scope.headRef,
                baseRef: scope.baseRef,
                lane: scope.lane,
                os: scope.os,
                node: scope.node,
            },
            failed: [],
            pending: [],
            risk: {},
            contexts: [],
            origins: {},
            legacyImports: [],
        };
        expect(() => validateState(valid, scope)).not.toThrow();
        expect(() => validateState(Object.assign({}, valid, { failed: [17] }), scope)).toThrow("Invalid CI replay history");
        expect(() => validateState(valid, Object.assign({}, scope, { headRef: "another-branch" }))).toThrow("Invalid CI replay scope");
        expect(() => validateState(valid, Object.assign({}, scope, { branch: "another-branch" }))).toThrow("Invalid CI replay scope");
        expect(() => validateState(Object.assign({}, valid, { origins: { bad: { run: 5 } } }), scope))
            .toThrow("Invalid CI replay history");
        const oversized = Object.assign({}, valid, {
            origins: Object.fromEntries(Array.from({ length: 25001 }, (_, index) => [`test-${index}`, {}])),
        });
        expect(() => validateState(oversized, scope)).toThrow("Invalid CI replay history");
    });

    it("isolates history by PR identity and base/head ref scope", () => {
        const scope = context();
        expect(statePath(directory, scope)).not.toBe(statePath(directory, Object.assign({}, scope, { pr: "25", scopeId: "pr:25" })));
        expect(statePath(directory, scope)).not.toBe(statePath(directory, Object.assign({}, scope, { baseRef: "release" })));
        expect(statePath(directory, scope)).not.toBe(statePath(directory, Object.assign({}, scope, {
            branch: "other-head",
            headRef: "other-head",
        })));
        expect(statePath(directory, scope)).not.toBe(statePath(directory, Object.assign({}, scope, {
            pr: "",
            scopeKind: "branch",
            scopeId: "branch:ci-replay-test",
        })));
    });

    it("migrates v1 unresolved IDs with explicitly marked legacy provenance", () => {
        const scope = context();
        const file = path.join(directory, "legacy.json");
        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            scope: {
                repository: scope.repository,
                branch: scope.branch,
                pr: scope.pr,
                lane: scope.lane,
                os: scope.os,
                node: scope.node,
            },
            failed: ["Suite old failure"],
            pending: ["Suite interrupted"],
            risk: {},
            contexts: [{
                repository: scope.repository,
                branch: scope.branch,
                pr: scope.pr,
                sha: "old-sha",
                run: "old-run",
                attempt: "1",
                job: "auto-test",
            }],
        }));

        const migrated = new ReplayHistory(file, scope);
        migrated.checkpoint();
        expect(migrated.state.version).toBe(2);
        expect(migrated.state.failed).toContain("Suite old failure");
        expect(migrated.state.pending).toContain("Suite interrupted");
        expect(migrated.state.origins["Suite old failure"]).toMatchObject({
            run: "",
            headSha: "",
            headRef: scope.headRef,
            baseRef: "",
            legacy: true,
        });
        expect(migrated.state.contexts[0]).toMatchObject({ run: "old-run", headSha: "old-sha", legacy: true });
        expect(migrated.state.legacyImports).toEqual([]);
        expect(() => validateState(migrated.state, scope)).not.toThrow();
    });

    it("imports old replay IDs only for an exact repository, PR, and branch match", () => {
        const scope = context();
        const legacyDirectory = path.join(directory, "legacy-cache");
        const currentFile = path.join(directory, "current", "state.json");
        fs.mkdirSync(legacyDirectory);
        fs.writeFileSync(path.join(legacyDirectory, "a".repeat(32) + ".json"), JSON.stringify({
            version: 1,
            scope: {
                repository: scope.repository,
                branch: scope.branch,
                pr: scope.pr,
                lane: scope.lane,
                os: scope.os,
                node: scope.node,
            },
            failed: ["Suite old failure"],
            pending: ["Suite old interruption"],
            risk: { "Suite old failure": 3 },
            contexts: [{
                repository: scope.repository,
                branch: scope.branch,
                pr: scope.pr,
                sha: "old-sha",
                run: "old-run",
                attempt: "1",
                job: "auto-test",
            }],
        }));

        expect(importLegacyCache(legacyDirectory, currentFile, scope)).toBe(true);
        const migrated = new ReplayHistory(currentFile, scope, false);
        expect(migrated.state.legacyImports).toHaveLength(1);
        expect(migrated.state.failed).toContain("Suite old failure");
        expect(migrated.state.pending).toContain("Suite old interruption");
        expect(migrated.state.risk["Suite old failure"]).toBe(3);
        expect(migrated.state.origins["Suite old failure"]).toMatchObject({
            repository: scope.repository,
            pr: scope.pr,
            headRef: scope.headRef,
            baseRef: "",
            headSha: "",
            baseSha: "",
            run: "",
            legacy: true,
        });
        expect(migrated.state.contexts[0]).toMatchObject({ run: "old-run", sha: "old-sha", legacy: true });
        expect(() => validateState(migrated.state, scope)).not.toThrow();
        expect(importLegacyCache(legacyDirectory, currentFile, scope)).toBe(false);
        const passing = new ReplayHistory(currentFile, scope, false);
        passing.recordTestDone({
            name: "old failure",
            parent: { name: "Suite", parent: {} },
            status: "done",
            errors: [],
        });
        passing.checkpoint();
        expect(importLegacyCache(legacyDirectory, currentFile, scope)).toBe(false);
        expect(new ReplayHistory(currentFile, scope, false).priorityGroups()[0]).not.toContain("Suite old failure");
        expect(() => importLegacyCache(legacyDirectory, path.join(directory, "other.json"), Object.assign({}, scope, {
            pr: "25",
            scopeId: "pr:25",
        }))).toThrow("scope mismatch");
        const mismatchedContext = JSON.parse(fs.readFileSync(path.join(legacyDirectory, "a".repeat(32) + ".json"), "utf8"));
        mismatchedContext.contexts[0].pr = "25";
        fs.writeFileSync(path.join(legacyDirectory, "a".repeat(32) + ".json"), JSON.stringify(mismatchedContext));
        expect(() => importLegacyCache(legacyDirectory, path.join(directory, "mismatched.json"), scope))
            .toThrow("schema or scope mismatch");
    });

    it("stages legacy cache files from their original workspace path before v2 restore", () => {
        const source = path.join(directory, ".ci-test-replay");
        const destination = path.join(directory, ".ci-test-replay-legacy");
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, "b".repeat(32) + ".json"), "{}");

        expect(stageLegacyCache(source, destination)).toBe(true);
        expect(fs.readdirSync(source)).toEqual([]);
        expect(fs.readdirSync(destination)).toEqual(["b".repeat(32) + ".json"]);
        expect(stageLegacyCache(source, destination)).toBe(false);
    });

    it("reads bounded head/base and run provenance from GitHub environment", () => {
        const keys = ["GITHUB_REPOSITORY", "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_BASE_REF", "GITHUB_SHA", "GITHUB_BASE_SHA", "GITHUB_PR_NUMBER", "GITHUB_EVENT_NAME", "GITHUB_WORKFLOW", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_OS"];
        const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
        Object.assign(process.env, {
            GITHUB_REPOSITORY: "varunsharma/uptime-kuma",
            GITHUB_REF_NAME: "42/merge",
            GITHUB_HEAD_REF: "topic",
            GITHUB_BASE_REF: "master",
            GITHUB_SHA: "head-sha",
            GITHUB_BASE_SHA: "base-sha",
            GITHUB_PR_NUMBER: "42",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_WORKFLOW: "Auto Test",
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
            GITHUB_JOB: "auto-test",
            RUNNER_OS: "Linux",
        });
        try {
            expect(contextFromEnvironment()).toMatchObject({
                repository: "varunsharma/uptime-kuma",
                branch: "topic",
                headRef: "topic",
                baseRef: "master",
                headSha: "head-sha",
                baseSha: "base-sha",
                pr: "42",
                event: "pull_request",
                workflow: "Auto Test",
                run: "123",
                attempt: "2",
                job: "auto-test",
            });
        } finally {
            for (const key of keys) {
                if (old[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = old[key];
                }
            }
        }
    });

    it("rejects malformed scope values before deriving the cache key", () => {
        const keys = ["GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GITHUB_PR_NUMBER"];
        const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
        process.env.GITHUB_HEAD_REF = "topic\nunsafe";
        process.env.GITHUB_REF_NAME = "topic";
        process.env.GITHUB_PR_NUMBER = "24";
        try {
            expect(() => contextFromEnvironment()).toThrow("Invalid CI replay context value: ref");
        } finally {
            for (const key of keys) {
                if (old[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = old[key];
                }
            }
        }
    });
});
