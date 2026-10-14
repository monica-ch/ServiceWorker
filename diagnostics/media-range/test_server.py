import http.client
import io
import json
import unittest
import wave
from unittest.mock import patch
from urllib.parse import urlencode

import server


class FixtureTests(unittest.TestCase):
    def test_error_logging_with_one_argument(self):
        with patch.object(server.BaseHTTPRequestHandler, "log_message") as log:
            handler = server.Handler.__new__(server.Handler)
            handler.log_message("Could not record completion: %s", "limit reached")
        log.assert_called_once_with("Could not record completion: %s", "limit reached")

    def test_wav_is_valid_pcm(self):
        with wave.open(io.BytesIO(server.WAV_HEADER), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), 44100)
            self.assertEqual(wav.getnframes(), 44100 * 120)
        self.assertEqual(server.wav_bytes(0, 48), server.WAV_HEADER + bytes(4))
        self.assertEqual(server.wav_bytes(40, 10), server.WAV_HEADER[40:] + bytes(6))
        self.assertEqual(server.wav_bytes(100, 10), bytes(10))

    def test_single_ranges(self):
        for value, expected in [
            (None, (0, 99)), ("bytes=0-", (0, 99)), ("bytes=4-9", (4, 9)),
            ("bytes=90-200", (90, 99)), ("bytes=-10", (90, 99)),
            ("bytes=-200", (0, 99)), ("bytes=99-99", (99, 99)),
        ]:
            with self.subTest(value=value):
                self.assertEqual(server.byte_range(value, 100), expected)

    def test_invalid_or_unsatisfiable_ranges(self):
        for value in ["bytes=", "bytes=-", "bytes=-0", "bytes=100-", "bytes=9-4",
                      "items=0-1", "bytes=0-1,4-5", "bytes=a-b"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                server.byte_range(value, 100)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servers, cls.state = server.start_servers()

    @classmethod
    def tearDownClass(cls):
        for instance in cls.servers:
            instance.shutdown()
            instance.server_close()

    def request(self, method, path, body=None, headers=None, remote=False):
        instance = self.servers[1 if remote else 0]
        connection = http.client.HTTPConnection("127.0.0.1", instance.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def new_run(self):
        status, _, body = self.request("POST", "/new-run", b"")
        self.assertEqual(status, 200)
        return json.loads(body)["run"]

    def test_range_round_trip_and_server_observation(self):
        run = self.new_run()
        path = "/media.wav?" + urlencode({"run": run, "case": "test", "cors": "1"})
        status, headers, body = self.request("GET", path, headers={"Range": "bytes=0-43"}, remote=True)
        self.assertEqual(status, 206)
        self.assertEqual(body, server.WAV_HEADER)
        self.assertEqual(headers["Content-Range"], f"bytes 0-43/{server.TOTAL_SIZE}")
        self.assertEqual(headers["Content-Length"], "44")
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.state.primary)
        events = self.state.result(run)["events"]
        self.assertEqual(events[0]["range"], "bytes=0-43")
        self.assertEqual(events[0]["source"], "network")

    def test_suffix_and_416(self):
        run = self.new_run()
        path = "/media.wav?" + urlencode({"run": run, "case": "test"})
        status, headers, body = self.request("GET", path, headers={"Range": "bytes=-8"})
        self.assertEqual(status, 206)
        self.assertEqual(body, bytes(8))
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, headers, body = self.request("GET", path, headers={"Range": f"bytes={server.TOTAL_SIZE}-"})
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], f"bytes */{server.TOTAL_SIZE}")
        self.assertEqual(body, b"")

    def test_full_response_without_range(self):
        run = self.new_run()
        connection = http.client.HTTPConnection("127.0.0.1", self.servers[0].server_port, timeout=3)
        try:
            connection.request("GET", "/media.wav?" + urlencode({"run": run, "case": "full"}))
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Length"), str(server.TOTAL_SIZE))
            self.assertIsNone(response.getheader("Content-Range"))
            self.assertEqual(response.read(len(server.WAV_HEADER)), server.WAV_HEADER)
            self.assertIsNone(self.state.result(run)["events"][0]["range"])
        finally:
            connection.close()

    def test_unknown_run_and_invalid_input_are_errors(self):
        status, _, _ = self.request("GET", "/results?run=unknown")
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/observe", b"not json")
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/new-run", b"", {"Origin": "https://example.invalid"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/", headers={"Host": "example.invalid"})
        self.assertEqual(status, 403)

    def test_observation_record_and_finite_bounds(self):
        run = self.new_run()
        data = json.dumps({"run": run, "event": {"case": "test", "stage": "request", "range": None}})
        status, _, _ = self.request("POST", "/observe", data, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertIsNone(self.state.result(run)["events"][0]["range"])
        for _ in range(999):
            self.state.record(run, {"source": "test"})
        with self.assertRaises(ValueError):
            self.state.record(run, {"source": "overflow"})
        self.assertEqual(len(self.state.result(run)["events"]), 1000)
        self.assertTrue(self.state.result(run)["errors"])


if __name__ == "__main__":
    unittest.main()
