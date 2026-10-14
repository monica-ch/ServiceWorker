"""Bounded, observation-only media Range diagnostic for ServiceWorker issue 1201."""

import argparse
import json
import re
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).parent
SAMPLE_RATE = 44100
DURATION = 120
DATA_SIZE = SAMPLE_RATE * 2 * DURATION
WAV_HEADER = struct.pack(
    "<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + DATA_SIZE, b"WAVE", b"fmt ",
    16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16, b"data", DATA_SIZE,
)
TOTAL_SIZE = len(WAV_HEADER) + DATA_SIZE


def byte_range(value, size):
    """Return inclusive bounds; reject unsupported or unsatisfiable single ranges."""
    if value is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("Expected a single byte range")
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix == 0:
            raise ValueError("Empty suffix")
        return max(0, size - suffix), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size or end < start:
        raise ValueError("Unsatisfiable range")
    return start, end


def wav_bytes(start, length):
    end = start + length
    header = WAV_HEADER[start:min(end, len(WAV_HEADER))] if start < len(WAV_HEADER) else b""
    return header + bytes(length - len(header))


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.runs = {}
        self.primary = None
        self.remote = None

    def new_run(self):
        with self.lock:
            if len(self.runs) >= 32:
                raise ValueError("Run limit reached; restart the diagnostic server")
            token = str(uuid.uuid4())
            self.runs[token] = {"events": [], "errors": []}
            return token

    def record(self, run, event):
        with self.lock:
            if run not in self.runs:
                raise ValueError("Unknown run")
            result = self.runs[run]
            if len(result["events"]) >= 1000:
                if not result["errors"]:
                    result["errors"].append("Event limit reached; observations are incomplete")
                raise ValueError("Event limit reached")
            result["events"].append({**event, "time": time.time()})

    def result(self, run):
        with self.lock:
            if run not in self.runs:
                raise ValueError("Unknown run")
            return json.loads(json.dumps(self.runs[run]))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if len(args) < 2 or str(args[1]) not in ("200", "206"):
            super().log_message(fmt, *args)

    def reply(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def json_reply(self, status, value):
        self.reply(status, json.dumps(value).encode())

    def allowed(self):
        state = self.server.state
        hosts = {urlsplit(state.primary).netloc, urlsplit(state.remote).netloc}
        if self.headers.get("Host") not in hosts:
            self.json_reply(403, {"error": "Unexpected Host"})
            return False
        origin = self.headers.get("Origin")
        if self.command == "POST" and origin and origin != state.primary:
            self.json_reply(403, {"error": "Unexpected Origin"})
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/config":
            self.json_reply(200, {"remote": self.server.state.remote, "duration": DURATION})
        elif url.path == "/results":
            try:
                result = self.server.state.result(query.get("run", [""])[0])
            except ValueError as error:
                self.json_reply(400, {"error": str(error)})
                return
            self.json_reply(200, result)
        elif url.path == "/media.wav":
            self.media(query)
        elif url.path in ("/", "/index.html", "/client/frame.html", "/baseline/frame.html",
                          "/worker.js"):
            filename = {
                "/": "index.html", "/index.html": "index.html",
                "/client/frame.html": "frame.html", "/baseline/frame.html": "frame.html",
                "/worker.js": "worker.js",
            }[url.path]
            mime = "text/javascript" if filename.endswith(".js") else "text/html"
            self.reply(200, (ROOT / filename).read_bytes(), mime)
        else:
            self.json_reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.allowed():
            return
        length = self.headers.get("Content-Length", "")
        if not length.isdigit() or not 0 <= int(length) <= 8192:
            self.close_connection = True
            self.json_reply(400, {"error": "Expected bounded Content-Length"})
            return
        raw = self.rfile.read(int(length))
        try:
            if self.path == "/new-run":
                self.json_reply(200, {"run": self.server.state.new_run()})
                return
            if self.path != "/observe":
                self.json_reply(404, {"error": "Not found"})
                return
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get("event"), dict):
                raise ValueError("Expected run and event")
            self.server.state.record(data.get("run"), {**data["event"], "source": "service-worker"})
            self.json_reply(200, {"recorded": True})
        except (ValueError, TypeError) as error:
            self.json_reply(400, {"error": str(error)})

    def media(self, query):
        # Media loaders abort on seeks. Do not read another request on that socket.
        self.close_connection = True
        run = query.get("run", [""])[0]
        case = query.get("case", [""])[0]
        range_header = self.headers.get("Range")
        try:
            start, end = byte_range(range_header, TOTAL_SIZE)
            status = 206 if range_header is not None else 200
        except ValueError:
            start, end, status = 0, -1, 416
        try:
            self.server.state.record(run, {
                "source": "network", "case": case, "range": range_header,
                "status": status, "start": start, "end": end,
                "origin": self.headers.get("Origin"), "port": self.server.server_port,
            })
        except ValueError as error:
            self.json_reply(400, {"error": str(error)})
            return
        self.send_response(status)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("ETag", '"stable-silent-wav-v1"')
        self.send_header("Connection", "close")
        if query.get("cors") == ["1"]:
            self.send_header("Access-Control-Allow-Origin", self.server.state.primary)
            self.send_header("Vary", "Origin")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{TOTAL_SIZE}")
        elif status == 416:
            self.send_header("Content-Range", f"bytes */{TOTAL_SIZE}")
        self.end_headers()
        sent = 0
        termination = "complete"
        try:
            while start + sent <= end:
                size = min(16384, end - start - sent + 1)
                self.wfile.write(wav_bytes(start + sent, size))
                self.wfile.flush()
                sent += size
                time.sleep(0.02)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            termination = "client-disconnected"
        finally:
            try:
                self.server.state.record(run, {
                    "source": "network-completion", "case": case,
                    "range": range_header, "bytesWritten": sent, "termination": termination,
                })
            except ValueError as error:
                self.log_error("Could not record completion: %s", error)


def start_servers(port=0, remote_port=0):
    state = State()
    primary = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        remote = ThreadingHTTPServer(("127.0.0.1", remote_port), Handler)
    except OSError:
        primary.server_close()
        raise
    servers = [primary, remote]
    state.primary = f"http://127.0.0.1:{primary.server_port}"
    state.remote = f"http://127.0.0.1:{remote.server_port}"
    for server in servers:
        server.state = state
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return servers, state


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--remote-port", type=int, default=0)
    args = parser.parse_args()
    servers, state = start_servers(args.port, args.remote_port)
    print(f"Open {state.primary}/ in a disposable browser profile.", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("Stopping diagnostic servers.", flush=True)
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
