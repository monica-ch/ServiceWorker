"use strict";

const instance = crypto.randomUUID();
const observations = [];
const pending = new Set();

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/probe") || url.pathname.endsWith("/written.js")) {
    const observation = {
      phase: url.searchParams.get("phase"), token: url.searchParams.get("token"),
      requestURL: event.request.url, destination: event.request.destination,
      clientId: event.clientId, resultingClientId: event.resultingClientId,
      receivedAt: Date.now(), workerScriptURL: self.location.href, instance
    };
    observations.push(observation);
    const task = (async () => {
      try {
        const client = event.clientId ? await self.clients.get(event.clientId) : null;
        observation.clientURL = client?.url ?? null;
        observation.clientType = client?.type ?? null;
        observation.clientFrameType = client?.frameType ?? null;
        observation.clientInspectedAt = Date.now();
      } catch (error) {
        observation.inspectionError = {name: error.name, message: error.message};
      }
    })();
    pending.add(task);
    event.waitUntil(task.finally(() => pending.delete(task)));
  }
  event.respondWith(fetch(event.request));
});

self.addEventListener("message", event => {
  if (event.data?.type !== "snapshot" || !event.ports[0]) return;
  event.waitUntil((async () => {
    await Promise.all([...pending]);
    event.ports[0].postMessage({instance, observations});
  })());
});
