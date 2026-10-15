import http.client
import json
import threading
import unittest

from server import create_server

TOKEN = "12345678-1234-1234-1234-123456789abc"


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, host=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("GET", path, headers={"Host": host} if host else {})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response, data

    def test_explicit_static_files(self):
        for path in ["/", "/probe.js", "/owner.js", "/worker.js?token=x",
                     f"/case-{TOKEN}/owner.html?token={TOKEN}"]:
            with self.subTest(path=path):
                response, data = self.request(path)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Cache-Control"), "no-store")
                self.assertEqual(int(response.getheader("Content-Length")), len(data))

    def test_network_fetch_echo(self):
        response, data = self.request(f"/case-{TOKEN}/probe?token={TOKEN}&phase=after")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/json")
        self.assertEqual(json.loads(data), {"token": TOKEN, "phase": "after", "servedBy": "network"})

    def test_written_script(self):
        response, data = self.request(f"/case-{TOKEN}/written.js?token={TOKEN}&phase=written")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/javascript")
        self.assertIn(b"document-open-script-executed", data)
        self.assertIn(TOKEN.encode(), data)

    def test_invalid_probe_input(self):
        for query in ["token=bad&phase=written", f"token={TOKEN}&phase=unknown",
                      f"token={TOKEN}&token=duplicate&phase=before"]:
            with self.subTest(query=query):
                self.assertEqual(self.request(f"/case-{TOKEN}/written.js?{query}")[0].status, 400)

    def test_routes_and_host(self):
        for path in ["/server.py", "/../README.md", "/%2e%2e/README.md", "/case-invalid/probe"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0].status, 404)
        self.assertEqual(self.request("/", host="example.com")[0].status, 403)


if __name__ == "__main__":
    unittest.main()
