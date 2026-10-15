"use strict";

const SCENARIOS = ["no-open-iframe", "self-open-iframe", "parent-open-iframe", "self-open-top-level"];
const EVENT_WINDOW_MS = 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {
  issue: "w3c/ServiceWorker#1313", kind: "Observation only; not a normative WPT",
  userAgent: navigator.userAgent, started: new Date().toISOString(),
  eventWindowMs: EVENT_WINDOW_MS, cases: [], errors: [], running: false, complete: false
};
window.__tpacResult = report;
const nextButton = document.querySelector("#next");
const downloadButton = document.querySelector("#download");
const statusElement = document.querySelector("#status");

function describeError(error) {
  return {name: error?.name ?? null, message: error?.message ?? String(error)};
}
function controllerDescription(controller) {
  return controller ? {scriptURL: controller.scriptURL, state: controller.state} : null;
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function activate(registration) {
  const deadline = performance.now() + 10000;
  while (registration.active?.state !== "activated") {
    if (performance.now() > deadline) throw new Error("Worker activation timed out");
    await delay(25);
  }
}
async function snapshot(worker) {
  const channel = new MessageChannel();
  try {
    return await bounded(new Promise(resolve => {
      channel.port1.onmessage = event => resolve(event.data);
      worker.postMessage({type: "snapshot"}, [channel.port2]);
    }), "Worker observation snapshot");
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}
function summarize(record) {
  const observations = record.workerObservations || [];
  const before = observations.filter(o => o.phase === "before");
  const written = observations.filter(o => o.phase === "written");
  const after = observations.filter(o => o.phase === "after");
  const requests = [...before, ...written, ...after];
  const identityObservable = before.length === 1 && written.length > 0 && after.length > 0 &&
    requests.every(o => typeof o.clientId === "string" && o.clientId.length > 0);
  return {
    writtenScriptFetchEvents: written.length,
    ordinaryFetchEventsAfter: after.length,
    clientIdentity: identityObservable ?
      (requests.every(o => o.clientId === before[0].clientId) ? "same-clientId" : "different-clientId") :
      "not-established",
    controllerchangeEvents: record.controllerEvents.filter(event => event.isTrusted).length,
    listenerControlBefore: record.controllerEvents.filter(event => !event.isTrusted && event.stage === "before").length,
    listenerControlAfter: record.controllerEvents.filter(event => !event.isTrusted && event.stage === "after").length,
    workerClientURLs: requests.map(o => ({phase: o.phase, clientURL: o.clientURL}))
  };
}
function render() {
  const table = document.createElement("table");
  const header = table.insertRow();
  for (const label of ["Scenario", "Same controller (immediate / final)", "Written script / fetch events",
                       "Client identity", "Trusted controllerchange", "Errors"]) {
    const th = document.createElement("th");
    th.textContent = label;
    header.append(th);
  }
  for (const row of report.cases) {
    const tr = table.insertRow();
    for (const value of [
      row.scenario, `${row.sameControllerImmediately ?? "?"} / ${row.sameControllerFinally ?? "?"}`,
      `${row.summary?.writtenScriptFetchEvents ?? "?"} / ${row.summary?.ordinaryFetchEventsAfter ?? "?"}`,
      row.summary?.clientIdentity ?? "not established", row.summary?.controllerchangeEvents ?? "?",
      [...row.errors, ...row.cleanupErrors].map(error => error.message).join("; ") || "none"
    ]) tr.insertCell().textContent = value;
  }
  document.querySelector("#summary").replaceChildren(table);
  document.querySelector("#output").textContent = JSON.stringify(report, null, 2);
}
async function runScenario(scenario, popup) {
  const token = crypto.randomUUID();
  const scope = new URL(`case-${token}/`, location.href).href;
  const scriptURL = new URL(`worker.js?token=${token}`, location.href).href;
  const ownerURL = new URL(`owner.html?token=${token}`, scope).href;
  const probeURL = phase => new URL(`probe?token=${token}&phase=${phase}`, scope).href;
  const writtenURL = new URL(`written.js?token=${token}&phase=written`, scope).href;
  const record = {
    scenario, token, scope, scriptURL, ownerURL, callerURL: location.href,
    callerControlled: navigator.serviceWorker.controller !== null,
    errors: [], cleanupErrors: [], controllerEvents: []
  };
  report.cases.push(record);
  let registration, owner, frame, ownerListener, scriptListener, container, controllerListener;
  let listenerProbeStage = null;
  try {
    if (scenario === "self-open-top-level" && !popup) throw new Error("Popup blocked; allow popups and rerun");
    registration = await bounded(navigator.serviceWorker.register(scriptURL, {scope}), "Registration");
    await activate(registration);
    const initialWorker = await snapshot(registration.active);
    if (popup) owner = popup;
    else {
      frame = document.createElement("iframe");
      document.querySelector("#frames").append(frame);
      owner = frame.contentWindow;
    }
    const loaded = new Promise(resolve => {
      ownerListener = event => {
        if (event.origin === location.origin && event.source === owner &&
            event.data?.type === "document-open-owner-ready" && event.data.token === token) resolve();
      };
      window.addEventListener("message", ownerListener);
    });
    owner.location.href = ownerURL;
    await bounded(loaded, "Loaded owner handshake");
    window.removeEventListener("message", ownerListener);
    const originalDocument = owner.document;
    const originalNavigator = owner.navigator;
    container = originalNavigator.serviceWorker;
    const originalController = container.controller;
    const ownerFunctions = owner.__tpac1313;
    record.before = {controller: controllerDescription(originalController), url: owner.document.URL,
      isTopLevel: owner === owner.top};
    if (!originalController || originalController.scriptURL !== scriptURL) {
      throw new Error("Initial owner is not controlled by the expected worker");
    }
    controllerListener = event => record.controllerEvents.push({
      isTrusted: event.isTrusted, stage: listenerProbeStage,
      observedAt: performance.now(), controller: controllerDescription(container.controller)
    });
    container.addEventListener("controllerchange", controllerListener);
    listenerProbeStage = "before";
    container.dispatchEvent(new Event("controllerchange"));
    listenerProbeStage = null;
    record.beforeNetwork = await bounded(ownerFunctions.fetchJSON(probeURL("before")), "Baseline fetch");
    const beforeWorker = await snapshot(registration.active);
    if (beforeWorker.instance !== initialWorker.instance) throw new Error("Worker restarted before baseline snapshot");
    record.beforeWorkerObservations = beforeWorker.observations;
    if (!beforeWorker.observations.some(o => o.phase === "before" && o.token === token)) {
      throw new Error("Controlled baseline fetch did not produce a worker observation");
    }
    const scriptExecuted = new Promise(resolve => {
      scriptListener = event => {
        if (event.origin === location.origin && event.source === owner &&
            event.data?.type === "document-open-script-executed" && event.data.token === token) resolve(event.data);
      };
      window.addEventListener("message", scriptListener);
    });
    const markup = `<!doctype html><meta charset="utf-8"><title>Reopened target</title>` +
      `<body data-replacement="${token}"><p>Reopened document</p>` +
      `<script src="${writtenURL}"></script></body>`;
    record.operationAt = performance.now();
    let immediate;
    if (scenario.startsWith("self-open-")) {
      immediate = await bounded(ownerFunctions.selfReplace(markup), "Target-realm self replacement");
    } else if (scenario === "parent-open-iframe") {
      const returnedDocument = originalDocument.open();
      immediate = {
        returnedDocument, document: owner.document, navigator: owner.navigator,
        container: owner.navigator.serviceWorker, controller: owner.navigator.serviceWorker.controller,
        url: owner.document.URL
      };
      originalDocument.write(markup);
      originalDocument.close();
    } else {
      immediate = {
        document: owner.document, navigator: owner.navigator, container,
        controller: container.controller, url: owner.document.URL
      };
      const script = originalDocument.createElement("script");
      script.src = writtenURL;
      originalDocument.body.append(script);
    }
    record.immediately = {controller: controllerDescription(immediate.controller), url: immediate.url};
    record.sameControllerImmediately = immediate.controller === originalController;
    record.sameDocumentImmediately = immediate.document === originalDocument;
    record.sameNavigatorImmediately = immediate.navigator === originalNavigator;
    record.sameContainerImmediately = immediate.container === container;
    record.openReturnedOriginalDocument = scenario === "no-open-iframe" ? null :
      immediate.returnedDocument === originalDocument;
    record.writtenScript = await bounded(scriptExecuted, "External script execution");
    record.afterScript = {controller: controllerDescription(owner.navigator.serviceWorker.controller),
      url: owner.document.URL};
    record.sameControllerAfterScript = owner.navigator.serviceWorker.controller === originalController;
    record.replacementMarkerPresent = owner.document.body?.dataset.replacement === token;
    record.originalMarkerPresent = !!owner.document.getElementById("original");
    record.afterNetwork = await bounded(ownerFunctions.fetchJSON(probeURL("after")), "Post-operation ordinary fetch");
    listenerProbeStage = "after";
    container.dispatchEvent(new Event("controllerchange"));
    listenerProbeStage = null;
    await delay(EVENT_WINDOW_MS);
    const finalWorker = await snapshot(registration.active);
    record.workerInstanceBefore = initialWorker.instance;
    record.workerInstanceAfter = finalWorker.instance;
    record.workerContinuityVerified = finalWorker.instance === initialWorker.instance;
    if (!record.workerContinuityVerified) throw new Error("Worker restarted; missing log entries would be inconclusive");
    record.workerObservations = finalWorker.observations;
    for (const observation of record.workerObservations) {
      if (observation.inspectionError) record.errors.push(observation.inspectionError);
    }
    record.final = {controller: controllerDescription(owner.navigator.serviceWorker.controller),
      url: owner.document.URL};
    record.sameControllerFinally = owner.navigator.serviceWorker.controller === originalController;
    record.sameDocumentFinally = owner.document === originalDocument;
    record.sameContainerFinally = owner.navigator.serviceWorker === container;
    record.observationEndedAt = performance.now();
    record.summary = summarize(record);
  } catch (error) {
    record.errors.push(describeError(error));
  } finally {
    if (ownerListener) window.removeEventListener("message", ownerListener);
    if (scriptListener) window.removeEventListener("message", scriptListener);
    if (container && controllerListener) container.removeEventListener("controllerchange", controllerListener);
    if (frame) frame.remove();
    if (popup && !popup.closed) popup.close();
    try {
      const own = (await bounded(navigator.serviceWorker.getRegistrations(), "Cleanup query"))
        .filter(reg => reg.scope === scope);
      for (const reg of own) {
        if (!await bounded(reg.unregister(), "Unregister owned scope")) {
          throw new Error("Unregister returned false for owned scope");
        }
      }
      const remaining = await bounded(navigator.serviceWorker.getRegistrations(), "Cleanup verification");
      if (remaining.some(reg => reg.scope === scope)) throw new Error("Owned registration remains after cleanup");
    } catch (error) {
      record.cleanupErrors.push(describeError(error));
    }
  }
}
nextButton.addEventListener("click", async () => {
  if (report.running || report.complete) return;
  const scenario = SCENARIOS[report.cases.length];
  report.running = true;
  nextButton.disabled = true;
  const popup = scenario === "self-open-top-level" ? window.open("about:blank", "_blank") : null;
  statusElement.textContent = `Observing ${scenario}`;
  try {
    await runScenario(scenario, popup);
  } catch (error) {
    report.errors.push(describeError(error));
    if (popup && !popup.closed) popup.close();
  } finally {
    report.running = false;
    report.complete = report.cases.length === SCENARIOS.length || report.errors.length > 0;
    if (report.complete) report.finished = new Date().toISOString();
    nextButton.disabled = report.complete;
    nextButton.textContent = report.complete ? "Finished" : `Run ${SCENARIOS[report.cases.length]}`;
    const failed = report.errors.length || report.cases.some(row => row.errors.length || row.cleanupErrors.length);
    statusElement.textContent = failed ? "Diagnostic errors recorded; inspect JSON. Not a conformance verdict." :
      report.complete ? "Observations complete. No normative PASS/FAIL assigned." : "Recorded. Click for the next scenario.";
    downloadButton.disabled = false;
    render();
  }
});
downloadButton.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = "sw1313-document-open-observations.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
(async () => {
  try {
    if (!isSecureContext || !("serviceWorker" in navigator)) throw new Error("Service workers unavailable");
    if (navigator.serviceWorker.controller || (await navigator.serviceWorker.getRegistrations()).length) {
      throw new Error("Existing service worker detected; use a fresh disposable profile or another port");
    }
    nextButton.disabled = false;
    nextButton.textContent = `Run ${SCENARIOS[0]}`;
    statusElement.textContent = "Ready. Real user activation is needed for the top-level popup.";
  } catch (error) {
    report.errors.push(describeError(error));
    report.complete = true;
    statusElement.textContent = error.message;
    downloadButton.disabled = false;
    render();
  }
})();
