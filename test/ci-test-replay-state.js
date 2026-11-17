"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDS = 25000;
const MAX_CONTEXTS = 12;
const MAX_ID_LENGTH = 2000;
const CONTEXT_KEYS = [
    "repository", "branch", "headRef", "baseRef", "pr", "lane", "os", "node",
    "sha", "headSha", "baseSha", "run", "attempt", "job", "event", "workflow",
];

function validIdList(value) {
    return Array.isArray(value) && value.length <= MAX_IDS
        && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH);
}

function stableScope(context) {
    validateScope(context);
    return {
        repository: context.repository,
        scopeKind: context.scopeKind,
        scopeId: context.scopeId,
        headRef: context.headRef,
        baseRef: context.baseRef,
        lane: context.lane,
        os: context.os,
        node: context.node,
    };
}

function validateScope(context) {
    const required = ["repository", "branch", "headRef", "baseRef", "pr", "scopeKind", "scopeId", "lane", "os", "node"];
    if (!context || typeof context !== "object" || Array.isArray(context)
        || required.some((key) => typeof context[key] !== "string" || context[key].length > 400 || /[\u0000-\u001f\u007f]/.test(context[key]))
        || !context.repository || !context.branch || !context.headRef || !context.lane || !context.os || !context.node
        || context.branch !== context.headRef
        || !["pr", "branch"].includes(context.scopeKind)
        || (context.scopeKind === "pr" && (!/^\d+$/.test(context.pr) || context.scopeId !== `pr:${context.pr}`))
        || (context.scopeKind === "branch" && (context.pr || context.scopeId !== `branch:${context.headRef}`))) {
        throw new Error("Invalid CI replay scope");
    }
}

function scopeDigest(context) {
    return crypto.createHash("sha256")
        .update(JSON.stringify(stableScope(context)))
        .digest("hex");
}

function legacyStableScope(context) {
    return {
        repository: context.repository,
        branch: context.branch,
        pr: context.pr,
        lane: context.lane,
        os: context.os,
        node: context.node,
    };
}

function statePath(directory, scope) {
    const digest = scopeDigest(scope).slice(0, 32);
    return path.join(directory, `${digest}.json`);
}

function validateState(value, scope) {
    if (!value || value.version !== 2 || JSON.stringify(value.scope) !== JSON.stringify(stableScope(scope))
        || !validIdList(value.failed) || !validIdList(value.pending)
        || !value.risk || typeof value.risk !== "object" || Array.isArray(value.risk)
        || Object.keys(value.risk).length > MAX_IDS
        || !Object.entries(value.risk).every(([id, count]) => validIdList([id])
            && Number.isInteger(count) && count >= 0 && count <= 1000000)
        || !Array.isArray(value.contexts) || value.contexts.length > MAX_CONTEXTS
        || !value.contexts.every(validContext)
        || !Array.isArray(value.legacyImports) || value.legacyImports.length > 64
        || !value.legacyImports.every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
        || !value.origins || typeof value.origins !== "object" || Array.isArray(value.origins)
        || Object.keys(value.origins).length > MAX_IDS
        || !Object.entries(value.origins).every(([id, origin]) => validIdList([id]) && validContext(origin))
        || !Object.keys(value.origins).every((id) => value.failed.includes(id) || value.pending.includes(id))
        || !unique(value.failed.concat(value.pending)).every((id) => Object.prototype.hasOwnProperty.call(value.origins, id))) {
        throw new Error("Invalid CI replay history: schema or scope mismatch");
    }
    return value;
}

function validContext(entry) {
    return Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
        && Object.keys(entry).every((key) => CONTEXT_KEYS.includes(key) || key === "legacy")
        && CONTEXT_KEYS.every((key) => typeof entry[key] === "string" && entry[key].length <= 400)
        && CONTEXT_KEYS.every((key) => !/[\u0000-\u001f\u007f]/.test(entry[key]))
        && typeof entry.legacy === "boolean");
}

function contextRecord(context, legacy = false) {
    const record = {};
    CONTEXT_KEYS.forEach((key) => {
        record[key] = String(context[key] || "").slice(0, 400);
    });
    record.legacy = legacy;
    return record;
}

function validateLegacyState(value, scope) {
    const oldScope = legacyStableScope(scope);
    if (!value || value.version !== 1 || JSON.stringify(value.scope) !== JSON.stringify(oldScope)
        || !validIdList(value.failed) || !validIdList(value.pending)
        || !value.risk || typeof value.risk !== "object" || Array.isArray(value.risk)
        || Object.keys(value.risk).length > MAX_IDS
        || !Object.entries(value.risk).every(([id, count]) => validIdList([id])
            && Number.isInteger(count) && count >= 0 && count <= 1000000)
        || !Array.isArray(value.contexts) || value.contexts.length > MAX_CONTEXTS
        || !value.contexts.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
            && Object.keys(entry).every((key) => ["pr", "sha", "run", "attempt", "job", "branch", "repository"].includes(key))
            && ["pr", "sha", "run", "attempt", "job", "branch", "repository"]
                .every((key) => typeof entry[key] === "string" && entry[key].length <= 400
                    && !/[\u0000-\u001f\u007f]/.test(entry[key]))
            && entry.repository === scope.repository && entry.branch === scope.branch && entry.pr === scope.pr)) {
        throw new Error("Invalid CI replay history: schema or scope mismatch");
    }
    return value;
}

