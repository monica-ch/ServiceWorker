const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "resources", "probe.js"), "utf8"), context);
const progress = loaded => ({type: "progress", loaded, total: 10, lengthComputable: true});
function check(events, serverBytes = 10, digest = "digest") {
  return context.uploadProgressChecks({
    payloadBytes: 10, payloadSHA256: "digest",
    server: {serverBytesRead: serverBytes, sha256: digest}, uploadEvents: events
  });
}
const end = [{type: "load"}, {type: "loadend"}];
assert(Object.values(check([progress(10), ...end])).every(Boolean));
assert(Object.values(check([progress(3), progress(10), ...end])).every(Boolean));
assert.equal(check([progress(5), progress(4), progress(10), ...end])["Progress loaded is nondecreasing"], false);
assert.equal(check([progress(11), ...end])["Progress length is computable and loaded <= total"], false);
assert.equal(check([progress(9), ...end])["Final progress equals body length"], false);
assert.equal(check([progress(10), {type: "loadend"}, {type: "load"}])["Upload loadend follows load"], false);
assert.equal(check([{type: "loadstart"}])["At least one upload progress event"], false);
assert.equal(check([progress(10), ...end, {type: "error"}])["No upload error, abort or timeout"], false);
assert.equal(check([progress(10), ...end], 9)["Server received exact complete body"], false);
assert.equal(check([progress(10), ...end], 10, "wrong")["Server received exact complete body"], false);
console.log("Upload progress-check regression cases passed.");
