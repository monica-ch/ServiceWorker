"""Shared paced receiver for wptserve and the standalone diagnostic server."""

import hashlib
import json
import time

MAX_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
PAUSE_SECONDS = 0.04


def receive(stream, length):
    if not 0 < length <= MAX_BYTES:
        raise ValueError("Expected a body of 1 to 8388608 bytes")
    started = time.monotonic()
    received = 0
    digest = hashlib.sha256()
    while received < length:
        chunk = stream.read(min(CHUNK_BYTES, length - received))
        if not chunk:
            raise ValueError(f"Incomplete body: {received} of {length} bytes")
        received += len(chunk)
        digest.update(chunk)
        time.sleep(PAUSE_SECONDS)
    return {
        "source": "network-server",
        "declaredLength": length,
        "serverBytesRead": received,
        "sha256": digest.hexdigest(),
        "readDurationMs": round((time.monotonic() - started) * 1000),
        "chunkBytes": CHUNK_BYTES,
        "pauseSeconds": PAUSE_SECONDS,
    }


def main(request, response):
    headers = [(b"Content-Type", b"application/json"), (b"Cache-Control", b"no-store")]
    if request.method != "POST":
        return 405, headers, json.dumps({"error": "POST required"})
    try:
        result = receive(request.raw_input, int(request.headers.get(b"Content-Length", b"0")))
    except (ValueError, TimeoutError) as error:
        return 400, headers, json.dumps({"error": str(error)})
    return 200, headers, json.dumps(result)
