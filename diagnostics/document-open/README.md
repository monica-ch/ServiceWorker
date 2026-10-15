# document.open(): controller, client identity, and fetch routing

Observation-only preparation for
[w3c/ServiceWorker#1313](https://github.com/w3c/ServiceWorker/issues/1313).
This is **not a normative WPT**. It records behavior without assigning
conformance PASS/FAIL to the proposed preservation contract.

## Run

From the repository root:

```powershell
python -B diagnostics\document-open\server.py --port 8768
```

Open `http://127.0.0.1:8768/` in a fresh disposable browser profile. Click once
per scenario, wait for its observations, then download JSON. The top-level case
opens a popup synchronously during the click; allow popups. A blocked popup is
a setup error, not evidence about document.open().

The server uses only the Python standard library, binds to IPv4 loopback, and
serves explicitly allowed paths. No certificate override or disabled web
security is required. Run the server on the same machine as the browser.
Stop it with Ctrl+C.

## Four scenarios

| Scenario | Invocation and resource loading |
| --- | --- |
| No-open iframe control | Loaded controlled iframe; insert an external script with DOM APIs, without document.open/write |
| Self-open iframe | A target-realm timer calls document.open/write/close on its own loaded controlled document |
| Parent-open iframe | An uncontrolled same-origin parent directly calls document.open/write/close on a loaded controlled iframe |
| Self-open top-level | A loaded controlled popup calls document.open/write/close from its own timer task; its opener observes |

The no-open control deliberately does **not** call document.write() after load:
that would implicitly open the document and invalidate the control.

The self-open cases use a timer callback defined in the target realm, not a
synchronous parent call into a child function. HTML uses the **entry document**
for the URL update; synchronously calling a child-defined function from the
parent would still make the parent the entry document.

Each case starts with a fresh, activated registration and a uniquely scoped,
fully loaded controlled target. There is no skipWaiting(), clients.claim(),
worker update, or registration replacement during measurement. The observing
parent is uncontrolled and outside the target registration's scope.

## Measurements and safeguards

- Retain the initial Document, Navigator, ServiceWorkerContainer and controller.
  Compare reference identity immediately after open, after script execution,
  and/or at the final checkpoint. Check that the controller is non-null initially.
- Fetch a unique baseline URL from the target before opening it.
- Use document.write() to insert an external script with a unique absolute URL.
  Its execution reports to the surviving parent/opener. Check that replacement
  content exists and the original content is gone.
- Perform an ordinary target-realm fetch() after replacement.
- The worker transparently forwards requests with `fetch(event.request)` and
  independently records each probe's FetchEvent.clientId, request URL,
  destination, and `clients.get(clientId).url`. A successful network response
  or script execution alone is **not** counted as worker interception.
- Keep the controllerchange listener on ServiceWorkerContainer, not Document or
  Window, and define its callback in the surviving parent. Synthetic events
  before and after prove that the listener remains attached; they are recorded
  with `isTrusted: false` and excluded from browser-generated event counts.
- Observe for a further 1000 ms after the post-open fetch. Zero trusted events
  means none during this bounded interval, not a guarantee about all future time.
- Query worker logs over MessageChannel and verify the worker instance ID did
  not change. A restart or failed baseline is a diagnostic error, not evidence
  that interception stopped. Missing/empty client IDs are "not-established",
  never counted as equal identities.
- Refuse origins with existing registrations or a controlling worker.
  Remove only exact owned scopes and contexts, with explicit cleanup errors.

All probe/script URLs are absolute. This separates service-worker routing from
changes to the target's base URL. The two issues can be tested separately later.
Worker-visible URLs are sampled while handling each probe; the baseline
snapshot completes before document.open().

## Fresh local evidence

Two complete four-case collections per product, on Windows:

| Product | Engine | Tested build |
| --- | --- | --- |
| Edge | Blink | 155.0.4283.45 |
| Chromium | Blink | 151.0.7922.34 |
| Firefox | Gecko | 158.0 |
| Playwright WebKit | WebKit | 26.6, Playwright browser revision 2359 |

**32 scenario observations, including 24 explicit document.open operations and
8 no-open controls.** Each collection used a live external observer; profiles
were isolated from ordinary browsing and reused for repeats after cleanup.
All setup, baseline, listener, content-replacement, and cleanup checks completed.

In every measured case:

- The original non-null controller was the same ServiceWorker object
  immediately after open and at the later checkpoints.
- Document, Navigator and ServiceWorkerContainer identity was preserved at the
  recorded comparisons.
- The inserted script and later ordinary fetch each reached the existing worker.
- The baseline, script and post-open fetch had the same nonempty clientId.
- No browser-generated controllerchange event was observed during the bounded
  interval; both synthetic listener controls were received.

In the parent-open case, document.URL changed to the uncontrolled parent's URL,
outside the target registration's scope, while the controller and clientId
remained unchanged. The worker-visible Client.url remained the original URL in
all engines. This matches the
[Client.url definition](https://w3c.github.io/ServiceWorker/#client-url):
it returns the client's serialized **creation URL**, not a live document.URL.

**WebKit here is a Windows automation port, not Safari on macOS/iOS.**
This is three-engine evidence, not Safari product verification. The Chrome-family
binary was Chromium, not an installed branded Chrome build. Edge confirms Blink;
it is not a fourth engine.

Raw observations and a readable TPAC analysis are provided in
`sw1313-document-open-evidence.zip`, along with this runnable source and a
SHA-256 manifest. The primary records are `sw1313-local-observations.json` and
`sw1313-firefox-observations.json`. These are not official wptrunner or wpt.fyi results.

The same observations are also available directly in this branch:
[Edge / Chromium / WebKit raw results](local-results.json),
[Firefox raw results](firefox-results.json), and the
[normalized summary](observation-summary.json).
GitHub serves the source for download; run the loopback server above to execute
the diagnostic in a browser.

## Current specification and existing WPTs

[HTML document open steps](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#document-open-steps)
operate on the existing Document: they remove its content/listeners, update
URL/history state using the entry document, and create a parser. They do not
explicitly create another global environment or clear service-worker control.
This concerns the stream-opening overload, not three-argument document.open()
which delegates to window opening.

[WHATWG HTML PR 3918](https://github.com/whatwg/html/pull/3918) removed the old realm
replacement model. The issue's original browser observations predate the current
model and are historical, including its pre-Chromium Edge result.

The
[controller getter](https://w3c.github.io/ServiceWorker/#navigator-service-worker-controller)
uses the container's associated client's active service worker.
The
[FetchEvent.clientId getter](https://w3c.github.io/ServiceWorker/#fetch-event-clientid)
provides the observable identity used here. Equal client IDs and object
identities support preservation; they do not independently expose every
internal environment slot.

Existing HTML WPTs cover important components:

- [no-new-global.window.js](https://github.com/web-platform-tests/wpt/blob/8834c3701b4dd272e778c8d16759c1229ad56bce/html/webappapis/dynamic-markup-insertion/opening-the-input-stream/no-new-global.window.js)
  checks retained globals, object identity/prototypes, including Document and Navigator.
- [event-listeners.window.js](https://github.com/web-platform-tests/wpt/blob/8834c3701b4dd272e778c8d16759c1229ad56bce/html/webappapis/dynamic-markup-insertion/opening-the-input-stream/event-listeners.window.js)
  checks listener removal from Window and document nodes.
- [url-entry-document-sync-call.window.js](https://github.com/web-platform-tests/wpt/blob/8834c3701b4dd272e778c8d16759c1229ad56bce/html/webappapis/dynamic-markup-insertion/opening-the-input-stream/url-entry-document-sync-call.window.js)
  checks URL updates when a parent synchronously calls a child-defined function.

Those sources were inspected, not rerun as part of this task. Bounded GitHub
code searches for document.open/document.write under service-workers, and
serviceWorker/controller under dynamic-markup-insertion, found no direct
complete controller-plus-written-subresource test. This is **not an exhaustive
proof** that no relevant test exists elsewhere.

## Discuss

Under the current HTML model, should document.open() preserve the target's
existing service-worker client and controller, with newly written subresources
continuing through that controller?

Prefer **preservation**, not "inheritance": the measured parent case retains
the target's controller even though the caller is uncontrolled and the new
document URL lies outside the registration scope.

The measured behavior supports the preservation proposal; it does not constitute
vendor consensus. Confirm the intended model and whether the existing text is
sufficient or needs a narrow HTML/Service Worker integration clarification.
The diagnostic does not demonstrate a current interoperability failure in these
scenarios.

After agreement, split normative WPT coverage:

1. **Controller preservation:** controlled loaded iframe, retain controller,
   open/write/close, assert non-null and identical controller.
2. **Subresource interception:** a uniquely addressed document.write-inserted
   external script generates a fetch event in that worker. Keep script execution
   distinct from interception.
3. **No controller transition:** listen on the container from a surviving
   observer, verify the listener is still operational, and use appropriate task
   synchronization rather than treating a fixed sleep as a normative guarantee.
4. **Client identity:** compare nonempty clientId values on a before request,
   written subresource, and after request. Keep Client.url separate from document.URL.

Add popup coverage using user activation. Uncontrolled targets, a caller with
a different controller, initial about:blank, navigation/BFCache, relative
subresource URLs, cross-origin cases, and actual Safari releases remain outside
this matrix.

## Fixture checks

```powershell
python -B -m unittest discover -s diagnostics\document-open -p test_server.py
node diagnostics\document-open\test_probe.js
```

These check routing/validation and observation bookkeeping, not a proposed
conformance contract. Separate browser fault checks confirmed popup-blocked
reporting, preservation of a pre-existing registration, and explicit failure
plus cleanup when the written script's server response was deliberately broken.
