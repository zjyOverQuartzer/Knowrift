import asyncio
import hmac
import json
import socket
import sys
import threading

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .models import connection_test


class AccessTokenMiddleware:
    """Preserve the raw ASGI receive channel for reliable disconnect detection."""
    def __init__(self, app, token):
        self.app = app
        self.expected = ("Bearer " + token).encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            supplied = dict(scope.get("headers", [])).get(b"authorization", b"")
            if not hmac.compare_digest(supplied, self.expected):
                response = JSONResponse({"code": "UNAUTHORIZED", "message": "本机服务访问凭据无效"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def main():
    config = json.loads(sys.stdin.readline())
    if (config.get("protocolVersion") != 1 or not isinstance(config.get("token"), str)
            or len(config["token"]) < 32 or not isinstance(config.get("instanceId"), str)):
        raise ValueError("Invalid bootstrap configuration")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(AccessTokenMiddleware, token=config["token"])
    server = None
    tests = set()
    loop = None

    def cancel_tests():
        for task in tuple(tests):
            task.cancel()

    @app.get("/health/ready")
    async def ready():
        return {"ready": True, "service": "python", "instanceId": config["instanceId"], "protocolVersion": 1}

    @app.post("/internal/shutdown")
    async def shutdown():
        cancel_tests()
        server.should_exit = True
        return {"stopping": True}

    @app.post("/internal/models/test")
    async def test_model(request: Request):
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            return JSONResponse({"code": "INVALID_INPUT", "message": "测试请求格式无效"}, status_code=400)
        if not isinstance(body, dict) or body.get("instanceId") != config["instanceId"]:
            return JSONResponse({"code": "INSTANCE_MISMATCH", "message": "智能服务实例已变化"}, status_code=409)
        if tests:
            return JSONResponse({"code": "TEST_BUSY", "message": "已有连接测试正在进行"}, status_code=409)
        task = asyncio.create_task(connection_test(body.get("profile"), body.get("apiKey", "")))
        tests.add(task)
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=.1)
                if not task.done() and await request.is_disconnected():
                    task.cancel()
                    return JSONResponse({"code": "TEST_CANCELLED", "message": "调用方已断开连接"}, status_code=503)
            return await task
        except asyncio.CancelledError:
            return JSONResponse({"code": "TEST_CANCELLED", "message": "连接测试已随服务关闭取消"}, status_code=503)
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            tests.discard(task)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, timeout_graceful_shutdown=5))

    def watch_parent():
        try:
            for _ in sys.stdin:
                pass
        finally:
            if loop is not None:
                loop.call_soon_threadsafe(cancel_tests)
            server.should_exit = True

    threading.Thread(target=watch_parent, name="parent-pipe", daemon=True).start()

    async def serve():
        nonlocal loop
        loop = asyncio.get_running_loop()
        task = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started and not task.done():
            await asyncio.sleep(0.01)
        if server.started:
            print(json.dumps({"type": "ready", "service": "python", "port": sock.getsockname()[1],
                              "instanceId": config["instanceId"], "protocolVersion": 1}), flush=True)
        await task

    try:
        asyncio.run(serve())
    finally:
        sock.close()


if __name__ == "__main__":
    main()
