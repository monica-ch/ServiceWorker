const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const element = {addEventListener() {}, replaceChildren() {}};
const context = vm.createContext({
  document: {querySelector: () => element}, window: {},
  navigator: {userAgent: "unit test", serviceWorker: {getRegistrations: async () => []}},
  isSecureContext: true, setTimeout, clearTimeout
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "probe.js"), "utf8"), context);
const summarize = vm.runInContext("summarize", context);
const record = {
  workerObservations: ["before", "written", "after"].map(phase => ({
    phase, clientId: "client-a", clientURL: "https://example.test/owner"
  })),
  controllerEvents: [{isTrusted: false, stage: "before"}, {isTrusted: false, stage: "after"}]
};
let summary = summarize(record);
assert.equal(summary.clientIdentity, "same-clientId");
assert.equal(summary.writtenScriptFetchEvents, 1);
assert.equal(summary.ordinaryFetchEventsAfter, 1);
assert.equal(summary.controllerchangeEvents, 0);
assert.equal(summary.listenerControlBefore, 1);
assert.equal(summary.listenerControlAfter, 1);
record.workerObservations[1].clientId = "client-b";
assert.equal(summarize(record).clientIdentity, "different-clientId");
record.workerObservations.forEach(o => { o.clientId = ""; });
assert.equal(summarize(record).clientIdentity, "not-established");
record.workerObservations = record.workerObservations.filter(o => o.phase !== "written");
summary = summarize(record);
assert.equal(summary.writtenScriptFetchEvents, 0);
assert.equal(summary.clientIdentity, "not-established");
record.controllerEvents.push({isTrusted: true, stage: null});
assert.equal(summarize(record).controllerchangeEvents, 1);
console.log("Identity, interception and controllerchange bookkeeping checks passed");
