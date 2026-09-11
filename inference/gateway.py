"""Small authenticated Ollama gateway. No provider secrets or conversation logs."""
import hmac
import json
import os
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = "mannix/llama3.1-8b-abliterated:q5_k_m"
KEY = Path(os.environ.get("MODEL_GATEWAY_KEY_FILE", "secrets/model_gateway_key")).read_text().strip()
if len(KEY) < 32:
    raise SystemExit("Create a random gateway key of at least 32 characters.")
CAPACITY = threading.BoundedSemaphore(1)

class Gateway(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass
    def reply(self, code, message):
        data = json.dumps({"error": message}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True
    def do_GET(self):
        self.proxy()
    def do_POST(self):
        self.proxy()
    def proxy(self):
        self.connection.settimeout(140)
        auth = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth.encode(), ("Bearer " + KEY).encode()):
            self.reply(401, "Unauthorized")
            return
        if (self.command, self.path) not in {("GET", "/api/tags"), ("POST", "/api/chat")}:
            self.reply(404, "Not found")
            return
        payload = None
        if self.command == "POST":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get("Transfer-Encoding") or not 0 < length <= 65536:
                    raise ValueError()
                value = json.loads(self.rfile.read(length))
                if value.get("model") != MODEL or not isinstance(value.get("messages"), list):
                    raise ValueError()
                if len(value["messages"]) > 52:
                    raise ValueError()
                options = value.get("options") or {}
                value["options"] = {
                    "num_ctx": min(max(int(options.get("num_ctx", 8192)), 512), 8192),
                    "num_predict": min(max(int(options.get("num_predict", 512)), 1), 2048),
                    "temperature": min(max(float(options.get("temperature", 0.8)), 0), 1.5),
                    "top_k": 64,
                    "top_p": 0.95,
                }
                value["stream"] = True
                value["keep_alive"] = "10m"
                value.pop("tools", None)
                value.pop("think", None)
                payload = json.dumps(value).encode()
            except (ValueError, TypeError, AttributeError):
                self.reply(400, "Invalid companion request")
                return
        if not CAPACITY.acquire(blocking=False):
            self.reply(429, "The model is busy. Retry shortly.")
            return
        started = False
        try:
            upstream_request = urllib.request.Request(OLLAMA_URL + self.path, data=payload, method=self.command, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(upstream_request, timeout=125) as upstream:
                self.send_response(200)
                self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/x-ndjson"))
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                started = True
                while chunk := upstream.read1(16384):
                    self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except urllib.error.HTTPError as error:
            if not started:
                self.reply(error.code, "Ollama could not serve the request")
        except Exception:
            if not started:
                self.reply(502, "Ollama is unavailable")
            else:
                self.close_connection = True
        finally:
            CAPACITY.release()

if __name__ == "__main__":
    print("Authenticated Llama 3.1 abliterated gateway listening on port 8080.")
    ThreadingHTTPServer(("0.0.0.0", 8080), Gateway).serve_forever()
