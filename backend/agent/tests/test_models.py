import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import unittest

from knowrift_agent.models import connection_test


class ModelServer:
    def __init__(self):
        owner = self
        self.requests = []
        self.status = 200
        self.response = {"choices": [{"message": {"content": "连接成功"}}]}
        self.delay = 0
        self.seen = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                owner.requests.append((self.path, dict(self.headers), body))
                delay = owner.delay
                owner.seen.set()
                time.sleep(delay)
                response = owner.response if isinstance(owner.response, bytes) else json.dumps(owner.response).encode()
                try:
                    self.send_response(owner.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response)))
                    if owner.status == 302:
                        self.send_header("Location", "/must-not-follow")
                    self.end_headers()
                    self.wfile.write(response)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.block_on_close = False
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ModelTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.remote = ModelServer()
        self.addCleanup(self.remote.close)

    def profile(self, protocol="openai-compatible", **extra):
        return {"protocol": protocol, "baseUrl": self.remote.base, "model": "模型-test", **extra}

    async def test_all_protocols_send_exact_path_body_and_credential(self):
        secret = "test-only-not-a-real-key"
        cases = [
            ("openai-compatible", "/chat/completions", {"choices": [{"message": {"content": [{"type": "text", "text": "成功"}]}}]}),
            ("anthropic", "/messages", {"content": [{"type": "thinking", "thinking": "ignored"}, {"type": "text", "text": "成功"}, {"type": "text", "text": "！"}]}),
            ("ollama", "/api/chat", {"message": {"content": "成功"}, "done": True})]
        for protocol, target, response in cases:
            self.remote.response = response
            result = await connection_test(self.profile(protocol, workspaceId="workspace-test"), secret)
            self.assertTrue(result["ok"], result)
            path, headers, body = self.remote.requests[-1]
            self.assertEqual(path, target)
            self.assertIs(body["stream"], False)
            self.assertEqual(body["model"], "模型-test")
            self.assertEqual(len(body["messages"]), 1)
            self.assertNotIn("enable_thinking", body)
            if protocol == "anthropic":
                self.assertEqual(headers["x-api-key"], secret)
                self.assertEqual(headers["anthropic-version"], "2023-06-01")
                self.assertEqual(headers["anthropic-workspace-id"], "workspace-test")
                self.assertEqual(body["max_tokens"], 1024)
            else:
                self.assertEqual(headers["Authorization"], "Bearer " + secret)
                self.assertNotIn("max_tokens", body)

    async def test_optional_local_key_and_anthropic_bearer(self):
        self.assertTrue((await connection_test(self.profile(), ""))["ok"])
        self.assertNotIn("Authorization", self.remote.requests[-1][1])
        self.remote.response = {"content": [{"type": "text", "text": "OK"}]}
        self.assertTrue((await connection_test(self.profile("anthropic", anthropicAuth="bearer"), "test-key"))["ok"])
        self.assertEqual(self.remote.requests[-1][1]["Authorization"], "Bearer test-key")
        self.assertNotIn("x-api-key", self.remote.requests[-1][1])

    async def test_upstream_errors_are_bounded_redacted_and_never_retried_or_redirected(self):
        for status, code in [(401, "MODEL_AUTH_FAILED"), (403, "MODEL_AUTH_FAILED"), (404, "MODEL_NOT_FOUND"), (429, "MODEL_RATE_LIMITED"), (500, "MODEL_UPSTREAM_ERROR"), (302, "MODEL_REDIRECT")]:
            self.remote.status = status
            self.remote.response = b"test-secret-with-sensitive-upstream-error"
            count = len(self.remote.requests)
            result = await connection_test(self.profile(), "test-secret")
            self.assertEqual(result["code"], code)
            self.assertEqual(len(self.remote.requests), count + 1)
            self.assertNotIn("test-secret", json.dumps(result))

    async def test_malformed_empty_and_oversized_responses(self):
        for response in [b"not json", [], {}, {"choices": [{"message": {"content": ""}}]}, b"x" * (1024 * 1024 + 1)]:
            self.remote.response = response
            self.assertEqual((await connection_test(self.profile(), ""))["code"], "MODEL_PROTOCOL_ERROR")
        self.remote.response = {"done": False, "message": {"content": "preview"}}
        self.assertEqual((await connection_test(self.profile("ollama"), ""))["code"], "MODEL_PROTOCOL_ERROR")

    async def test_total_deadline_and_preview_redaction(self):
        self.remote.delay = .4
        result = await connection_test(self.profile(), "", total_timeout=.06)
        self.assertEqual(result["code"], "MODEL_TIMEOUT")
        self.remote.delay = 0
        self.remote.response = {"choices": [{"message": {"content": "do-not-return-this-secret" + "x" * 500}}]}
        result = await connection_test(self.profile(), "do-not-return-this-secret")
        self.assertTrue(result["ok"])
        self.assertNotIn("do-not-return-this-secret", result["preview"])
        self.assertLessEqual(len(result["preview"]), 200)

    async def test_invalid_addresses_and_no_environment_key_fallback(self):
        for base in ["http://remote.example/v1", self.remote.base + "/api/chat", self.remote.base + "?secret=x", "https://user:pass@example.com", "https://example.com"]:
            result = await connection_test({**self.profile(), "baseUrl": base}, "")
            self.assertFalse(result["ok"])
        self.assertEqual(self.remote.requests, [])
