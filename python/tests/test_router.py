"""
The way out of the room, proven against a server that answers like MCC.

What matters here is not that our client calls our mock; it is that the shapes
on the wire are the shapes MCC serves, and that the three things which used to
go wrong — a cut-off turn, an unreachable proxy, an error delivered as a 200 —
are each told apart from the others.
"""

from __future__ import annotations

import asyncio

import pytest

from esprits.router import Router, Interrupted, ProviderError, Unreachable
from tests.fake_router import MP3, FakeRouter


async def test_it_lists_what_the_proxy_can_reach():
    with FakeRouter() as router:
        client = Router(router.base)
        models = await client.models()
        assert "vendor/big" in models
        # Sorted and deduplicated, because it is shown to a person in a list.
        assert models == sorted(set(models))
        await client.aclose()


async def test_a_turn_runs_a_tool_and_then_answers():
    with FakeRouter() as router:
        client = Router(router.base)
        turn = client.start_turn(
            model="vendor/big",
            system="You are in a room.",
            tools=[{"name": "search", "description": "look it up", "parameters": {"type": "object"}}],
        )

        first = await turn.send("@kestrel what database should the importer use?")
        assert first.stop_reason == "tool_use"
        assert first.tool_calls[0]["name"] == "search"
        # Arguments arrive as a JSON string and are handed over parsed.
        assert first.tool_calls[0]["input"] == {"q": "importer"}

        second = await turn.tool_results([{"id": first.tool_calls[0]["id"], "output": "Postgres has them."}])
        assert second.stop_reason == "end_turn"
        assert "Postgres" in second.text

        # The tool result is attached to the call that asked for it, which is
        # the bookkeeping that goes wrong quietly when a caller does it.
        sent = turn.sent()
        tool_msg = [m for m in sent if m.get("role") == "tool"][0]
        assert tool_msg["tool_call_id"] == first.tool_calls[0]["id"]
        await client.aclose()


async def test_malformed_tool_arguments_do_not_take_the_turn_down():
    with FakeRouter() as router:
        client = Router(router.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        # Reach in and hand the parser something truncated, the way a model
        # that ran out of tokens mid-JSON does.
        from esprits.router import Step  # noqa: F401  (kept for the reader)

        turn._messages.append({"role": "assistant", "content": None})
        step = await turn.send("hello")
        assert step.stop_reason == "end_turn"
        await client.aclose()


async def test_stopping_a_turn_is_not_a_failure():
    with FakeRouter() as router:
        router.be_slow(5)
        client = Router(router.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])

        async def stop_it():
            await asyncio.sleep(0.2)
            turn.abort()

        asyncio.ensure_future(stop_it())
        with pytest.raises(Interrupted):
            await turn.send("take your time")
        assert turn.aborted
        await client.aclose()


async def test_an_absent_proxy_says_so_and_says_what_to_do():
    # Nothing is listening on this port, which is the case somebody actually
    # hits: they started the room and forgot to start MCC.
    client = Router("http://127.0.0.1:9/v1")
    with pytest.raises(Unreachable) as caught:
        await client.models()
    assert "mcc-server" in str(caught.value)
    await client.aclose()


async def test_a_refusal_is_read_rather_than_dumped():
    with FakeRouter() as router:
        client = Router(router.base)
        turn = client.start_turn(model="not/a/model", system="x", tools=[])
        with pytest.raises(ProviderError) as caught:
            await turn.send("hello")
        message = str(caught.value)
        # The provider's own sentence, not its JSON with a UUID to read past.
        assert "Not found for account" in message
        assert "{" not in message
        await client.aclose()


async def test_health_answers_both_questions_at_once():
    with FakeRouter() as router:
        client = Router(router.base)
        good = await client.health()
        assert good["ok"] and good["count"] >= 5
        await client.aclose()

    gone = Router("http://127.0.0.1:9/v1")
    bad = await gone.health()
    # Not an exception: the setup page asks this on every load and an absent
    # proxy is an ordinary state to be in, not an error to crash on.
    assert bad["ok"] is False and bad["models"] == []
    await gone.aclose()


async def test_speech_comes_back_as_audio_and_is_checked_for_being_audio():
    with FakeRouter() as router:
        client = Router(router.base)
        audio = await client.speak(text="ready", model="vendor/tts-1", voice="alloy")
        assert audio == MP3
        assert audio[:3] == b"ID3"
        await client.aclose()


async def test_an_ear_and_an_eye():
    with FakeRouter() as router:
        client = Router(router.base)
        said = await client.transcribe(audio=b"RIFFfake", filename="clip.wav", model="vendor/whisper-1")
        assert said == "ship the importer on Friday"

        png = await client.image(prompt="a small grey square", model="vendor/image-1")
        assert png[:8] == b"\x89PNG\r\n\x1a\n"
        await client.aclose()


