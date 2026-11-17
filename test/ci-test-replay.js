"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ReplayHistory, importLegacyCache, scopeDigest, stageLegacyCache, statePath } = require("./ci-test-replay-state");

function boundedValue(name, value, fallback = "", maxLength = 400) {
    const result = value == null || value === "" ? fallback : String(value);
    if (result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new Error(`Invalid CI replay context value: ${name}`);
    }
    return result;
}

function gitValue(args) {
    try {
        return childProcess.execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (error) {
        return "";
    }
}

function repositoryName() {
    if (process.env.GITHUB_REPOSITORY) {
        return process.env.GITHUB_REPOSITORY;
    }
    const remote = gitValue(["config", "--get", "remote.origin.url"]);
    const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/i);
    return match ? match[1] : "local/unknown";
}

function contextFromEnvironment() {
    const ref = boundedValue("ref", process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME
        || gitValue(["rev-parse", "--abbrev-ref", "HEAD"]), "local");
    const pr = boundedValue("pr", process.env.GITHUB_PR_NUMBER);
    if (pr && !/^\d+$/.test(pr)) {
        throw new Error("Invalid CI replay context value: pr");
    }
    const headRef = boundedValue("headRef", process.env.GITHUB_HEAD_REF, ref);
    const baseRef = boundedValue("baseRef", process.env.GITHUB_BASE_REF);
    const headSha = boundedValue("headSha", process.env.GITHUB_HEAD_SHA || process.env.GITHUB_SHA
        || gitValue(["rev-parse", "HEAD"]), "local");
    const baseSha = boundedValue("baseSha", process.env.GITHUB_BASE_SHA);
    const node = boundedValue("node", process.env.CI_TEST_REPLAY_NODE, process.versions.node.split(".")[0], 100);
    const event = boundedValue("event", process.env.GITHUB_EVENT_NAME, "local", 100);
    const workflow = boundedValue("workflow", process.env.GITHUB_WORKFLOW, "local");
    return {
        repository: boundedValue("repository", repositoryName()),
        branch: ref,
        headRef,
        baseRef,
        headSha,
        baseSha,
        pr,
        scopeKind: pr ? "pr" : "branch",
        scopeId: pr ? `pr:${pr}` : `branch:${headRef}`,
        event,
        workflow,
        lane: "backend",
        os: boundedValue("os", process.env.RUNNER_OS, os.platform(), 100),
        node,
        sha: boundedValue("sha", process.env.GITHUB_SHA || headSha),
        run: boundedValue("run", process.env.GITHUB_RUN_ID, "local"),
        attempt: boundedValue("attempt", process.env.GITHUB_RUN_ATTEMPT, "1"),
        job: boundedValue("job", process.env.GITHUB_JOB, "local"),
    };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternFor(ids) {
    return `^(?:${ids.map(escapeRegExp).join("|")})$`;
}

function jestArguments(pattern, outputFile) {
    const args = [
        "--runInBand",
        "--detectOpenHandles",
        "--forceExit",
        "--bail=1",
        "--config=./config/jest-backend.config.js",
        `--testEnvironment=${path.join(__dirname, "ci-test-stop-environment.js")}`,
        "--json",
        `--outputFile=${outputFile}`,
    ];
    if (pattern) {
        args.push(`--testNamePattern=${pattern}`);
    }
    return args;
}

function verifyReplayResults(report, expectedIds) {
    const actual = new Map();
    for (const file of report.testResults || []) {
        for (const assertion of file.assertionResults || []) {
            actual.set(assertion.fullName, assertion.status);
        }
    }
    return expectedIds.filter((id) => actual.get(id) !== "passed").map((id) => ({
        id,
        status: actual.get(id) || "missing",
    }));
}

function runPrioritizedSuites(groups, runSubset, runFullSuite) {
    for (const ids of groups) {
        if (!ids.length) {
            continue;
        }
        const status = runSubset(ids);
        if (status !== 0) {
            return status;
        }
    }
    return runFullSuite();
}

function runReplayPhase(groups, phase, runSubset, runFullSuite) {
    if (phase === "previous") {
        for (const previous of groups.slice(0, 2)) {
            if (!previous.length) {
                continue;
            }
            const status = runSubset(previous);
            if (status !== 0) {
                return status;
            }
        }
        return 0;
    }
    if (phase === "risk") {
        const risky = groups[2] || [];
        if (risky.length) {
            const status = runSubset(risky);
            if (status !== 0) {
                return status;
            }
        }
        return 0;
    }
    if (phase === "canonical") {
        return runFullSuite();
    }
    if (phase === "all") {
        return runPrioritizedSuites(groups, runSubset, runFullSuite);
    }
    throw new Error(`Invalid CI replay phase: ${phase}`);
}

function requirePriorStageCacheHit(value) {
    if (value !== "true") {
        throw new Error("Required prior-stage replay history was not restored; refusing to run tests without it");
    }
}

function runJest(pattern, expectedIds, context, stateFile) {
    const outputFile = path.join(os.tmpdir(), `uptime-kuma-jest-${process.pid}-${Date.now()}.json`);
    const env = Object.assign({}, process.env, {
        TEST_BACKEND: "1",
        CI_TEST_REPLAY_STATE: stateFile,
        CI_TEST_REPLAY_CONTEXT: JSON.stringify(context),
    });
    try {
        const jestPath = require.resolve("jest/bin/jest");
        const result = childProcess.spawnSync(process.execPath, [jestPath].concat(jestArguments(pattern, outputFile)), {
            stdio: "inherit",
            env,
        });
        if (result.error) {
            throw result.error;
        }
        const status = result.status == null ? 1 : result.status;
        if (status !== 0 || !expectedIds || expectedIds.length === 0) {
            return status;
        }
        if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size > 8 * 1024 * 1024) {
            throw new Error("Jest did not produce a bounded JSON result for replay verification");
        }
        const report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const unresolved = verifyReplayResults(report, expectedIds);
        if (unresolved.length) {
            const summary = {};
            for (const { status: replayStatus } of unresolved) {
                summary[replayStatus] = (summary[replayStatus] || 0) + 1;
            }
            process.stderr.write(`CI replay stopped: ${unresolved.length} prior test ID(s) did not pass (${JSON.stringify(summary)}).\n`);
            return 1;
        }
        return status;
    } finally {
        if (fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
        }
    }
}

