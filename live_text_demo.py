"""Gemini Live API demo. Key from env, never hardcoded."""

import asyncio
import os

from google import genai

LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
VOICE_NAME = "Charon"  # pria: Puck, Charon, Fenrir, Orus, Algenib, Rasalgethi, Gacrux, Sadaltager


async def run(prompt: str = "Say hello in one sentence."):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Set GEMINI_API_KEY env var. See .env.example.")
    client = genai.Client(api_key=api_key)

    async with client.aio.live.connect(
        model=LIVE_MODEL,
        config={
            "response_modalities": ["AUDIO"],
            "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": VOICE_NAME}}},
            "output_audio_transcription": {},
        },
    ) as session:
        await session.send_client_content(
            turns={"parts": [{"text": prompt}]},
        )
        print(f"model: {LIVE_MODEL}")
        full = ""
        async for msg in session.receive():
            sc = msg.server_content
            if not sc:
                continue
            if sc.output_transcription and sc.output_transcription.text:
                chunk = sc.output_transcription.text
                full += chunk
                print(chunk, end="", flush=True)
            if sc.turn_complete:
                break
        print()
        print(f"transcript: {full.strip()}")


if __name__ == "__main__":
    asyncio.run(run())
