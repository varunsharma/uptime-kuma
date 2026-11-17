"use strict";

const NodeEnvironment = require("jest-environment-jsdom");
const { ReplayHistory, testId } = require("./ci-test-replay-state");

function findRoot(block) {
    while (block && block.parent) {
        block = block.parent;
    }
    return block;
}

function visitTests(block, callback) {
    for (const child of block.children || []) {
        if (child.type === "test") {
            callback(child);
        } else if (child.type === "describeBlock") {
            visitTests(child, callback);
        }
    }
}

function hasStartedTest(block) {
    return (block.children || []).some((child) => child.type === "test"
        ? child.startedAt != null || child.status === "done"
        : child.type === "describeBlock" && hasStartedTest(child));
}

function protectedBlocks(current, failedBlock) {
    const protectedSet = new Set();
    let block = current ? current.parent : failedBlock;
    while (block) {
        protectedSet.add(block);
        block = block.parent;
    }
    return protectedSet;
}

function stopUnstartedTests(root, current, failedBlock, startedBlocks = new Set()) {
    const protectedSet = protectedBlocks(current, failedBlock);
    for (const block of startedBlocks) {
        protectedSet.add(block);
    }
    function visit(block) {
        for (const child of block.children || []) {
            if (child.type === "test") {
                if (child !== current && child.status == null && child.startedAt == null) {
                    child.mode = "skip";
                }
            } else if (child.type === "describeBlock") {
                visit(child);
                if (!protectedSet.has(child) && !hasStartedTest(child)) {
                    child.mode = "skip";
                }
            }
        }
    }
    visit(root);
}

function blockTests(block) {
    const tests = [];
    visitTests(block, (test) => tests.push(test));
    return tests;
}

function pendingIdForEvent(event, state) {
    if (!event || event.name !== "add_test" || typeof event.testName !== "string"
        || !state || !state.currentDescribeBlock) {
        throw new Error("Invalid Jest add_test event");
    }
    return testId({ name: event.testName, parent: state.currentDescribeBlock });
}

function clearNewSkippedTest(history, id, unresolvedAtStart) {
    if (!unresolvedAtStart.has(id) && !history.state.failed.includes(id)) {
        history.removePending(id);
    }
}

class StopOnFailureEnvironment extends NodeEnvironment {
    constructor(config, context) {
        super(config, context);
        const stateFile = process.env.CI_TEST_REPLAY_STATE;
        const rawContext = process.env.CI_TEST_REPLAY_CONTEXT;
        if (!stateFile || !rawContext) {
            throw new Error("CI replay state was not initialized before Jest started");
        }
        const parsedContext = JSON.parse(rawContext);
        this.history = new ReplayHistory(stateFile, parsedContext, false);
        this.unresolvedAtStart = new Set(this.history.state.failed.concat(this.history.state.pending));
        this.halted = false;
        this.startedBlocks = new Set();
    }

    handleTestEvent(event, state) {
        if (event.name === "run_describe_start") {
            this.startedBlocks.add(event.describeBlock);
            return;
        }
        if (event.name === "add_test") {
            this.history.addPending(pendingIdForEvent(event, state));
            return;
        }

        if (event.name === "test_fn_failure" || event.name === "hook_failure") {
            this.halted = true;
            const current = event.test;
            if (current) {
                this.history.recordFailure(testId(current));
            } else if (event.describeBlock) {
                // A beforeAll/afterAll failure belongs to the affected block.
                // Preserve concrete case IDs so a later invocation can retry them.
                for (const test of blockTests(event.describeBlock)) {
                    this.history.recordFailure(testId(test));
                }
            }
            stopUnstartedTests(findRoot(current ? current.parent : event.describeBlock), current, event.describeBlock, this.startedBlocks);
            return;
        }

        if (event.name === "test_done") {
            this.history.recordTestDone(event.test);
        } else if ((event.name === "test_skip" || event.name === "test_todo")
            && !this.halted && (event.test.mode === "skip" || event.test.mode === "todo")) {
            clearNewSkippedTest(this.history, testId(event.test), this.unresolvedAtStart);
        }
    }
}

module.exports = StopOnFailureEnvironment;
module.exports.clearNewSkippedTest = clearNewSkippedTest;
module.exports.pendingIdForEvent = pendingIdForEvent;
module.exports.stopUnstartedTests = stopUnstartedTests;
