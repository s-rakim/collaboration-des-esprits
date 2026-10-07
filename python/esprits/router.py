"""
The way out of the room.

Everything this app needs from the outside world — a model that talks, a voice,
an ear, a picture — goes to a local router standing in front of whatever
providers you have given it. There are several of these and they are
interchangeable in principle, so the room asks one address and stops guessing
about keys, headers and the spelling of "model".

In practice they are not quite interchangeable, which is the one thing this
file has to know. Two request shapes are in use:

* **chat** — OpenAI's ``/chat/completions``. 9Router and My Claude Code serve it.
* **messages** — Anthropic's ``/v1/messages``. Free Claude Code serves only
  this one and ``/responses``; it has no ``/chat/completions`` at all.

So the shape is discovered rather than assumed, and a turn is built for
whichever one answered. Everything above this file sees the same ``Turn``
either way.

**Nothing here holds an API key for a provider.** The router does, in its own
dashboard, where it can validate and rotate them.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

import httpx

#: The routers this room knows how to start from, read from routers.json so the
#: two runtimes cannot disagree about where each listens or which shape it
#: speaks. Not a closed list — any address can be typed in — but these three are
#: worth offering by name, and MCC and FCC both default to 8082 as shipped, so
#: they cannot both be running untouched.
_CATALOGUE = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "routers.json").read_text(encoding="utf-8")
)
ROUTERS: dict[str, dict] = _CATALOGUE["routers"]
ROUTER_ORDER: list[str] = _CATALOGUE["order"]

DEFAULT_BASE = ROUTERS[ROUTER_ORDER[0]]["base"]
TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

# Long enough for a model that thinks before it speaks, short enough that a dead
# endpoint is reported rather than waited on forever.
PROBE_TIMEOUT = httpx.Timeout(12.0)


def base_url() -> str:
    """Where MCC is listening, overridable for a non-default install."""
    return (os.environ.get("ESPRITS_ROUTER") or os.environ.get("ESPRITS_MCC")
            or DEFAULT_BASE).rstrip("/")


class Unreachable(RuntimeError):
    """MCC is not answering — which is a different problem from a bad call."""


class Interrupted(RuntimeError):
    """The turn was cut off on purpose. Not a failure to report as one."""


class ProviderError(RuntimeError):
    """MCC answered, and the answer was no."""


def _explain(status: int, body: str) -> str:
    """
    Say what a refusal means, in a sentence.

    Providers answer failures with their own JSON, and showing that verbatim
    hands somebody a function UUID and an account hash to read past before they
    reach the one word that matters.
    """
    text = (body or "").strip()
    try:
        parsed = json.loads(text)
        found = None
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, dict):
                found = err.get("message")
            elif isinstance(err, str):
                found = err
            found = found or parsed.get("message") or parsed.get("detail") or parsed.get("title")
        if isinstance(found, str):
            text = found
    except (ValueError, TypeError):
        text = re.sub(r"<[^>]*>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
    text = text[:300]
    return f"{status}: {text}" if text else f"HTTP {status}"


@dataclass(slots=True)
class Step:
    """One exchange with a model: what it said, and what it wants run."""

    stop_reason: str
    text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


class Turn:
    """
    One conversation with a model, held open across tool calls.

    The transcript lives here rather than being rebuilt by the caller, because
    tool results have to attach to the call ids that asked for them, and that is
    the kind of bookkeeping that goes wrong quietly.
    """

    def __init__(self, client: "MCC", model: str, system: str, tools: list[dict[str, Any]]) -> None:
        self._client = client
        self._model = model
        self._messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        self._tools = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "object", "properties": {}}),
                },
            }
            for t in tools
        ]
        # One flag for the whole turn, so "stop" reaches the request in flight
        # rather than only the next one that has not started.
        self._stopped = False
        self._in_flight: asyncio.Task[Any] | None = None

    @property
    def aborted(self) -> bool:
        return self._stopped

    def abort(self) -> None:
        """Cut the turn off wherever it is."""
        self._stopped = True
        if self._in_flight and not self._in_flight.done():
            self._in_flight.cancel()

    def sent(self) -> list[dict[str, Any]]:
        return list(self._messages)

    async def send(self, text: str) -> Step:
        self._messages.append({"role": "user", "content": text})
        return await self._request()

    async def tool_results(self, results: Iterable[dict[str, Any]]) -> Step:
        # One message per result, keyed by the call it answers.
        for r in results:
            self._messages.append(
                {"role": "tool", "tool_call_id": r["id"], "content": r["output"]}
            )
        return await self._request()

    async def _request(self) -> Step:
        if self._stopped:
            raise Interrupted("stopped")

        shape = await self._client.shape()
        path, payload = (
            self._as_chat() if shape == "chat" else self._as_messages()
        )

        task = asyncio.ensure_future(self._client.post(path, payload))
        self._in_flight = task
        try:
            body = await task
        except asyncio.CancelledError as exc:
            raise Interrupted("stopped") from exc
        finally:
            self._in_flight = None

        if self._stopped:
            raise Interrupted("stopped")

        return self._read_chat(body) if shape == "chat" else self._read_messages(body)

    # ------------------------------------------------------- the OpenAI shape

    def _as_chat(self):
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": self._messages,
            # The spelling nearly every endpoint takes. Wrong, it is ignored
            # rather than refused, so no cap applies and a reasoning model
            # writes until its own default — which reads as the endpoint hanging.
            "max_tokens": self._client.max_tokens,
        }
        if self._tools:
            payload["tools"] = self._tools
            payload["tool_choice"] = "auto"
        if self._client.effort:
            payload["reasoning_effort"] = self._client.effort
        return "/chat/completions", payload

    def _read_chat(self, body) -> Step:
        choices = body.get("choices") or []
        if not choices:
            raise ProviderError("the model returned no choices")
        choice = choices[0]
        message = choice.get("message") or {}

        # Echoed back so the tool results that follow attach to the right calls.
        echoed: dict[str, Any] = {"role": "assistant", "content": message.get("content")}
        if message.get("tool_calls"):
            echoed["tool_calls"] = message["tool_calls"]
        self._messages.append(echoed)

        finish = choice.get("finish_reason")
        if finish == "length":
            return Step("max_tokens")
        if finish == "content_filter":
            return Step("refusal")

        calls = []
        for c in message.get("tool_calls") or []:
            fn = c.get("function") or {}
            raw = fn.get("arguments") or ""
            try:
                # Arguments arrive as a JSON string and can be malformed or
                # truncated; a parse failure must not take the turn down.
                parsed = json.loads(raw) if raw else {}
            except ValueError:
                parsed = {"__malformed": raw}
            calls.append({"id": c.get("id"), "name": fn.get("name"), "input": parsed})

        return Step(
            "tool_use" if calls else "end_turn",
            (message.get("content") or "").strip(),
            calls,
        )

    # ---------------------------------------------------- the Anthropic shape

    def _as_messages(self):
        """
        The same turn, in the shape Free Claude Code serves.

        Three differences do the work. The system prompt is a top-level field
        rather than the first message. Tool results are content blocks on a user
        message rather than messages of their own. And a tool's schema is
        ``input_schema`` rather than nested under ``function``.
        """
        system = ""
        turns: list[dict[str, Any]] = []
        for m in self._messages:
            role = m.get("role")
            if role == "system":
                system = m.get("content") or ""
            elif role == "tool":
                block = {
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id"),
                    "content": m.get("content") or "",
                }
                # Consecutive results belong to one user message, because
                # Anthropic alternates roles strictly and a run of user
                # messages is refused.
                if turns and turns[-1]["role"] == "user" and isinstance(turns[-1]["content"], list):
                    turns[-1]["content"].append(block)
                else:
                    turns.append({"role": "user", "content": [block]})
            elif role == "assistant":
                content: list[dict[str, Any]] = []
                if m.get("content"):
                    content.append({"type": "text", "text": m["content"]})
                for c in m.get("tool_calls") or []:
                    fn = c.get("function") or {}
                    raw = fn.get("arguments") or "{}"
                    try:
                        parsed = json.loads(raw) if isinstance(raw, str) else raw
                    except ValueError:
                        parsed = {}
                    content.append({
                        "type": "tool_use", "id": c.get("id"),
                        "name": fn.get("name"), "input": parsed,
                    })
                turns.append({"role": "assistant", "content": content or [{"type": "text", "text": ""}]})
            else:
                turns.append({"role": "user", "content": m.get("content") or ""})

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": turns,
            "max_tokens": self._client.max_tokens,
        }
        if system:
            payload["system"] = system
        if self._tools:
            payload["tools"] = [
                {
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "input_schema": t["function"].get("parameters") or {"type": "object"},
                }
                for t in self._tools
            ]
        return "/messages", payload

    def _read_messages(self, body) -> Step:
        blocks = body.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
        uses = [b for b in blocks if b.get("type") == "tool_use"]

        # Kept in the OpenAI shape internally, so one transcript serves both and
        # a router swapped mid-conversation does not lose the history.
        echoed: dict[str, Any] = {"role": "assistant", "content": text or None}
        if uses:
            echoed["tool_calls"] = [
                {
                    "id": u.get("id"),
                    "type": "function",
                    "function": {"name": u.get("name"), "arguments": json.dumps(u.get("input") or {})},
                }
                for u in uses
            ]
        self._messages.append(echoed)

        stop = body.get("stop_reason")
        if stop == "max_tokens":
            return Step("max_tokens")
        if stop == "refusal":
            return Step("refusal")

        calls = [
            {"id": u.get("id"), "name": u.get("name"), "input": u.get("input") or {}}
            for u in uses
        ]
        return Step("tool_use" if calls else "end_turn", text, calls)


class Router:
    """
    A client for one local router.

    There is no provider API key here, and that is the point: the router holds
    those, in its own dashboard, where it can validate and rotate them. Nothing
    in this room ever stores one.

    Some routers want a token of their own on the way in — that is a different
    thing from a provider key, and it is the only credential this class carries.
    """

    def __init__(
        self,
        base: str | None = None,
        *,
        max_tokens: int = 4096,
        effort: str | None = None,
        token: str | None = None,
        shape: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base = (base or base_url()).rstrip("/")
        self.max_tokens = max_tokens
        self.effort = effort
        self.token = token or os.environ.get("ESPRITS_ROUTER_TOKEN") or None
        self._shape = shape
        self._client = client
        self._owned = client is None

    def headers(self) -> dict[str, str]:
        if not self.token:
            return {}
        # Both spellings, because which one a router reads depends on which
        # shape it is imitating, and sending the pair costs nothing.
        return {"authorization": f"Bearer {self.token}", "x-api-key": self.token}

    async def shape(self) -> str:
        """
        Which request shape this router serves.

        Asked once and remembered. It cannot be assumed from the address: Free
        Claude Code and My Claude Code both listen on 8082 as shipped, and one
        of them has no /chat/completions at all.
        """
        if self._shape:
            return self._shape

        http = await self._http()
        try:
            # Asked with GET, which is the one question whose answer cannot mean
            # anything else. A path that exists but takes POST answers 405
            # "method not allowed"; a path that does not exist answers 404. A
            # POST would have been ambiguous — a 404 could equally be the router
            # saying it has no such model — and nothing is generated either way.
            res = await http.get(
                f"{self.base}/chat/completions", headers=self.headers(), timeout=PROBE_TIMEOUT,
            )
            self._shape = "messages" if res.status_code == 404 else "chat"
        except httpx.RequestError:
            # Unreachable is not an answer about shape, so nothing is cached and
            # the real call reports the real problem.
            return "chat"
        return self._shape

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=TIMEOUT)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owned:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------ asking

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        http = await self._http()
        try:
            res = await http.post(f"{self.base}{path}", json=payload, headers=self.headers())
        except httpx.RequestError as exc:
            raise Unreachable(
                f"nothing is answering at {self.base} — start your router"
                f" (9router, fcc or mcc-server) and check its dashboard is up"
                f" ({exc.__class__.__name__})"
            ) from exc
        if res.status_code >= 400:
            raise ProviderError(_explain(res.status_code, res.text))
        return res.json()

    async def models(self) -> list[str]:
        """Everything MCC can reach today, which is its owner's business."""
        http = await self._http()
        try:
            res = await http.get(f"{self.base}/models", headers=self.headers(), timeout=PROBE_TIMEOUT)
        except httpx.RequestError as exc:
            raise Unreachable(
                f"nothing is answering at {self.base} — start your router"
                f" (9router, fcc or mcc-server) ({exc.__class__.__name__})"
            ) from exc
        if res.status_code >= 400:
            raise ProviderError(_explain(res.status_code, res.text))

        body = res.json()
        rows = body if isinstance(body, list) else body.get("data") or body.get("models") or []
        out = []
        for m in rows:
            name = m if isinstance(m, str) else (m.get("id") or m.get("name") or m.get("model") or "")
            name = re.sub(r"^models/", "", str(name))
            if name:
                out.append(name)
        return sorted(set(out))

    async def health(self) -> dict[str, Any]:
        """Is it there, and what can it reach? One answer for the setup page."""
        try:
            models = await self.models()
        except (Unreachable, ProviderError) as exc:
            return {"ok": False, "base": self.base, "error": str(exc), "models": []}
        return {"ok": True, "base": self.base, "models": models, "count": len(models)}

    # ------------------------------------------------------------------ talking

    def start_turn(self, *, model: str, system: str, tools: list[dict[str, Any]] | None = None) -> Turn:
        return Turn(self, model, system, tools or [])

    # -------------------------------------------------------------------- media

    async def speak(self, *, text: str, model: str, voice: str = "alloy", fmt: str = "mp3") -> bytes:
        """Read something aloud. Returns the audio itself, not a URL."""
        http = await self._http()
        try:
            res = await http.post(
                f"{self.base}/audio/speech",
                headers=self.headers(),
                json={
                    "model": model,
                    "input": text[:4000],
                    "voice": voice,
                    "response_format": fmt,
                },
            )
        except httpx.RequestError as exc:
            raise Unreachable(f"could not reach {self.base} ({exc.__class__.__name__})") from exc
        if res.status_code >= 400:
            raise ProviderError(_explain(res.status_code, res.text))

        audio = res.content
        # Audio starts with ID3, 0xFF, RIFF or OggS — never with a brace. An
        # error delivered with a 200 is still an error, and writing it to a .mp3
        # produces a file that fails to play with no explanation anywhere.
        if audio[:1] in (b"{", b"["):
            raise ProviderError(f"expected audio, got JSON: {audio[:200].decode('utf-8', 'replace')}")
        return audio

    async def transcribe(self, *, audio: bytes, filename: str, model: str) -> str:
        """Turn what was said into text every agent in the room can read."""
        http = await self._http()
        try:
            res = await http.post(
                f"{self.base}/audio/transcriptions",
                headers=self.headers(),
                files={"file": (filename, audio)},
                data={"model": model},
            )
        except httpx.RequestError as exc:
            raise Unreachable(f"could not reach {self.base} ({exc.__class__.__name__})") from exc
        if res.status_code >= 400:
            raise ProviderError(_explain(res.status_code, res.text))
        body = res.json()
        return (body.get("text") or "").strip()

    async def image(self, *, prompt: str, model: str, size: str = "1024x1024") -> bytes:
        """
        Make a picture, and hand back the bytes.

        Providers answer with either a URL or inline base64 depending on the
        model, so both are resolved here — a caller that has to ask "which kind
        of answer is this" is a caller doing this file's job.
        """
        body = await self.post(
            "/images/generations",
            {"model": model, "prompt": prompt, "n": 1, "size": size},
        )
        rows = body.get("data") or []
        if not rows:
            raise ProviderError("the model returned no image")
        first = rows[0]

        if first.get("b64_json"):
            import base64

            return base64.b64decode(first["b64_json"])

        url = first.get("url")
        if not url:
            raise ProviderError("the model returned neither an image nor a link to one")
        http = await self._http()
        got = await http.get(url)
        if got.status_code >= 400:
            raise ProviderError(f"the image link answered {got.status_code}")
        return got.content
