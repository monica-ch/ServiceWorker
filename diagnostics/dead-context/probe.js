"use strict";

const OBSERVATION_MS = 5000;
const REGISTER_ONLY = new URLSearchParams(location.search).has("registerOnly");
const SCENARIOS = ["iframe", "popup"].flatMap(kind =>
  ["live", "immediate", "delayed"].map(lifecycle => ({kind, lifecycle})));
const nativeThen = Promise.prototype.then;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextButton = document.querySelector("#next");
const downloadButton = document.querySelector("#download");
const statusElement = document.querySelector("#status");
const report = {
  issue: "w3c/ServiceWorker#777", kind: "Observation only, not normative WPT",
  userAgent: navigator.userAgent, started: new Date().toISOString(),
  observationMs: OBSERVATION_MS, delayedInvocationMs: 100,
  mode: REGISTER_ONLY ? "Unseeded, isolated register()" : "Seeded, all methods and first ready access",
  invocation: "Methods looked up on the retained container after lifecycle action",
  observers: "Both callbacks execute in live parent; use parent native then and returnedPromise.then",
  cases: [], errors: [], complete: false, running: false
};
window.__tpacResult = report;

function describeError(error) {
  return {name: error?.name ?? null, message: error?.message ?? String(error)};
}
function describeValue(value) {
  if (value === undefined) return {kind: "undefined"};
  if (Array.isArray(value)) return {kind: "array", scopes: value.map(item => item.scope)};
  if (typeof value === "object" && value !== null && "scope" in value) {
    return {kind: "registration", scope: value.scope};
  }
  return {kind: typeof value, value: String(value)};
}
function observe(value, method) {
  const row = {method, returnedSynchronously: true, returnType: typeof value, observers: {}};
  for (const strategy of ["parent-native-then", "returned-promise-then"]) {
    const observation = {state: "not-observed-within-bound"};
    row.observers[strategy] = observation;
    try {
      const then = strategy === "parent-native-then" ? nativeThen : value.then;
      Reflect.apply(then, value, [
        result => {
          observation.state = "fulfilled";
          observation.callbackObservedAt = performance.now();
          try { observation.value = describeValue(result); }
          catch (error) { observation.valueInspectionError = describeError(error); }
        },
        error => {
          observation.state = "rejected";
          observation.callbackObservedAt = performance.now();
          observation.error = describeError(error);
        }
      ]);
      if (strategy === "parent-native-then") row.nativePromiseBrandAccepted = true;
    } catch (error) {
      observation.state = "observer-attachment-threw";
      observation.error = describeError(error);
      if (strategy === "parent-native-then") row.nativePromiseBrandAccepted = false;
    }
  }
  return row;
}
function invoke(container, method, scriptURL, scope) {
  try {
    let value;
    if (method === "ready") value = container.ready;
    else if (method === "register") value = container.register(scriptURL, {scope});
    else value = container[method]();
    return observe(value, method);
  } catch (error) {
    return {method, returnedSynchronously: false, synchronousThrow: describeError(error)};
  }
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function activate(registration) {
  const deadline = performance.now() + 8000;
  while (registration.active?.state !== "activated") {
    if (performance.now() > deadline) throw new Error("Seed worker activation timed out");
    await delay(25);
  }
}
async function matchingRegistrations(scopes) {
  const registrations = await bounded(navigator.serviceWorker.getRegistrations(), "Parent registration query");
  return registrations.filter(registration => scopes.includes(registration.scope));
}
function render() {
  document.querySelector("#output").textContent = JSON.stringify(report, null, 2);
  const table = document.createElement("table");
  const header = table.insertRow();
  for (const title of ["Context", "Method / canary", "Synchronous result", "Parent callback", "New registration observed"]) {
    const th = document.createElement("th");
    th.textContent = title;
    header.append(th);
  }
  for (const record of report.cases) {
    for (const row of record.methods || []) {
      const observation = row.observers?.["parent-native-then"];
      const tr = table.insertRow();
      for (const value of [
        `${record.kind}/${record.lifecycle}`, row.method,
        row.synchronousThrow ? `throws ${row.synchronousThrow.name}` :
          row.nativePromiseBrandAccepted ? "Promise returned" : row.returnType,
        row.returnType === "undefined" ? "not applicable (undefined returned)" :
          observation ? observation.state + (observation.error ? ` (${observation.error.name})` : "") : "not applicable",
        row.method === "register" ? record.checkpoints?.some(c => c.attemptPresent) ?? "unknown" : "-"
      ]) tr.insertCell().textContent = value;
    }
  }
  document.querySelector("#summary").replaceChildren(table);
}
async function runScenario(scenario, popup) {
  const record = {...scenario, methods: [], canaries: [], checkpoints: [], errors: []};
  report.cases.push(record);
  const token = crypto.randomUUID();
  const seedScope = new URL(`case-${token}/`, location.href).href;
  const attemptScope = new URL(`attempt-${token}/`, location.href).href;
  const scriptURL = new URL("worker.js", location.href).href;
  const ownerURL = new URL(`owner.html?token=${token}`, seedScope);
  record.seedScope = seedScope;
  record.attemptScope = attemptScope;
  let frame, owner, listener, loadTimer;
  const cleanupErrors = [];
  try {
    if (scenario.kind === "popup" && !popup) throw new Error("Popup blocked; allow popups and rerun in a fresh profile");
    if (!REGISTER_ONLY) {
      const seed = await bounded(navigator.serviceWorker.register(scriptURL, {scope: seedScope}), "Seed registration");
      await activate(seed);
    }
    if (scenario.kind === "iframe") {
      frame = document.createElement("iframe");
      owner = null;
    } else {
      owner = popup;
    }
    const loaded = new Promise((resolve, reject) => {
      listener = event => {
        if (event.origin === location.origin && event.source === owner &&
            event.data?.type === "dead-context-owner-ready" && event.data.token === token) resolve();
      };
      window.addEventListener("message", listener);
      loadTimer = setTimeout(() => reject(new Error("Loaded owner handshake timed out")), 8000);
    });
    if (frame) {
      frame.src = ownerURL.href;
      document.querySelector("#frames").append(frame);
      owner = frame.contentWindow;
    } else {
      owner.location = ownerURL.href;
    }
    await loaded;
    clearTimeout(loadTimer);
    window.removeEventListener("message", listener);
    const container = owner.navigator.serviceWorker;
    record.ownerURL = owner.location.href;
    record.controlledBefore = container.controller?.scriptURL === scriptURL;
    if (record.controlledBefore === REGISTER_ONLY) throw new Error("Owner control state does not match fixture mode");
    // These canaries distinguish API settlement from dead-realm reaction delivery.
    const alreadyFulfilled = owner.Promise.resolve("fulfilled-before-lifecycle-action");
    let fulfillAfter;
    const fulfilledAfter = new owner.Promise(resolve => { fulfillAfter = resolve; });
    record.lifecycleActionAt = performance.now();
    if (scenario.lifecycle !== "live") {
      if (frame) frame.remove();
      else popup.close();
      record.removalConfirmed = frame ? !frame.isConnected : popup.closed;
      if (!record.removalConfirmed) throw new Error("Owner removal/closure not confirmed");
    }
    if (scenario.lifecycle === "delayed") await delay(100);
    record.invokedAt = performance.now();
    record.actualDelayMs = record.invokedAt - record.lifecycleActionAt;
    // No await between removal (immediate case) and any of the four API calls.
    for (const method of REGISTER_ONLY ? ["register"] : ["getRegistration", "getRegistrations", "ready", "register"]) {
      const invocationOffsetMs = performance.now() - record.lifecycleActionAt;
      record.methods.push({...invoke(container, method, scriptURL, attemptScope), invocationOffsetMs});
    }
    record.canaries.push(observe(alreadyFulfilled, "promise-fulfilled-before-action"));
    record.canaries.push(observe(fulfilledAfter, "promise-resolved-from-parent-after-action"));
    fulfillAfter("fulfilled-after-lifecycle-action");
    async function checkpoint(label) {
      const registrations = await matchingRegistrations([seedScope, attemptScope]);
      record.checkpoints.push({
        label, elapsedMs: performance.now() - record.invokedAt,
        seedPresent: registrations.some(reg => reg.scope === seedScope),
        attemptPresent: registrations.some(reg => reg.scope === attemptScope)
      });
    }
    await checkpoint("first-parent-check");
    await delay(Math.max(0, OBSERVATION_MS - (performance.now() - record.invokedAt)));
    await checkpoint("end-of-observation");
    await delay(250);
    await checkpoint("late-check");
    record.observationEndedAt = performance.now();
    // Snapshot now: later callbacks must not silently revise the bounded result.
    record.methods = JSON.parse(JSON.stringify(record.methods));
    record.canaries = JSON.parse(JSON.stringify(record.canaries));
  } catch (error) {
    record.errors.push(describeError(error));
  } finally {
    clearTimeout(loadTimer);
    if (listener) window.removeEventListener("message", listener);
    if (frame) frame.remove();
    if (popup && !popup.closed) popup.close();
    try {
      for (const registration of await matchingRegistrations([seedScope, attemptScope])) {
        if (!await bounded(registration.unregister(), "Unregister owned scope")) {
          cleanupErrors.push(`Unregister returned false: ${registration.scope}`);
        }
      }
      await delay(100);
      const remaining = await matchingRegistrations([seedScope, attemptScope]);
      if (remaining.length) cleanupErrors.push("Owned registration still observed after cleanup");
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    record.cleanupErrors = cleanupErrors;
  }
}
nextButton.addEventListener("click", async () => {
  if (report.running || report.complete) return;
  const scenario = SCENARIOS[report.cases.length];
  report.running = true;
  nextButton.disabled = true;
  // Open during the click, before asynchronous seed setup consumes user activation.
  const popup = scenario.kind === "popup" ? window.open("about:blank", "_blank") : null;
  statusElement.textContent = `Observing ${scenario.kind}/${scenario.lifecycle}`;
  try {
    await runScenario(scenario, popup);
  } catch (error) {
    report.errors.push(String(error));
    if (popup && !popup.closed) popup.close();
  } finally {
    report.running = false;
    report.complete = report.cases.length === SCENARIOS.length || report.errors.length > 0;
    if (report.complete) report.finished = new Date().toISOString();
    nextButton.disabled = report.complete;
    nextButton.textContent = report.complete ? "Finished" :
      `Run ${SCENARIOS[report.cases.length].kind}/${SCENARIOS[report.cases.length].lifecycle}`;
    statusElement.textContent = report.complete ?
      "Collection complete; inspect errors and raw outcomes. This is not a conformance verdict." :
      "Scenario recorded. Click to run the next scenario.";
    downloadButton.disabled = false;
    render();
  }
});
downloadButton.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = "sw777-dead-context-observations.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
(async () => {
  try {
    if (!isSecureContext || !("serviceWorker" in navigator)) throw new Error("Service workers unavailable");
    if (navigator.serviceWorker.controller || (await navigator.serviceWorker.getRegistrations()).length) {
      throw new Error("Existing service worker detected; use a fresh disposable profile or another port");
    }
    nextButton.textContent = "Run iframe/live";
    nextButton.disabled = false;
    statusElement.textContent = "Ready. Each scenario observes callbacks for at least five seconds.";
  } catch (error) {
    report.errors.push(String(error));
    report.complete = true;
    statusElement.textContent = String(error);
    render();
  }
})();
