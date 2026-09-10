import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        keyfile = Path(cls.temp.name) / "key"
        keyfile.write_text("test-key-" * 8)
        cls.key = keyfile.read_text()
        cls.received = []
        owner = cls
        class FakeOllama(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                payload = json.dumps({"models": [{"name": "gemma4-heretical:latest"}]}).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.received.append(data)
                payload = b'{"message":{"content":"Hello."},"done":true}\n'
                self.send_response(200); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
        os.environ["MODEL_GATEWAY_KEY_FILE"] = str(keyfile)
        os.environ["OLLAMA_URL"] = "http://127.0.0.1:" + str(cls.upstream.server_port)
        spec = importlib.util.spec_from_file_location("gateway", Path(__file__).resolve().parents[1] / "inference/gateway.py")
        cls.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.module)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), cls.module.Gateway)
        for server in [cls.upstream, cls.server]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.upstream.shutdown()
        cls.server.server_close(); cls.upstream.server_close(); cls.temp.cleanup()
    def request(self, path, data=None, key=True):
        headers = {"Authorization": "Bearer " + self.key} if key else {}
        return urllib.request.urlopen(urllib.request.Request(self.url + path, data=json.dumps(data).encode() if data is not None else None, headers=headers), timeout=5)
    def test_unauthorized(self):
        with self.assertRaises(urllib.error.HTTPError) as e: self.request("/api/tags", key=False)
        self.assertEqual(e.exception.code, 401)
    def test_installed_model(self):
        with self.request("/api/tags") as r: self.assertEqual(json.load(r)["models"][0]["name"], "gemma4-heretical:latest")
    def test_no_model_management_proxy(self):
        with self.assertRaises(urllib.error.HTTPError) as e: self.request("/api/pull", {"model": "other"})
        self.assertEqual(e.exception.code, 404)
    def test_model_and_context_bounds(self):
        payload = {"model": "gemma4-heretical", "messages": [{"role": "user", "content": "Hi"}], "options": {"num_ctx": 100000, "num_predict": 9000}}
        with self.request("/api/chat", payload) as r:
            self.assertIn(b"Hello.", r.read())
        self.assertEqual(self.received[-1]["options"]["num_ctx"], 8192)
        self.assertEqual(self.received[-1]["options"]["num_predict"], 2048)
        payload["model"] = "other"
        with self.assertRaises(urllib.error.HTTPError) as e: self.request("/api/chat", payload)
        self.assertEqual(e.exception.code, 400)
    def test_busy(self):
        self.module.CAPACITY.acquire()
        try:
            with self.assertRaises(urllib.error.HTTPError) as e: self.request("/api/tags")
            self.assertEqual(e.exception.code, 429)
        finally: self.module.CAPACITY.release()

if __name__ == "__main__": unittest.main()