function legacyOrigin(scope) {
    return contextRecord({
        repository: scope.repository,
        branch: scope.branch,
        headRef: scope.headRef,
        baseRef: "",
        pr: scope.pr,
        lane: scope.lane,
        os: scope.os,
        node: scope.node,
        sha: "",
        headSha: "",
        baseSha: "",
        run: "",
        attempt: "",
        job: "",
        event: "",
        workflow: "",
    }, true);
}

function migrateLegacyState(value, scope) {
    validateLegacyState(value, scope);
    const origins = {};
    for (const id of unique(value.failed.concat(value.pending))) {
        origins[id] = legacyOrigin(scope);
    }
    return {
        version: 2,
        scope: stableScope(scope),
        failed: unique(value.failed),
        pending: unique(value.pending).filter((id) => !value.failed.includes(id)),
        risk: Object.assign({}, value.risk),
        contexts: value.contexts.map((entry) => contextRecord({
            repository: entry.repository,
            branch: entry.branch,
            headRef: entry.branch,
            baseRef: "",
            pr: entry.pr,
            lane: scope.lane,
            os: scope.os,
            node: scope.node,
            sha: entry.sha,
            headSha: entry.sha,
            baseSha: "",
            run: entry.run,
            attempt: entry.attempt,
            job: entry.job,
            event: "",
            workflow: "",
        }, true)),
        origins,
        legacyImports: [],
    };
}

function importLegacyCache(directory, currentFile, scope) {
    if (!fs.existsSync(directory)) {
        return false;
    }
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) {
        throw new Error("Invalid legacy CI replay history directory");
    }
    const entries = fs.readdirSync(directory);
    if (entries.length > 64) {
        throw new Error("Legacy CI replay history has too many files");
    }
    const candidates = entries.filter((entry) => /^[a-f0-9]{32}\.json$/.test(entry));
    if (entries.length === 0) {
        return false;
    }
    if (entries.length !== 1 || candidates.length !== 1) {
        throw new Error("Legacy CI replay history is ambiguous");
    }
    const legacyFile = path.join(directory, candidates[0]);
    if (fs.lstatSync(legacyFile).isSymbolicLink() || !fs.statSync(legacyFile).isFile()
        || fs.statSync(legacyFile).size > MAX_BYTES) {
        throw new Error("Invalid legacy CI replay history file");
    }
    const legacyBytes = fs.readFileSync(legacyFile);
    const sourceDigest = crypto.createHash("sha256").update(legacyBytes).digest("hex");
    const legacyState = JSON.parse(legacyBytes.toString("utf8"));
    validateLegacyState(legacyState, scope);

    const history = new ReplayHistory(currentFile, scope, false);
    if (history.state.legacyImports.includes(sourceDigest)) {
        return false;
    }
    const imported = migrateLegacyState(legacyState, scope);
    if (fs.existsSync(currentFile)) {
        history.state.failed = unique(history.state.failed.concat(imported.failed));
        history.state.pending = unique(history.state.pending.concat(imported.pending))
            .filter((id) => !history.state.failed.includes(id));
        Object.entries(imported.risk).forEach(([id, count]) => {
            history.state.risk[id] = Math.max(history.state.risk[id] || 0, count);
        });
        history.state.contexts = history.state.contexts.concat(imported.contexts).slice(-MAX_CONTEXTS);
        history.state.legacyImports = unique(history.state.legacyImports.concat([sourceDigest])).slice(-64);
    } else {
        history.state = imported;
        history.state.legacyImports = [sourceDigest];
    }
    unique(history.state.failed.concat(history.state.pending)).forEach((id) => {
        if (!history.state.origins[id]) {
            history.state.origins[id] = legacyOrigin(scope);
        }
    });
    history.checkpoint();
    return true;
}

function stageLegacyCache(sourceDirectory, destinationDirectory) {
    const source = path.resolve(sourceDirectory);
    const destination = path.resolve(destinationDirectory);
    if (source === destination) {
        throw new Error("Invalid legacy CI replay staging paths");
    }
    if (!fs.existsSync(source)) {
        return false;
    }
    if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isDirectory()) {
        throw new Error("Invalid legacy CI replay history directory");
    }
    const entries = fs.readdirSync(source);
    if (entries.length > 64 || !entries.every((entry) => /^[a-f0-9]{32}\.json$/.test(entry))) {
        throw new Error("Legacy CI replay history has unexpected files");
    }
    if (entries.length === 0) {
        return false;
    }
    if (fs.existsSync(destination)) {
        if (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isDirectory()
            || fs.readdirSync(destination).length !== 0) {
            throw new Error("Legacy CI replay staging directory is not empty");
        }
    } else {
        fs.mkdirSync(destination, { recursive: true });
    }
    for (const entry of entries) {
        const sourceFile = path.join(source, entry);
        if (fs.lstatSync(sourceFile).isSymbolicLink() || !fs.statSync(sourceFile).isFile()) {
            throw new Error("Invalid legacy CI replay history file");
        }
    }
    entries.forEach((entry) => fs.renameSync(path.join(source, entry), path.join(destination, entry)));
    return true;
}

