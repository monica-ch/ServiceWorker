# XHR upload progress through Service Workers

Preparation for [w3c/ServiceWorker#1141](https://github.com/w3c/ServiceWorker/issues/1141).
Includes a standalone six-case diagnostic, baseline WPT candidates and a
**tentative proposal WPT** for transparent pass-through.

## Important specification distinction

XHR supplies `processRequestBodyChunkLength` and `processRequestEndOfBody`
callbacks to its fetch operation. Fetch stores them on **fetch params**, not
the JavaScript `Request` or its body stream. The JavaScript `fetch()` algorithm
starts another fetch with response processing, without supplying these upload
callbacks. Passing the original `event.request` does not itself forward the
original XHR's callbacks.

Consequently, the existence of Fetch's transmission callbacks does **not**
establish that today's text requires upload progress through
`respondWith(fetch(event.request))`. Progress preservation is a useful proposal
to discuss, not an already-proven normative requirement. A tentative-test
failure below is not sufficient to label an implementation nonconformant.

Sources:

- [XHR send and upload callbacks](https://xhr.spec.whatwg.org/#the-send()-method)
- [Fetch parameters](https://fetch.spec.whatwg.org/#fetch-params)
- [Creating a fetch operation](https://fetch.spec.whatwg.org/#concept-fetch)
- [JavaScript fetch() algorithm](https://fetch.spec.whatwg.org/#fetch-method)
- [HTTP fetch / service-worker response versus fallback](https://fetch.spec.whatwg.org/#http-fetch)
- [Network transmission and callbacks](https://fetch.spec.whatwg.org/#http-network-fetch)
- [Existing WPT fetch-event.https.html](https://github.com/web-platform-tests/wpt/blob/master/service-workers/service-worker/fetch-event.https.html)

That existing WPT already expects upload events for network fallback and no
upload progress/completion events for a synthetic SW response. It does not
settle whether transparent inner-fetch forwarding should be introduced.

## Run in any installed browser

From the repository root, with Python 3 (no packages required):

```powershell
python diagnostics\upload-progress\server.py --port 0
```

Open the printed loopback URL in a **fresh, disposable profile**, select
**Run observations**, then **Download JSON**. On macOS/Linux, use `python3`
and `/` as path separators. `?autorun` starts immediately.

Do not open the HTML using `file:` or disable web security. This local server
requires no internet, external assets, or certificates. Stop it with Ctrl+C.
The diagnostic refuses pre-existing service workers and removes only its own
unique registrations. It does not claim the parent page or use `skipWaiting`.

The six cases are:

| Mode | Worker strategy | Interpretation |
| --- | --- | --- |
| uncontrolled | No controlling SW | Baseline |
| fallback | Observe fetch event; do not call respondWith | Baseline |
| passthrough | `respondWith(fetch(event.request))` | Proposed progress-preservation requirement |
| clone | `respondWith(fetch(event.request.clone()))` | Diagnostic only |
| new-request | `respondWith(fetch(new Request(event.request)))` | Diagnostic only |
| read-rebuild | Read arrayBuffer, then fetch URL with buffered body | Diagnostic only |

The clone case **does not read the clone before fetching it**. `new Request`
and buffered reconstruction are distinct. Reconstruction keeps the bytes
unchanged; this is not a body-transformation or multiple-inner-fetch test.

Each case sends an 8 MiB binary body. The server reads 64 KiB at a time with
40 ms pauses (about five seconds per upload) and returns the byte count and
SHA-256 digest. The client verifies both, as well as successful XHR completion
and the expected SW/controller observation. Fixture/setup/network failures
produce explicit errors, separately from missing upload progress.

Records contain every upload event's type, `loaded`, `total`,
`lengthComputable`, client elapsed time, and independent receiver evidence.
The summary reports intermediate progress separately from the mandatory
final progress event. **No exact event count or interval is required.**

Server read pacing encourages intermediate events but cannot guarantee them:
kernel/browser buffering may allow the sender to finish sooner. Server read
timestamps are **not** socket-transmission timestamps, and progress is not
proof that bytes reached the receiving application. A final-only baseline
can satisfy the checks; do not call it an intermediate-progress measurement.

`window.__tpacResult.complete` means collection ended. Inspect `errors` and
each case's `checks`; the diagnostic does not convert missing events into a
conformance PASS. Six cases normally take around 35 seconds. Each XHR is
bounded to 25 seconds, activation/frame setup to eight seconds, and SW
observation delivery to two seconds. No unbounded upload or fixture allocation.

## WPT candidates

Copy this directory's two `*.https.html` files and `resources` directory into
a fresh `service-workers/service-worker/upload-progress/` directory in a
[WPT checkout](https://web-platform-tests.org/running-tests/from-local-system.html).
The paths are relative, so the fixture runs there without the standalone
server. The Python resource exposes the normal wptserve `main` handler and
reads `request.raw_input` incrementally.

- `xhr-upload-baseline.https.html`: two baseline tests, uncontrolled and
  controlled network fallback.
- `xhr-upload-passthrough.tentative.https.html`: one proposed transparent
  pass-through requirement. The `.tentative` name and visible text explicitly
  mark the unresolved integration question.

For example, from a configured WPT checkout:

```text
./wpt run chrome service-workers/service-worker/upload-progress/
./wpt run firefox service-workers/service-worker/upload-progress/
```

The tests check progress presence, monotonic loaded values, computable correct
total, final loaded equal to body length, upload `load`/`loadend` ordering,
absence of upload errors, and complete exact server receipt. They do not assert
exact counts/timing or require a non-final event. Cloning and reconstruction
remain diagnostic-only, not additional normative or tentative assertions.

The standalone server can also host these pages if supplied official
`testharness.js` and `testharnessreport.js` via `--wpt-resources PATH`. Such a
local loopback execution uses the real harness but is **not** an official
wptrunner/cross-browser infrastructure result. These third-party files are
not bundled or modified here.

## Fixture checks

```powershell
python -B -m unittest discover -s diagnostics\upload-progress -p test_server.py -v
node diagnostics\upload-progress\test_probe.js
```

These cover bounded streaming/digest verification, truncated bodies, the WPT
adapter, HTTP framing, static routing and explicit error handling.
The optional Node check exercises progress assertions, including valid
final-only progress and invalid event ordering, totals and server evidence.

## Local results

[Raw local observations and harness outcomes](local-results.json) were captured
on Windows in headless Edge 155.0.4283.45 and Chromium 151.0.7922.34. Each build
ran the six-case diagnostic twice, then both WPT candidate pages using the
official harness served on trustworthy loopback (not wptrunner).

| Case | Both local builds |
| --- | --- |
| Uncontrolled | Intermediate progress, final progress, upload load and loadend |
| Controlled network fallback | Intermediate progress, final progress, upload load and loadend |
| Transparent pass-through | Only upload loadstart; no progress/load/loadend |
| Clone pass-through | Only upload loadstart; no progress/load/loadend |
| new Request pass-through | Only upload loadstart; no progress/load/loadend |
| Read and rebuild | Only upload loadstart; no progress/load/loadend |

Every diagnostic upload returned HTTP 200 and the server received all
8,388,608 bytes with the correct SHA-256 digest. Baselines observed 28-29
intermediate events; these counts are evidence, not assertions.
The outer XHR's response load/loadend still fired in every case; the missing
completion events above are specifically on **xhr.upload**.

The baseline WPT page passed 2/2 tests in each build. The tentative pass-through
page failed its single proposed test on "At least one upload progress event";
the harness itself completed normally, without a timeout. The failure is
intentional evidence against the proposed behavior, not a broken test fixture.
No expectations were weakened to make that proposed test pass.

Both products share Blink. Chromium is not a measured branded Chrome release;
the Firefox supplement below adds Gecko evidence. Safari remains untested.

### Firefox supplement

[Firefox 158.0 raw observations](firefox-results.json) use the installed release
binary, native WebDriver BiDi, a temporary profile, headless Windows and the
same paced fixture and WPT harness. Two complete six-case runs were collected.

| Case | Firefox 158.0 | Edge/Chromium above |
| --- | --- | --- |
| Uncontrolled / network fallback | Intermediate and final progress, load, loadend | Same event categories |
| Transparent pass-through | loadstart, load, loadend; **no progress** | loadstart only |
| Clone / new Request / read-rebuild | loadstart, load, loadend; **no progress** | loadstart only |

All twelve Firefox uploads delivered exactly 8 MiB, verified by byte count and
digest. For inner-fetch cases, Firefox's upload load/loadend reported loaded
and total equal to the full body size, but neither intermediate nor final
upload progress was emitted. Thus Gecko and Blink agree on missing progress
in this fixture but **disagree on upload completion events**.

Firefox passed the baseline WPT 2/2 and failed the tentative pass-through
proposal on missing progress, with normal harness completion. These are
local WPT-content executions, not published wpt.fyi or wptrunner results.
The completion-event difference is evidence for specification discussion,
not proof that either engine satisfies an agreed pass-through requirement.

The Firefox run also motivated a reporting correction: a load event without
any preceding progress must not satisfy "load follows final progress".
Regression coverage now includes that event sequence. This changes only a
derived check; it does not change the upload or event collection.

## TPAC question

Should transparent `respondWith(fetch(event.request))` preserve the original
XHR's upload progress? If yes, define the callback handoff and ownership in
Fetch/Service Worker, then align WPT and implementations. Keep buffering,
transformation, clones and multiple network fetches separate: body consumption
is not necessarily network transmission.
