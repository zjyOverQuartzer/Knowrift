import asyncio
import hmac
import json
import socket
import sys
import threading

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


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


    @app.get("/health/ready")
    async def ready():
        return {"ready": True, "service": "python", "instanceId": config["instanceId"], "protocolVersion": 1}

    @app.post("/internal/shutdown")
    async def shutdown():
        server.should_exit = True
        return {"stopping": True}


    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, timeout_graceful_shutdown=5))

    def watch_parent():
        try:
            for _ in sys.stdin:
                pass
        finally:
            server.should_exit = True

    threading.Thread(target=watch_parent, name="parent-pipe", daemon=True).start()

    async def serve():
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
