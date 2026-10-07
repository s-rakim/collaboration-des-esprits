"""
Stand-ins for the routers, serving the routes they serve.

Not mocks of our own client: servers that answer the way each router's
documented surface answers. What is proven against them is that the room can
talk to those surfaces, which is the only claim worth making without the
routers installed.

Two shapes, because the routers genuinely differ. 9Router and My Claude Code
serve OpenAI's /chat/completions; Free Claude Code serves Anthropic's
/v1/messages and no /chat/completions at all, so pointing the room at it
without noticing would 404 every turn.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

MODELS = ["vendor/big", "vendor/small", "vendor/tts-1", "vendor/whisper-1", "vendor/image-1"]
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00fake audio"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class Handler(BaseHTTPRequestHandler):
    seen: list = []
    slow: float = 0.0

    def log_message(self, *_args):  # quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send(200, {"data": [{"id": m} for m in MODELS]})
        # How a real server answers a path that exists but takes POST, versus
        # one that does not exist at all. The difference is what tells the room
        # which shape this router speaks.
        if self.path.endswith("/chat/completions"):
            if Handler.shape == "messages":
                return self._send(404, {"error": {"message": "Not Found"}})
            return self._send(405, {"error": {"message": "Method Not Allowed"}})
        if self.path.endswith("/messages"):
            return self._send(405, {"error": {"message": "Method Not Allowed"}})
        self._send(404, {"error": {"message": "no"}})

    #: "chat" answers /chat/completions; "messages" refuses it the way a router
    #: that does not serve it does, and answers /messages instead.
    shape: str = "chat"

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        path = self.path.split("?")[0]
        ctype = self.headers.get("content-type", "")
        body = {}
        if ctype.startswith("application/json") and raw:
            body = json.loads(raw)
        Handler.seen.append({"path": path, "body": body})

        if Handler.slow:
            import time

            time.sleep(Handler.slow)

        if path.endswith("/chat/completions"):
            if Handler.shape == "messages":
                # What a router without this route actually says.
                return self._send(404, {"error": {"message": "Not Found"}})
            if body.get("model") not in MODELS:
                return self._send(404, {"detail": f"Function '{body.get('model')}': Not found for account 'x'"})
            # A turn that asks for a tool the first time and answers the second.
            asked_tool = any(m.get("role") == "tool" for m in body.get("messages", []))
            if body.get("tools") and not asked_tool:
                return self._send(200, {"choices": [{"finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": None,
                    "tool_calls": [{"id": "c1", "type": "function",
                                    "function": {"name": body["tools"][0]["function"]["name"],
                                                 "arguments": '{"q":"importer"}'}}]}}]})
            return self._send(200, {"choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "Postgres, because the importer needs transactions."}}]})

        if path.endswith("/messages"):
            if body.get("model") not in MODELS:
                return self._send(404, {"error": {"message": f'model {body.get("model")} not found'}})
            asked_tool = any(
                isinstance(m.get("content"), list)
                and any(b.get("type") == "tool_result" for b in m["content"])
                for m in body.get("messages", [])
            )
            if body.get("tools") and not asked_tool:
                return self._send(200, {
                    "stop_reason": "tool_use",
                    "content": [
                        {"type": "text", "text": "Let me look."},
                        {"type": "tool_use", "id": "c1",
                         "name": body["tools"][0]["name"], "input": {"q": "importer"}},
                    ],
                })
            return self._send(200, {
                "stop_reason": "end_turn",
                "content": [{"type": "text",
                             "text": "Postgres, because the importer needs transactions."}],
            })

        if path.endswith("/audio/speech"):
            return self._send(200, MP3, "audio/mpeg")
        if path.endswith("/audio/transcriptions"):
            return self._send(200, {"text": "ship the importer on Friday"})
        if path.endswith("/images/generations"):
            return self._send(200, {"data": [{"b64_json": base64.b64encode(PNG).decode()}]})
        self._send(404, {"error": {"message": "no such route"}})


class FakeRouter:
    def __init__(self, shape: str = "chat"):
        Handler.seen = []
        Handler.slow = 0.0
        Handler.shape = shape
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    @property
    def seen(self):
        return Handler.seen

    def be_slow(self, seconds):
        Handler.slow = seconds
