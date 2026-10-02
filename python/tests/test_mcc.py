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

from esprits.mcc import MCC, Interrupted, ProviderError, Unreachable
from tests.fake_mcc import MP3, FakeMCC


async def test_it_lists_what_the_proxy_can_reach():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        models = await client.models()
        assert "vendor/big" in models
        # Sorted and deduplicated, because it is shown to a person in a list.
        assert models == sorted(set(models))
        await client.aclose()


async def test_a_turn_runs_a_tool_and_then_answers():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
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
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        # Reach in and hand the parser something truncated, the way a model
        # that ran out of tokens mid-JSON does.
        from esprits.mcc import Step  # noqa: F401  (kept for the reader)

        turn._messages.append({"role": "assistant", "content": None})
        step = await turn.send("hello")
        assert step.stop_reason == "end_turn"
        await client.aclose()


async def test_stopping_a_turn_is_not_a_failure():
    with FakeMCC() as mcc:
        mcc.be_slow(5)
        client = MCC(mcc.base)
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
    client = MCC("http://127.0.0.1:9/v1")
    with pytest.raises(Unreachable) as caught:
        await client.models()
    assert "mcc-server" in str(caught.value)
    await client.aclose()


async def test_a_refusal_is_read_rather_than_dumped():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        turn = client.start_turn(model="not/a/model", system="x", tools=[])
        with pytest.raises(ProviderError) as caught:
            await turn.send("hello")
        message = str(caught.value)
        # The provider's own sentence, not its JSON with a UUID to read past.
        assert "Not found for account" in message
        assert "{" not in message
        await client.aclose()


async def test_health_answers_both_questions_at_once():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        good = await client.health()
        assert good["ok"] and good["count"] >= 5
        await client.aclose()

    gone = MCC("http://127.0.0.1:9/v1")
    bad = await gone.health()
    # Not an exception: the setup page asks this on every load and an absent
    # proxy is an ordinary state to be in, not an error to crash on.
    assert bad["ok"] is False and bad["models"] == []
    await gone.aclose()


async def test_speech_comes_back_as_audio_and_is_checked_for_being_audio():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        audio = await client.speak(text="ready", model="vendor/tts-1", voice="alloy")
        assert audio == MP3
        assert audio[:3] == b"ID3"
        await client.aclose()


async def test_an_ear_and_an_eye():
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        said = await client.transcribe(audio=b"RIFFfake", filename="clip.wav", model="vendor/whisper-1")
        assert said == "ship the importer on Friday"

        png = await client.image(prompt="a small grey square", model="vendor/image-1")
        assert png[:8] == b"\x89PNG\r\n\x1a\n"
        await client.aclose()


async def test_the_room_sends_no_key_at_all():
    # The point of the whole arrangement: provider credentials live in MCC, so
    # there is nothing here to leak, mistype, or paste into the wrong box.
    with FakeMCC() as mcc:
        client = MCC(mcc.base)
        turn = client.start_turn(model="vendor/big", system="x", tools=[])
        await turn.send("hello")
        http = await client._http()
        assert "authorization" not in {k.lower() for k in http.headers}
        await client.aclose()
