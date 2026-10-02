"""
The way out of the room.

Everything this app needs from the outside world — a model that talks, a voice,
an ear, a picture — is one HTTP call to My Claude Code, which stands in front of
whatever providers you have given it and speaks the OpenAI shape on the usual
paths. So this file is the whole connector layer, and it is thin on purpose.

It replaces four files that used to be here: a table of per-provider presets, a
prober that guessed at base URLs, a media module that knew which provider wanted
its voice in the path and which in the body, and an adapter wrapping a vendor
SDK. All of that was this app carrying a problem that was never its own — which
key, which header, which spelling of "model" — and getting it wrong in ways that
looked like the app being broken. MCC does that job and does it better, so the
room asks one address and stops guessing.

What remains here is only what the room genuinely needs to know: where MCC is,
what it can reach today, and how to take one turn with it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

import httpx

DEFAULT_BASE = "http://127.0.0.1:8082/v1"
TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

# Long enough for a model that thinks before it speaks, short enough that a dead
# endpoint is reported rather than waited on forever.
PROBE_TIMEOUT = httpx.Timeout(12.0)


def base_url() -> str:
    """Where MCC is listening, overridable for a non-default install."""
    return (os.environ.get("ESPRITS_MCC") or DEFAULT_BASE).rstrip("/")


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

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": self._messages,
            "max_completion_tokens": self._client.max_tokens,
        }
        if self._tools:
            payload["tools"] = self._tools
            payload["tool_choice"] = "auto"
        if self._client.effort:
            # MCC owns reasoning controls, so the room asks in one spelling and
            # lets it translate — which is the whole point of it being there.
            payload["reasoning_effort"] = self._client.effort

        task = asyncio.ensure_future(self._client.post("/chat/completions", payload))
        self._in_flight = task
        try:
            body = await task
        except asyncio.CancelledError as exc:
            raise Interrupted("stopped") from exc
        finally:
            self._in_flight = None

        if self._stopped:
            raise Interrupted("stopped")

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


class MCC:
    """
    A client for one MCC instance.

    There is no API key here, and that is the point: MCC holds the provider
    credentials, in its own dashboard, where it can validate and rotate them.
    Nothing in this room ever stores one.
    """

    def __init__(
        self,
        base: str | None = None,
        *,
        max_tokens: int = 4096,
        effort: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base = (base or base_url()).rstrip("/")
        self.max_tokens = max_tokens
        self.effort = effort
        self._client = client
        self._owned = client is None

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
            res = await http.post(f"{self.base}{path}", json=payload)
        except httpx.RequestError as exc:
            raise Unreachable(
                f"nothing is answering at {self.base} — start My Claude Code"
                f' with "mcc-server" and check its dashboard is up ({exc.__class__.__name__})'
            ) from exc
        if res.status_code >= 400:
            raise ProviderError(_explain(res.status_code, res.text))
        return res.json()

    async def models(self) -> list[str]:
        """Everything MCC can reach today, which is its owner's business."""
        http = await self._http()
        try:
            res = await http.get(f"{self.base}/models", timeout=PROBE_TIMEOUT)
        except httpx.RequestError as exc:
            raise Unreachable(
                f"nothing is answering at {self.base} — start My Claude Code"
                f' with "mcc-server" ({exc.__class__.__name__})'
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
