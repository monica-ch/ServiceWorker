"""Loopback-only retained ServiceWorkerContainer diagnostic server."""

import argparse
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).parent


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if len(args) < 2 or str(args[1]) != "200":
            super().log_message(fmt, *args)

    def do_GET(self):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            self.send_error(403, "Unexpected Host")
            return
        path = urlsplit(self.path).path
        files = {"/": "index.html", "/index.html": "index.html",
                 "/probe.js": "probe.js", "/worker.js": "worker.js"}
        filename = files.get(path)
        if re.fullmatch(r"/case-[0-9a-f-]{36}/owner\.html", path):
            filename = "owner.html"
        if not filename:
            self.send_error(404, "Not found")
            return
        data = (ROOT / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript" if filename.endswith(".js") else "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def create_server(port=0):
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    server = create_server(args.port)
    print(f"Open http://127.0.0.1:{server.server_port}/ in a disposable profile.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping dead-context diagnostic server.", flush=True)
    finally:
        server.server_close()
