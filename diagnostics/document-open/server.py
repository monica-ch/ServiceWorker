"""Explicit-route loopback server for the document.open observation diagnostic."""

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).parent
CASE_PATH = re.compile(r"/case-([0-9a-f-]{36})/(owner\.html|probe|written\.js)")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if len(args) < 2 or str(args[1]) != "200":
            super().log_message(fmt, *args)

    def do_GET(self):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            self.send_error(403, "Unexpected Host")
            return
        url = urlsplit(self.path)
        static = {"/": "index.html", "/index.html": "index.html",
                  "/probe.js": "probe.js", "/worker.js": "worker.js", "/owner.js": "owner.js"}
        filename = static.get(url.path)
        case = CASE_PATH.fullmatch(url.path)
        mime = "text/html; charset=utf-8"
        if case:
            token, resource = case.groups()
            if resource == "owner.html":
                filename = "owner.html"
            else:
                query = parse_qs(url.query)
                phase = query.get("phase", [""])[0]
                if query.get("token") != [token] or phase not in ("before", "written", "after"):
                    self.send_error(400, "Invalid probe token or phase")
                    return
                payload = json.dumps({"token": token, "phase": phase, "servedBy": "network"})
                if resource == "probe":
                    data = payload.encode()
                    mime = "application/json"
                else:
                    data = (
                        f"window.__tpac1313Written = {payload};\n"
                        "(opener || parent).postMessage({type:'document-open-script-executed',"
                        "...window.__tpac1313Written}, location.origin);\n"
                    ).encode()
                    mime = "text/javascript"
        if filename:
            data = (ROOT / filename).read_bytes()
            if filename.endswith(".js"):
                mime = "text/javascript"
        elif not case:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def create_server(port=0):
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8768)
    args = parser.parse_args()
    server = create_server(args.port)
    print(f"Open http://127.0.0.1:{server.server_port}/ in a disposable profile.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping document.open diagnostic.", flush=True)
    finally:
        server.server_close()
