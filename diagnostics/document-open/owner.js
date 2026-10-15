"use strict";

window.__tpac1313 = {
  async fetchJSON(url) {
    const response = await fetch(url, {cache: "no-store"});
    if (!response.ok) throw new Error(`Probe fetch failed: HTTP ${response.status}`);
    return response.json();
  },
  selfReplace(markup) {
    // A target-realm timer task makes this a self-call, not a parent-entry call.
    return new Promise((resolve, reject) => setTimeout(() => {
      try {
        const returnedDocument = document.open();
        const immediate = {
          returnedDocument, document, navigator, container: navigator.serviceWorker,
          controller: navigator.serviceWorker.controller, url: document.URL
        };
        document.write(markup);
        document.close();
        resolve(immediate);
      } catch (error) {
        reject(error);
      }
    }, 0));
  }
};
addEventListener("load", () => {
  (opener || parent).postMessage({
    type: "document-open-owner-ready",
    token: new URLSearchParams(location.search).get("token")
  }, location.origin);
}, {once: true});