async def test_the_room_sends_no_key_at_all():
    # The point of the whole arrangement: provider credentials live in MCC, so
    # there is nothing here to leak, mistype, or paste into the wrong box.
    with FakeRouter() as router:
        client = Router(router.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        await turn.send("hello")
        http = await client._http()
        assert "authorization" not in {k.lower() for k in http.headers}
        await client.aclose()


# --------------------------------------------------------- the Anthropic shape
#
# Free Claude Code serves /v1/messages and no /chat/completions at all, so a
# room pointed at it without noticing would 404 every single turn. These are the
# tests that say it does not.


async def test_a_router_without_chat_completions_is_detected_not_assumed():
    with FakeRouter("messages") as router:
        client = Router(router.base)
        assert await client.shape() == "messages"
        await client.aclose()

    with FakeRouter("chat") as router:
        client = Router(router.base)
        assert await client.shape() == "chat"
        await client.aclose()


async def test_a_whole_turn_runs_in_the_anthropic_shape():
    with FakeRouter("messages") as router:
        client = Router(router.base)
        turn = client.start_turn(
            model="vendor/big",
            system="You are in a room.",
            tools=[{"name": "search", "description": "look it up", "parameters": {"type": "object"}}],
        )

        first = await turn.send("@kestrel what database should the importer use?")
        assert first.stop_reason == "tool_use"
        assert first.tool_calls[0]["name"] == "search"
        assert first.tool_calls[0]["input"] == {"q": "importer"}
        # Text alongside a tool call is not lost, which the OpenAI shape has no
        # room for and this one does.
        assert "Let me look" in first.text

        second = await turn.tool_results([{"id": first.tool_calls[0]["id"], "output": "Postgres has them."}])
        assert second.stop_reason == "end_turn"
        assert "Postgres" in second.text

        sent = [s for s in router.seen if s["path"].endswith("/messages")]
        assert sent, "it should have gone to /messages, not /chat/completions"

        # The system prompt is a field of its own here, not the first message.
        first_body = sent[0]["body"]
        assert first_body["system"] == "You are in a room."
        assert all(m["role"] != "system" for m in first_body["messages"])
        # And a tool is described by input_schema rather than nested in function.
        assert first_body["tools"][0]["input_schema"] == {"type": "object"}

        # A tool result is a content block on a user message. Anthropic
        # alternates roles strictly, so a run of user messages is refused.
        second_body = sent[1]["body"]
        roles = [m["role"] for m in second_body["messages"]]
        assert roles == ["user", "assistant", "user"], roles
        result_block = second_body["messages"][-1]["content"][0]
        assert result_block["type"] == "tool_result"
        assert result_block["tool_use_id"] == first.tool_calls[0]["id"]
        await client.aclose()


async def test_consecutive_tool_results_become_one_user_message():
    # Two tools answered in one round is the ordinary case for a parallel call,
    # and sending them as two user messages in a row is refused outright.
    with FakeRouter("messages") as router:
        client = Router(router.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        turn._messages.append({"role": "user", "content": "go"})
        turn._messages.append({
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": "a", "type": "function", "function": {"name": "one", "arguments": "{}"}},
                {"id": "b", "type": "function", "function": {"name": "two", "arguments": "{}"}},
            ],
        })
        await turn.tool_results([{"id": "a", "output": "1"}, {"id": "b", "output": "2"}])

        body = [s for s in router.seen if s["path"].endswith("/messages")][-1]["body"]
        assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]
        assert len(body["messages"][-1]["content"]) == 2
        await client.aclose()


async def test_the_transcript_survives_a_router_being_swapped():
    # The history is kept in one shape internally, so moving a conversation
    # from a chat router to a messages one does not lose what was said.
    with FakeRouter("chat") as first:
        client = Router(first.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        await turn.send("hello")
        carried = turn.sent()
        await client.aclose()

    assert [m["role"] for m in carried] == ["system", "user", "assistant"]

    with FakeRouter("messages") as second:
        client = Router(second.base)
        moved = client.start_turn(model="vendor/big", system="x", tools=[])
        moved._messages = carried
        step = await moved.send("and now?")
        assert step.stop_reason == "end_turn"
        body = [s for s in second.seen if s["path"].endswith("/messages")][-1]["body"]
        # Translated on the way out, with the system prompt lifted off.
        assert body["system"] == "x"
        assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]
        await client.aclose()


async def test_a_routers_own_token_rides_along_in_both_spellings():
    # The token a router wants at its own door is a different thing from a
    # provider key, and which header it reads depends on which shape it is
    # imitating. Sending the pair costs nothing.
    with FakeRouter("chat") as router:
        client = Router(router.base, token="rtr-secret")
        head = client.headers()
        assert head["authorization"] == "Bearer rtr-secret"
        assert head["x-api-key"] == "rtr-secret"
        await client.models()
        await client.aclose()

    with FakeRouter("chat") as router:
        client = Router(router.base)
        assert client.headers() == {}
        await client.aclose()


def test_the_routers_on_offer_are_described_honestly():
    from esprits.router import ROUTERS

    assert set(ROUTERS) == {"9router", "fcc", "mcc"}
    for key, r in ROUTERS.items():
        assert r["base"].startswith("http://127.0.0.1:")
        assert r["command"] and r["home"].startswith("https://github.com/")
    # The collision worth knowing about before both are installed.
    assert ROUTERS["fcc"]["base"] == ROUTERS["mcc"]["base"]
    assert ROUTERS["9router"]["base"] != ROUTERS["fcc"]["base"]
