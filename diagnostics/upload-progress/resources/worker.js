self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || !url.pathname.endsWith("/upload_receiver.py")) return;
  const mode = url.searchParams.get("mode");
  event.waitUntil((async () => {
    const client = await clients.get(event.clientId);
    if (!client) throw new Error("Upload client unavailable for interception observation");
    client.postMessage({
      type: "upload-intercepted", id: url.searchParams.get("id"), mode,
      method: event.request.method, url: event.request.url
    });
  })());
  switch (mode) {
    case "fallback":
      return;
    case "passthrough":
      event.respondWith(fetch(event.request));
      return;
    case "clone":
      event.respondWith(fetch(event.request.clone()));
      return;
    case "new-request":
      event.respondWith(fetch(new Request(event.request)));
      return;
    case "read-rebuild":
      event.respondWith((async () => {
        const body = await event.request.arrayBuffer();
        return fetch(event.request.url, {
          method: "POST", headers: event.request.headers, body
        });
      })());
      return;
    default:
      event.respondWith(Promise.reject(new Error(`Unknown upload mode: ${mode}`)));
  }
});
