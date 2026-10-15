import http.client
import threading
import unittest

from server import create_server


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

    def test_explicit_static_resources(self):
        for path in ["/", "/index.html", "/probe.js", "/worker.js"]:
            with self.subTest(path=path):
                response, data = self.request(path)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Cache-Control"), "no-store")
                self.assertEqual(int(response.getheader("Content-Length")), len(data))

    def test_loaded_owner_under_unique_scope(self):
        response, data = self.request("/case-12345678-1234-1234-1234-123456789abc/owner.html?token=abc")
        self.assertEqual(response.status, 200)
        self.assertIn(b"dead-context-owner-ready", data)

    def test_unknown_paths_cannot_serve_arbitrary_files(self):
        for path in ["/server.py", "/../README.md", "/%2e%2e/README.md", "/case-no/owner.html"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0].status, 404)

    def test_foreign_host_rejected(self):
        self.assertEqual(self.request("/", host="example.com")[0].status, 403)


if __name__ == "__main__":
    unittest.main()
