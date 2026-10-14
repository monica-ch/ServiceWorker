async function record(event, data) {
  const url = new URL(event.request.url);
  const response = await fetch("/observe", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      run: url.searchParams.get("run"),
      event: {
        case: url.searchParams.get("case"),
        operation: url.searchParams.get("operation"),
        clientId: event.clientId,
        ...data
      }
    })
  });
  if (!response.ok) throw new Error(`Observation write failed: ${response.status}`);
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname !== "/media.wav") return;
  const observed = record(event, {
    stage: "request",
    range: event.request.headers.get("Range"),
    mode: event.request.mode,
    destination: event.request.destination,
    url: event.request.url
  });
  event.waitUntil(observed.catch(async error => {
    console.error(error);
    const client = await clients.get(event.clientId);
    if (client) client.postMessage({type: "observation-error", message: String(error)});
    throw error;
  }));
  if (url.searchParams.get("operation") === "passthrough") {
    event.respondWith((async () => {
      // Preserve the UA's original Request, including privileged Range handling.
      const response = await fetch(event.request);
      await observed;
      await record(event, {
        stage: "response", responseType: response.type, responseStatus: response.status
      });
      return response;
    })());
  }
});
