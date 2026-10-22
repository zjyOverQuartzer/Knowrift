import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import socket
import time
import unittest
import urllib.error
import urllib.request
import uuid
from test_models import ModelServer


class ServiceTest(unittest.TestCase):
    def launch(self, version=1):
        child = subprocess.Popen([sys.executable, "-m", "knowrift_agent"], cwd=Path(__file__).resolve().parents[1],
                                 env={**os.environ, "PYTHONUTF8": "1"}, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.addCleanup(self.cleanup, child)
        token = uuid.uuid4().hex + uuid.uuid4().hex
        identity = str(uuid.uuid4())
        child.stdin.write(json.dumps({"token": token, "instanceId": identity, "protocolVersion": version}) + "\n")
        child.stdin.flush()
        return child, token, identity

    @staticmethod
    def cleanup(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()

    def ready(self, child):
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
        line = lines.get(timeout=15)
        self.assertTrue(line, "service exited before readiness")
        return json.loads(line)

    @staticmethod
    def request(ready, token, route="/health/ready", method="GET", body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{ready['port']}{route}", method=method,
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, data=json.dumps(body or {}).encode() if method == "POST" else None)
        # Local health must not be routed through system HTTP proxies.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5) as response:
            return json.load(response)

    def test_dynamic_port_health_auth_and_shutdown(self):
        child, token, identity = self.launch()
        ready = self.ready(child)
        self.assertGreater(ready["port"], 0)
        self.assertEqual(ready["instanceId"], identity)
        self.assertEqual(ready["protocolVersion"], 1)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(ready, "wrong")
        self.assertEqual(error.exception.code, 401)
        error.exception.close()
        self.assertTrue(self.request(ready, token)["ready"])
        self.assertTrue(self.request(ready, token, "/internal/shutdown", "POST")["stopping"])
        self.assertEqual(child.wait(timeout=10), 0)
        self.assertNotIn(token, child.stderr.read())

    def test_parent_pipe_close_stops_child(self):
        child, _, _ = self.launch()
        self.ready(child)
        child.stdin.close()
        self.assertEqual(child.wait(timeout=10), 0)

    def test_incompatible_protocol_never_ready(self):
        child, token, _ = self.launch(version=2)
        self.assertNotEqual(child.wait(timeout=10), 0)
        self.assertEqual(child.stdout.read(), "")
        self.assertNotIn(token, child.stderr.read())

    def test_model_route_auth_instance_and_credential_not_logged(self):
        remote = ModelServer(); self.addCleanup(remote.close)
        child, token, identity = self.launch(); ready = self.ready(child)
        key = "fixture-route-key-not-real"
        body = {"instanceId": identity, "apiKey": key, "profile": {"protocol": "openai-compatible", "baseUrl": remote.base, "model": "test"}}
        for supplied, payload, status in [("wrong", body, 401), (token, {**body, "instanceId": str(uuid.uuid4())}, 409)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(ready, supplied, "/internal/models/test", "POST", payload)
            self.assertEqual(error.exception.code, status); error.exception.close()
        self.assertEqual(remote.requests, [])
        result = self.request(ready, token, "/internal/models/test", "POST", body)
        self.assertTrue(result["ok"])
        self.request(ready, token, "/internal/shutdown", "POST")
        self.assertEqual(child.wait(timeout=10), 0)
        self.assertNotIn(key, child.stderr.read() + child.stdout.read())

    def test_shutdown_cancels_pending_model_request(self):
        remote = ModelServer(); remote.delay = 20; self.addCleanup(remote.close)
        child, token, identity = self.launch(); ready = self.ready(child)
        body = {"instanceId": identity, "apiKey": "", "profile": {"protocol": "ollama", "baseUrl": remote.base, "model": "waiting"}}
        results = queue.Queue()
        def invoke():
            try:
                results.put(self.request(ready, token, "/internal/models/test", "POST", body))
            except Exception as error:
                results.put(error)
        thread = threading.Thread(target=invoke, daemon=True); thread.start()
        self.assertTrue(remote.seen.wait(timeout=5))
        self.request(ready, token, "/internal/shutdown", "POST")
        self.assertEqual(child.wait(timeout=10), 0)
        thread.join(timeout=5); self.assertFalse(thread.is_alive())

    def test_caller_disconnect_releases_model_test_slot(self):
        remote = ModelServer(); remote.delay = 20; self.addCleanup(remote.close)
        child, token, identity = self.launch(); ready = self.ready(child)
        body = {"instanceId": identity, "apiKey": "", "profile": {"protocol": "ollama", "baseUrl": remote.base, "model": "waiting"}}
        raw = json.dumps(body).encode()
        client = socket.create_connection(("127.0.0.1", ready["port"]), timeout=5)
        self.addCleanup(client.close)
        client.sendall(f"POST /internal/models/test HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode() + raw)
        self.assertTrue(remote.seen.wait(timeout=5)); client.close()
        remote.delay = 0; remote.response = {"done": True, "message": {"content": "slot released"}}
        until = time.monotonic() + 4
        result = None
        while time.monotonic() < until:
            try:
                result = self.request(ready, token, "/internal/models/test", "POST", body)
                break
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 409); error.close(); time.sleep(.1)
        self.assertIsNotNone(result, "disconnected request must release the test slot")
        self.assertTrue(result["ok"])
        self.request(ready, token, "/internal/shutdown", "POST")
        self.assertEqual(child.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()
