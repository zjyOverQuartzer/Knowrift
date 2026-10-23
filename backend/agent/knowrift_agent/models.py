"""Small non-streaming protocol adapters. No credentials or upstream bodies are logged."""
import asyncio
import ssl
import time
from urllib.parse import urlsplit

import httpx

PROMPT = "请只回复：连接成功"
PROTOCOLS = {"openai-compatible": "/chat/completions", "anthropic": "/messages", "ollama": "/api/chat"}


class ModelError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def validate(profile, key):
    if not isinstance(profile, dict) or profile.get("protocol") not in PROTOCOLS:
        raise ModelError("INVALID_INPUT", "模型协议无效")
    base, model = profile.get("baseUrl"), profile.get("model")
    if (not isinstance(base, str) or len(base) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in base)
            or not isinstance(model, str) or not model.strip() or len(model) > 200):
        raise ModelError("INVALID_INPUT", "基础地址或模型标识无效")
    try:
        url = urlsplit(base)
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment
                or (url.scheme != "https" and not (url.scheme == "http" and local))
                or url.port == 0 or url.path.endswith(tuple(PROTOCOLS.values()))):
            raise ValueError()
    except ValueError:
        raise ModelError("INVALID_INPUT", "模型基础地址无效；远程需使用 HTTPS，本机回环地址可使用 HTTP") from None
    if not isinstance(key, str) or len(key) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in key):
        raise ModelError("INVALID_INPUT", "密钥格式无效")
    if not local and not key:
        raise ModelError("CREDENTIAL_UNAVAILABLE", "远程模型服务需要密钥")
    if profile.get("anthropicAuth", "x-api-key") not in {"x-api-key", "bearer"}:
        raise ModelError("INVALID_INPUT", "Anthropic 鉴权方式无效")
    workspace = profile.get("workspaceId", "")
    if not isinstance(workspace, str) or len(workspace) > 200 or any(ord(c) < 32 or ord(c) == 127 for c in workspace):
        raise ModelError("INVALID_INPUT", "工作区标识无效")
    return base.rstrip("/") + PROTOCOLS[profile["protocol"]]


def request_parameters(profile, key):
    target = validate(profile, key)
    protocol = profile["protocol"]
    headers = {"Content-Type": "application/json"}
    body = {"model": profile["model"], "messages": [{"role": "user", "content": PROMPT}], "stream": False}
    if protocol == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
        if profile.get("workspaceId"):
            headers["anthropic-workspace-id"] = profile["workspaceId"]
        body["max_tokens"] = 1024
        if key:
            if profile.get("anthropicAuth", "x-api-key") == "x-api-key":
                headers["x-api-key"] = key
            else:
                headers["Authorization"] = "Bearer " + key
    elif key:
        headers["Authorization"] = "Bearer " + key
    return target, headers, body


def response_text(protocol, data):
    try:
        if protocol == "openai-compatible":
            content = data["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(part["text"] for part in content if part.get("type") == "text")
        elif protocol == "anthropic":
            content = "".join(part["text"] for part in data["content"] if part.get("type") == "text")
        else:
            if data.get("done") is not True:
                raise ValueError()
            content = data["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError()
        return content.strip()
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        raise ModelError("MODEL_PROTOCOL_ERROR", "接口返回了响应，但未获得该协议的有效文本；请核对协议、模型标识及输出设置") from None


def status_error(status):
    if status in {401, 403}:
        return ModelError("MODEL_AUTH_FAILED", "模型服务拒绝访问，请检查密钥及模型权限")
    if status == 404:
        return ModelError("MODEL_NOT_FOUND", "模型或接口路径不存在，请检查最终请求地址、模型标识及工作区")
    if status == 429:
        return ModelError("MODEL_RATE_LIMITED", "模型服务限流或额度不足，请检查提供商账户后手动重试")
    if 300 <= status < 400:
        return ModelError("MODEL_REDIRECT", "模型接口返回重定向，请直接填写最终服务的基础地址")
    if status in {400, 422}:
        return ModelError("MODEL_REQUEST_REJECTED", "模型服务不接受请求，请检查协议、模型标识及 Anthropic 工作区设置")
    return ModelError("MODEL_UPSTREAM_ERROR", "模型服务暂时无法完成请求，请稍后手动重试")


async def connection_test(profile, key, *, total_timeout=60):
    started = time.monotonic()
    result = {"ok": False, "code": "MODEL_NETWORK_ERROR", "message": "模型网络连接失败", "preview": ""}
    try:
        target, headers, body = request_parameters(profile, key)
        # Loopback must never use a proxy. Remote calls may use standard proxy/CA environment settings.
        local = urlsplit(target).hostname in {"localhost", "127.0.0.1", "::1"}
        async with asyncio.timeout(total_timeout):
            async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10, write=10, pool=5),
                                         follow_redirects=False, trust_env=not local) as client:
                async with client.stream("POST", target, headers=headers, json=body) as response:
                    if response.status_code != 200:
                        raise status_error(response.status_code)
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > 1024 * 1024:
                            raise ModelError("MODEL_PROTOCOL_ERROR", "模型响应过大，请核对接口与模型配置")
                        chunks.append(chunk)
                    import json
                    try:
                        data = json.loads(b"".join(chunks))
                    except (ValueError, UnicodeError):
                        raise ModelError("MODEL_PROTOCOL_ERROR", "模型接口未返回有效 JSON，请核对最终请求地址") from None
        text = response_text(profile["protocol"], data)
        if key:
            text = text.replace(key, "[已隐藏]")
        result.update(ok=True, code="OK", message="已获得模型文本回复", preview=text[:200])
    except ModelError as error:
        result.update(code=error.code, message=error.message)
    except (TimeoutError, httpx.TimeoutException):
        result.update(code="MODEL_TIMEOUT", message="模型请求超时；本地模型首次加载可能较慢，请检查后手动重试")
    except httpx.ConnectError as error:
        cause = error
        while cause.__cause__ is not None:
            cause = cause.__cause__
        if isinstance(cause, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(error):
            result.update(code="MODEL_TLS_ERROR", message="模型服务证书校验失败，请检查服务地址、证书及系统时间")
    except (httpx.HTTPError, OSError, ValueError):
        pass
    result["latencyMs"] = round((time.monotonic() - started) * 1000)
    return result
