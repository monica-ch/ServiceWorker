"""Loopback-only upload diagnostic. Run: python server.py --port 0."""

import argparse
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("upload_receiver", ROOT / "resources" / "upload_receiver.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
STATIC = {
    "/": ("index.html", "text/html"),
    "/index.html": ("index.html", "text/html"),
    "/resources/frame.html": ("resources/frame.html", "text/html"),
    "/resources/probe.js": ("resources/probe.js", "text/javascript"),
    "/resources/worker.js": ("resources/worker.js", "text/javascript"),
    "/xhr-upload-baseline.https.html": ("xhr-upload-baseline.https.html", "text/html"),
    "/xhr-upload-passthrough.tentative.https.html": ("xhr-upload-passthrough.tentative.https.html", "text/html"),
}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        if len(args) < 2 or str(args[1]) != "200":
            super().log_message(fmt, *args)

    def reply(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error(self, status, message):
        self.reply(status, json.dumps({"error": message}).encode())

    def allowed(self):
        host = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != host:
            self.error(403, "Unexpected Host")
            return False
        if self.command == "POST" and self.headers.get("Origin") not in (None, f"http://{host}"):
            self.error(403, "Unexpected Origin")
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path in STATIC:
            name, mime = STATIC[path]
            self.reply(200, (ROOT / name).read_bytes(), mime)
        elif path in ("/resources/testharness.js", "/resources/testharnessreport.js"):
            directory = self.server.wpt_resources
            if directory is None or not (directory / Path(path).name).is_file():
                self.error(404, "WPT harness unavailable; use a WPT checkout or --wpt-resources")
                return
            self.reply(200, (directory / Path(path).name).read_bytes(), "text/javascript")
        else:
            self.error(404, "Not found")

    def do_POST(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path != "/resources/upload_receiver.py":
            self.error(404, "Not found")
            return
        if self.headers.get("Transfer-Encoding"):
            self.error(400, "This fixture requires Content-Length, not Transfer-Encoding")
            return
        try:
            result = receiver.receive(self.rfile, int(self.headers.get("Content-Length", "0")))
        except (ValueError, TimeoutError) as error:
            self.error(400, str(error))
            return
        self.reply(200, json.dumps(result).encode())


def create_server(port=0, wpt_resources=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.wpt_resources = Path(wpt_resources) if wpt_resources else None
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--wpt-resources", type=Path, help="Optional directory containing official WPT harness JS")
    args = parser.parse_args()
    server = create_server(args.port, args.wpt_resources)
    print(f"Open http://127.0.0.1:{server.server_port}/ in a disposable profile.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping upload diagnostic server.", flush=True)
    finally:
        server.server_close()