function unique(values) {
    return Array.from(new Set(values));
}

function testId(test) {
    const names = [test.name];
    let parent = test.parent;
    while (parent && parent.parent) {
        names.unshift(parent.name);
        parent = parent.parent;
    }
    return names.filter((name) => typeof name === "string" && name.length > 0).join(" ");
}

class ReplayHistory {
    constructor(file, context, recordContext = true) {
        this.file = file;
        this.context = context;
        this.failedThisRun = new Set();
        if (fs.existsSync(file)) {
            if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > MAX_BYTES) {
                throw new Error("Invalid CI replay history: symlink or oversized file");
            }
            const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
            this.state = loaded && loaded.version === 1
                ? migrateLegacyState(loaded, context)
                : validateState(loaded, context);
        } else {
            this.state = {
                version: 2,
                scope: stableScope(context),
                failed: [],
                pending: [],
                risk: {},
                contexts: [],
                origins: {},
                legacyImports: [],
            };
        }
        if (recordContext) {
            this.state.contexts = (this.state.contexts.concat([contextRecord(context)])).slice(-MAX_CONTEXTS);
        }
    }

    checkpoint() {
        if (this.state.failed.length > MAX_IDS || this.state.pending.length > MAX_IDS
            || Object.keys(this.state.risk).length > MAX_IDS || Object.keys(this.state.origins).length > MAX_IDS) {
            throw new Error("CI replay history exceeds supported test count");
        }
        const directory = path.dirname(this.file);
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
            throw new Error("Invalid CI replay history directory: symbolic link");
        }
        fs.mkdirSync(directory, { recursive: true });
        const payload = Buffer.from(JSON.stringify(this.state));
        if (payload.length > MAX_BYTES) {
            throw new Error("CI replay history exceeds supported byte count");
        }
        const temporary = path.join(directory, `.checkpoint-${process.pid}-${Date.now()}`);
        try {
            const descriptor = fs.openSync(temporary, "wx", 0o600);
            try {
                fs.writeSync(descriptor, payload);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporary, this.file);
        } finally {
            if (fs.existsSync(temporary)) {
                fs.unlinkSync(temporary);
            }
        }
    }

    addPending(id) {
        if (!validIdList([id])) {
            throw new Error("Invalid CI test identifier");
        }
        if (!this.state.pending.includes(id)) {
            this.state.pending.push(id);
        }
        if (!this.state.origins[id]) {
            this.state.origins[id] = contextRecord(this.context);
        }
        this.checkpoint();
    }

    removePending(id) {
        this.state.pending = this.state.pending.filter((pending) => pending !== id);
        if (!this.state.failed.includes(id)) {
            delete this.state.origins[id];
        }
        this.checkpoint();
    }

    recordFailure(id) {
        if (!validIdList([id])) {
            return;
        }
        if (!this.failedThisRun.has(id)) {
            this.state.risk[id] = Math.min(1000000, (this.state.risk[id] || 0) + 1);
            this.failedThisRun.add(id);
        }
        this.state.pending = this.state.pending.filter((pending) => pending !== id);
        if (!this.state.failed.includes(id)) {
            this.state.failed.push(id);
        }
        if (!this.state.origins[id]) {
            this.state.origins[id] = contextRecord(this.context);
        }
        this.checkpoint();
    }

    recordTestDone(test) {
        const id = testId(test);
        if (!id) {
            return;
        }
        if (test.errors && test.errors.length > 0) {
            this.recordFailure(id);
            return;
        }
        if (test.status === "done" && !test.failing) {
            this.state.pending = this.state.pending.filter((pending) => pending !== id);
            this.state.failed = this.state.failed.filter((failed) => failed !== id);
            delete this.state.origins[id];
        }
        this.checkpoint();
    }

    priorityGroups() {
        const failed = unique(this.state.failed);
        const failedSet = new Set(failed);
        const pending = unique(this.state.pending).filter((id) => !failedSet.has(id));
        const unresolved = new Set(failed.concat(pending));
        const risky = Object.entries(this.state.risk)
            .filter(([id, count]) => count > 0 && !unresolved.has(id))
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([id]) => id);
        return [failed, pending, risky];
    }
}

module.exports = { ReplayHistory, importLegacyCache, scopeDigest, stageLegacyCache, statePath, stableScope, testId, validateState };
