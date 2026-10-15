# Retained ServiceWorkerContainer diagnostic

Observation-only preparation for [w3c/ServiceWorker#777](https://github.com/w3c/ServiceWorker/issues/777).
This is **not a normative WPT** and does not choose the expected dead-owner behavior.

## Run

From the repository root:

```powershell
python -B diagnostics\dead-context\server.py --port 8767
```

Open `http://127.0.0.1:8767/` in a fresh, disposable browser profile. Click the
scenario button six times, allowing each observation to finish. Popup creation
runs synchronously in each button click, before asynchronous fixture setup.
A blocked popup is recorded as a setup error, not a lifecycle outcome.
Download JSON after completion. Run `http://127.0.0.1:8767/?registerOnly`
separately to repeat the lifecycle matrix with just `register()` and no seed worker.

The server binds only to IPv4 loopback and serves an explicit allowlist of files.
Loopback is a potentially trustworthy origin; no certificate override, disabled
web security, or external service is required. The server must run on the machine
where the browser runs; `127.0.0.1` does not provide remote or GitHub-hosted testing.
Stop it with Ctrl+C.

## Matrix and observation model

Each mode covers a fully loaded same-origin iframe and popup, each:

- Still live (positive control).
- Called in the same JavaScript turn immediately after `remove()` / `close()`.
- Called after a requested 100 ms delay after `remove()` / `close()`.

Before removal, the live parent retains `context.navigator.serviceWorker`.
After the lifecycle action, it looks up and calls the methods on that retained
container; it does not borrow methods from the parent's prototype.

The default mode invokes `getRegistration()`, `getRegistrations()`, reads `ready`
for the first time, and calls `register()`. All four calls run without an
intervening `await` in the immediate case. Each case has its own UUID-scoped
owner and distinct attempted registration scope.

The default mode first creates an active seed registration matching the owner's
URL. This gives `getRegistration()` and first-access `ready` a meaningful
fulfilling live control, rather than testing a `ready` promise that would wait
even on a live unregistered page. The new `register()` attempt targets a
**different** scope. The `?registerOnly` control removes the seed and all other
API calls, isolating registration from the full matrix setup.

For every API call the JSON records:

- Synchronous return type or synchronous exception, including exception name.
- Whether the live parent's native `Promise.prototype.then` accepts the value.
  Successful attachment confirms a genuine Promise, without relying on
  cross-realm `instanceof`. Failed attachment alone is not a general proof that
  an arbitrary object is not a Promise.
- Parent-observed fulfillment, rejection and exception, or
  `not-observed-within-bound`. Both observers use live-parent callback functions:
  one attaches with the parent-native `then`, the other with the returned
  promise's own `then`. Neither uses `await` on the dead-owner promise.
- Actual invocation offset and observation timestamps.

Two ordinary owner-realm promise canaries are also observed after the lifecycle
action: one fulfilled beforehand, one resolved by the parent afterward. They
help distinguish API-specific missing callbacks from general cross-realm
reaction delivery. They do **not** reveal the internal state of another promise.

A live-parent `getRegistrations()` independently checks the exact seed/attempt
scopes initially, after at least five seconds, and after an additional 250 ms.
The report snapshots callback observations at that final checkpoint. Thus
`not-observed-within-bound` means no callback observed during the recorded
window, **not** "internally pending forever." A missing registration is likewise
a bounded observation, not proof that no job could ever run later.

The page refuses an origin with existing registrations or a controlling worker.
It unregisters only its own exact scopes and closes/removes only its own contexts.
Cleanup failures are explicit. A disposable profile is still important because
unsettled operations may outlive a finite observation window.

## Critical lifecycle qualification

[HTML `close()`](https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-window-close)
sets the traversable's **is closing** flag and queues a task to definitely close
it. The `closed` getter may return true because that flag is set. Consequently,
`popup.closed === true` immediately after `close()` is **not proof that the
document has already been discarded**.

The immediate-popup case measures the *close-request boundary*, not a
guaranteed already-destroyed document. The delayed case is a separate empirical
checkpoint; 100 ms is not a standards-defined destruction boundary.

## Current specification and existing tests

The inspected Service Worker snapshot is
[`2f5ec0663aed0ad7c3ba6f00cee671ea283d86fc`](https://github.com/w3c/ServiceWorker/blob/2f5ec0663aed0ad7c3ba6f00cee671ea283d86fc/index.bs).
The container algorithms refer to the associated client and relevant settings
object, but do not spell out a shared destroyed-owner failure rule.

- [`register()`](https://w3c.github.io/ServiceWorker/#navigator-service-worker-register)
  delegates to [Start Register](https://w3c.github.io/ServiceWorker/#start-register-algorithm),
  which creates and schedules a registration job after its URL checks.
- [`getRegistration()`](https://w3c.github.io/ServiceWorker/#navigator-service-worker-getRegistration)
  and [`getRegistrations()`](https://w3c.github.io/ServiceWorker/#navigator-service-worker-getRegistrations)
  queue resolution on the promise's relevant settings object's responsible event loop.
- [`ready`](https://w3c.github.io/ServiceWorker/#navigator-service-worker-ready)
  is a cached promise getter with a note saying the returned promise never rejects.
  It must not automatically be folded into a blanket rule for methods.

The two WPTs linked from the issue are relevant but do not already test this matrix:

- [`detached-context.https.html`](https://github.com/web-platform-tests/wpt/blob/6d4552a8b1057e42a180119d70273f563e53a264/service-workers/service-worker/detached-context.https.html)
  checks detached **registration** methods/properties, a ServiceWorker object's
  `postMessage()`, and navigator access. Its registration-method check counts
  fulfillment callbacks over a bounded sample operation; it deliberately does
  not require an observable rejection.
- [`detached-register-crash.https.html`](https://github.com/web-platform-tests/wpt/blob/6d4552a8b1057e42a180119d70273f563e53a264/service-workers/service-worker/detached-register-crash.https.html)
  removes an iframe and calls `register("data:,")`. It is a crash regression
  probe, with no testharness assertion about the returned promise, error name,
  side effects, or popup behavior.

These sources were read, not rerun as official WPTs for this investigation.
The issue's 2015 Chrome observations and 2016 EdgeHTML observations are
historical evidence, not measurements of today's Chrome or Chromium-based Edge.

## Local browser evidence

Two complete matrices and two unseeded register-only matrices were collected
per product: Edge 155.0.4283.45, Chromium 151.0.7922.34, Firefox 158.0.
These are local headless Windows observations, not official WPT results.
The Chrome-family binary was Chromium, not an installed branded Chrome build.
Each product used an isolated profile, reused after cleanup for its repeats.

| Case | Chrome/Edge (Blink) | Firefox (Gecko) |
| --- | --- | --- |
| Live iframe or popup | All four APIs return fulfilling Promises | Same |
| Removed iframe, immediate or +100 ms: register() | Rejects InvalidStateError; no new registration observed | Same |
| Removed iframe: getRegistration() / getRegistrations() | Promises returned; callbacks not observed within bound | Reject InvalidStateError |
| Removed iframe: first ready access | Returns undefined, not a Promise | Rejects InvalidStateError |
| Immediately after popup.close(): register() | No callback observed, but new registration appears | Rejects InvalidStateError, but new registration appears |
| Immediately after popup.close(): getRegistration() / first ready access | Fulfill | Reject InvalidStateError |
| Immediately after popup.close(): getRegistrations() | Edge fulfills twice; Chromium fulfills once and has no observed callback once | Rejects InvalidStateError |
| 100 ms after popup.close() | Same API outcomes as removed iframe; no new registration observed | All four reject; no new registration observed |

The isolated unseeded register-only runs reproduce the registration outcomes
and side effects. All ordinary-promise canaries fulfill, and the two observer
attachment strategies agree. The three methods always return genuine Promises;
none of the API invocations synchronously throws. Errors from trying to attach
an observer to an undefined ready result are **not** throws from that getter.

The immediate-close lookup variation is preserved rather than averaged away.
All positive controls, setup checks, and cleanup checks succeed. Separate fault
checks confirm that a blocked popup is surfaced and an existing registration is
refused without deleting it.

Raw evidence is supplied in `sw777-dead-context-evidence.zip`, alongside this
diagnostic: `sw777-local-observations.json`, `sw777-firefox-observations.json`,
the normalized `sw777-observation-summary.json`, an HTML analysis, and a
SHA-256 manifest. The bundle contains 72 owner contexts and 180 API observations.

The same observations are also available directly in this branch:
[Edge / Chromium raw results](local-results.json),
[Firefox raw results](firefox-results.json), and the
[normalized summary](observation-summary.json).
GitHub serves the source for download; run the loopback server above to execute
the diagnostic in a browser.

## Suggested standards discussion

**Discuss:** At which HTML lifecycle boundary must a retained container stop
accepting operations, what must a live caller observe, and may registration jobs
still take effect?

A candidate direction, not an agreed current requirement:

1. Define the relevant owner-document lifecycle boundary with HTML. Distinguish
   a close request from an already-inactive/discarded owner.
2. For newly invoked promise-returning methods after that boundary, consider
   observable `InvalidStateError` rejection, before scheduling new registration
   work. Decide the disposition of work accepted before the boundary separately.
3. Treat first-access and previously cached `ready` separately. Reconcile its
   promise-valued contract and never-reject description; an already-fulfilled
   cached promise cannot be retroactively rejected.
4. Coordinate Service Worker behavior with HTML event-loop and Web IDL realm
   integration; specify both API outcome and side effects, not just an exception.

After agreement, add focused tentative WPTs for the selected contract, first
using removed iframes, then popup cases with appropriate user activation and a
well-defined lifecycle synchronization point. Include registration side-effect
checks, live-parent observation, and separate cached/first-access `ready` cases.
Do not encode a five-second timeout or a 100 ms sleep as normative behavior.

Not covered: navigation/BFCache, already-cached `ready`, worker-global owners,
invalid URL arguments, user-initiated tab closing, or Safari. Calls are made from
the live parent, not from callback functions defined in the destroyed realm.

## Fixture checks

```powershell
python -B -m unittest discover -s diagnostics\dead-context -p test_server.py
node diagnostics\dead-context\test_probe.js
```

These check serving boundaries and observation bookkeeping, not the proposed
browser contract.
