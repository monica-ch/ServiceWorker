import hashlib
import http.client
import io
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import server


class ReceiverTests(unittest.TestCase):
    def test_chunked_read_and_digest(self):
        body = b"x" * (server.receiver.CHUNK_BYTES + 7)
        with patch.object(server.receiver.time, "sleep") as sleep:
            result = server.receiver.receive(io.BytesIO(body), len(body))
        self.assertEqual(result["serverBytesRead"], len(body))
        self.assertEqual(result["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(sleep.call_count, 2)
        sleep.assert_called_with(0.04)

    def test_length_bounds_and_truncation(self):
        for length in (0, -1, server.receiver.MAX_BYTES + 1):
            with self.subTest(length=length), self.assertRaises(ValueError):
                server.receiver.receive(io.BytesIO(b""), length)
        with patch.object(server.receiver.time, "sleep"), self.assertRaisesRegex(ValueError, "Incomplete"):
            server.receiver.receive(io.BytesIO(b"x"), 2)

    def test_wpt_adapter(self):
        request = SimpleNamespace(method="POST", headers={b"Content-Length": b"3"}, raw_input=io.BytesIO(b"abc"))
        with patch.object(server.receiver.time, "sleep"):
            status, _, data = server.receiver.main(request, None)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["sha256"], hashlib.sha256(b"abc").hexdigest())
        request.headers[b"Content-Length"] = b"invalid"
        self.assertEqual(server.receiver.main(request, None)[0], 400)
        request.method = "GET"
        self.assertEqual(server.receiver.main(request, None)[0], 405)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = server.create_server()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_upload_and_framing(self):
        status, headers, body = self.request("POST", "/resources/upload_receiver.py?mode=fallback", b"abc")
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["Content-Length"]), len(body))
        self.assertEqual(json.loads(body)["serverBytesRead"], 3)
        self.assertEqual(json.loads(body)["sha256"], hashlib.sha256(b"abc").hexdigest())

    def test_static_and_missing_harness(self):
        self.assertEqual(self.request("GET", "/")[0], 200)
        self.assertIn(b"runUploadCase", self.request("GET", "/resources/probe.js")[2])
        self.assertEqual(self.request("GET", "/resources/testharness.js")[0], 404)
        self.assertEqual(self.request("GET", "/../server.py")[0], 404)

    def test_invalid_requests(self):
        self.assertEqual(self.request("POST", "/resources/upload_receiver.py", b"")[0], 400)
        self.assertEqual(self.request("POST", "/resources/upload_receiver.py", b"x",
                                      {"Origin": "https://example.invalid"})[0], 403)
        self.assertEqual(self.request("GET", "/", headers={"Host": "example.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/wrong", b"abc")[0], 404)


if __name__ == "__main__":
    unittest.main()