function main() {
    const context = contextFromEnvironment();
    if (!context.repository || !context.branch || !context.os || !context.node) {
        throw new Error("CI replay scope is missing required repository, ref, OS, or Node data");
    }
    const directory = path.resolve(process.env.CI_TEST_REPLAY_DIR || ".ci-test-replay");
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error("Invalid CI replay history directory: symbolic link");
    }
    const stateFile = statePath(directory, context);
    const history = new ReplayHistory(stateFile, context);
    history.checkpoint(); // Fail closed before any test starts if history cannot be checkpointed.

    const replayGroups = [];
    const groupNames = ["previous failures", "interrupted tests", "historically risky tests"];
    for (const [index, groupName] of groupNames.entries()) {
        const current = new ReplayHistory(stateFile, context, false);
        const priority = current.priorityGroups();
        const ids = priority[index];
        replayGroups.push({
            name: groupName,
            ids,
        });
    }
    const groups = replayGroups.map((group) => group.ids);
    const phase = process.env.CI_TEST_REPLAY_PHASE || "all";
    return runReplayPhase(groups, phase, (ids) => {
        const group = replayGroups.find((candidate) => candidate.ids === ids);
        const groupName = group ? group.name : phase === "previous" ? "previous failures and interruptions" : "historically risky tests";
        process.stdout.write(`Replaying ${ids.length} ${groupName} before the full affected backend suite.\n`);
        return runJest(patternFor(ids), ids, context, stateFile);
    }, () => {
        process.stdout.write("Running the complete backend test suite.\n");
        return runJest(null, null, context, stateFile);
    });
}

if (require.main === module) {
    try {
        if (process.argv[2] === "--scope-key") {
            const key = scopeDigest(contextFromEnvironment()).slice(0, 32);
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`, { encoding: "utf8", mode: 0o600 });
            } else {
                process.stdout.write(`${key}\n`);
            }
        } else if (process.argv[2] === "--import-legacy") {
            const context = contextFromEnvironment();
            const legacyDirectory = path.resolve(process.env.CI_TEST_REPLAY_LEGACY_DIR || ".ci-test-replay-legacy");
            const currentFile = statePath(path.resolve(process.env.CI_TEST_REPLAY_DIR || ".ci-test-replay"), context);
            const imported = importLegacyCache(legacyDirectory, currentFile, context);
            process.stdout.write(imported
                ? "Imported legacy replay IDs with unknown base/per-test provenance.\n"
                : "No legacy replay cache to import.\n");
        } else if (process.argv[2] === "--stage-legacy") {
            const source = path.resolve(process.env.CI_TEST_REPLAY_DIR || ".ci-test-replay");
            const destination = path.resolve(process.env.CI_TEST_REPLAY_LEGACY_DIR || ".ci-test-replay-legacy");
            const staged = stageLegacyCache(source, destination);
            process.stdout.write(staged ? "Staged legacy replay cache.\n" : "No legacy replay cache to stage.\n");
        } else if (process.argv[2] === "--assert-cache-hit") {
            requirePriorStageCacheHit(process.env.CI_TEST_REPLAY_CACHE_HIT);
        } else {
            process.exitCode = main();
        }
    } catch (error) {
        process.stderr.write(`CI test replay stopped before tests: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    contextFromEnvironment,
    escapeRegExp,
    jestArguments,
    patternFor,
    runPrioritizedSuites,
    runReplayPhase,
    requirePriorStageCacheHit,
    scopeDigest,
    statePath,
    verifyReplayResults,
};
