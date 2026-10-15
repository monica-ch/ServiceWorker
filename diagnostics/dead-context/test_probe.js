const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const element = {addEventListener() {}, replaceChildren() {}};
const context = vm.createContext({
  document: {querySelector: () => element},
  window: {}, navigator: {userAgent: "unit test", serviceWorker: {getRegistrations: async () => []}},
  isSecureContext: true, performance, setTimeout, clearTimeout, URL, URLSearchParams,
  location: {search: ""}
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "probe.js"), "utf8"), context);

(async () => {
  const fulfilled = vm.runInContext('observe(Promise.resolve("ok"), "fulfilled")', context);
  const rejected = vm.runInContext('observe(Promise.reject(new TypeError("example")), "rejected")', context);
  const pending = vm.runInContext('observe(new Promise(() => {}), "unobserved")', context);
  const nonPromise = vm.runInContext('observe(undefined, "non-promise")', context);
  const thrown = vm.runInContext('invoke({register() {throw new TypeError("sync");}}, "register", "", "")', context);
  await new Promise(resolve => setImmediate(resolve));
  for (const strategy of ["parent-native-then", "returned-promise-then"]) {
    assert.equal(fulfilled.observers[strategy].state, "fulfilled");
    assert.equal(rejected.observers[strategy].state, "rejected");
    assert.equal(rejected.observers[strategy].error.name, "TypeError");
    assert.equal(pending.observers[strategy].state, "not-observed-within-bound");
    assert.equal(nonPromise.observers[strategy].state, "observer-attachment-threw");
  }
  assert.equal(fulfilled.nativePromiseBrandAccepted, true);
  assert.equal(nonPromise.returnedSynchronously, true);
  assert.equal(nonPromise.returnType, "undefined");
  assert.equal(nonPromise.nativePromiseBrandAccepted, false);
  assert.equal(thrown.returnedSynchronously, false);
  assert.equal(thrown.synchronousThrow.name, "TypeError");
  console.log("Promise observation regression checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
