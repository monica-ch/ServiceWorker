"use strict";

const UPLOAD_MODES = ["uncontrolled", "fallback", "passthrough", "clone", "new-request", "read-rebuild"];
const UPLOAD_BYTES = 8 * 1024 * 1024;
const uploadDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runUploadCase(mode, test) {
  if (!UPLOAD_MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const id = crypto.randomUUID();
  const frameURL = new URL(`resources/frame.html?id=${id}`, location.href);
  const workerURL = new URL("resources/worker.js", location.href);
  const endpoint = new URL(`resources/upload_receiver.py?mode=${mode}&id=${id}`, location.href);
  const row = {mode, id, payloadBytes: UPLOAD_BYTES, uploadEvents: [], xhrEvents: [], interceptions: []};
  let registration, frame, xhr, listener, frameTimer;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(frameTimer);
    if (listener && frame?.contentWindow) {
      frame.contentWindow.navigator.serviceWorker.removeEventListener("message", listener);
    }
    if (xhr && xhr.readyState !== XMLHttpRequest.DONE) xhr.abort();
    if (frame) frame.remove();
    if (registration && !await registration.unregister()) {
      throw new Error("Could not unregister diagnostic service worker");
    }
  }
  if (test) test.add_cleanup(cleanup);
  try {
    if (mode !== "uncontrolled") {
      registration = await navigator.serviceWorker.register(workerURL, {scope: frameURL.href});
      const deadline = performance.now() + 8000;
      while (registration.active?.state !== "activated") {
        if (performance.now() > deadline) throw new Error("Worker activation timed out");
        await uploadDelay(25);
      }
    }
    frame = document.createElement("iframe");
    frame.hidden = true;
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = () => reject(new Error("Client frame load failed"));
      frameTimer = setTimeout(() => reject(new Error("Client frame load timed out")), 8000);
      frame.src = frameURL.href;
      document.body.append(frame);
    });
    clearTimeout(frameTimer);
    const container = frame.contentWindow.navigator.serviceWorker;
    row.controlled = container.controller !== null;
    if (row.controlled !== (mode !== "uncontrolled") ||
        (row.controlled && container.controller.scriptURL !== workerURL.href)) {
      throw new Error("Unexpected controller; use a fresh browser profile");
    }
    listener = event => {
      if (event.data?.type === "upload-intercepted" && event.data.id === id &&
          event.source?.scriptURL === workerURL.href) {
        row.interceptions.push(event.data);
      }
    };
    container.addEventListener("message", listener);
    const body = new Uint8Array(UPLOAD_BYTES).fill(120);
    const digest = await crypto.subtle.digest("SHA-256", body);
    row.payloadSHA256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    xhr = new frame.contentWindow.XMLHttpRequest();
    const started = performance.now();
    for (const type of ["loadstart", "progress", "load", "loadend", "error", "abort", "timeout"]) {
      xhr.upload.addEventListener(type, event => row.uploadEvents.push({
        type, loaded: event.loaded, total: event.total,
        lengthComputable: event.lengthComputable, elapsedMs: performance.now() - started
      }));
    }
    for (const type of ["load", "loadend", "error", "abort", "timeout"]) {
      xhr.addEventListener(type, () => row.xhrEvents.push(type));
    }
    xhr.open("POST", endpoint);
    xhr.timeout = 25000;
    xhr.responseType = "json";
    await new Promise(resolve => {
      xhr.addEventListener("loadend", resolve, {once: true});
      xhr.send(body);
    });
    row.elapsedMs = performance.now() - started;
    row.status = xhr.status;
    row.server = xhr.response;
    if (mode !== "uncontrolled") {
      const deadline = performance.now() + 2000;
      while (!row.interceptions.length && performance.now() < deadline) await uploadDelay(25);
      if (row.interceptions.length !== 1 || row.interceptions[0].mode !== mode) {
        throw new Error("Missing or unexpected SW interception record");
      }
    }
    if (row.status !== 200 || row.xhrEvents.some(type => ["error", "abort", "timeout"].includes(type)) ||
        row.server?.source !== "network-server" || row.server.serverBytesRead !== UPLOAD_BYTES ||
        row.server.sha256 !== row.payloadSHA256) {
      throw new Error(`Upload fixture failed: ${JSON.stringify(row)}`);
    }
    row.checks = uploadProgressChecks(row);
    return row;
  } finally {
    await cleanup();
  }
}

function uploadProgressChecks(row) {
  const progress = row.uploadEvents.filter(event => event.type === "progress");
  const types = row.uploadEvents.map(event => event.type);
  const last = progress.at(-1);
  const checks = {
    "At least one upload progress event": progress.length > 0,
    "Progress loaded is nondecreasing": progress.length > 0 &&
      progress.every((event, index) => !index || event.loaded >= progress[index - 1].loaded),
    "Progress length is computable and loaded <= total": progress.length > 0 &&
      progress.every(event => event.lengthComputable && event.loaded >= 0 &&
        event.loaded <= event.total && event.total === row.payloadBytes),
    "Final progress equals body length": last?.loaded === row.payloadBytes && last?.total === row.payloadBytes,
    "Upload load follows final progress": progress.length > 0 &&
      types.includes("load") && types.indexOf("load") > types.lastIndexOf("progress"),
    "Upload loadend follows load": types.includes("load") && types.indexOf("loadend") > types.indexOf("load"),
    "No upload error, abort or timeout": !types.some(type => ["error", "abort", "timeout"].includes(type)),
    "Server received exact complete body": row.server?.serverBytesRead === row.payloadBytes &&
      row.server?.sha256 === row.payloadSHA256
  };
  row.intermediateProgressCount = progress.filter(event => event.loaded > 0 && event.loaded < row.payloadBytes).length;
  return checks;
}
