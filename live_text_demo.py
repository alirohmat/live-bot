"""Gemini Live API demo. Key from env, never hardcoded."""

import asyncio
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from google import genai

LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
try:
    from server import ALLOWED_VOICES
except Exception:
    ALLOWED_VOICES = {"Puck", "Charon", "Fenrir", "Orus", "Algenib", "Rasalgethi", "Gacrux", "Sadaltager",
                      "Kore", "Aoede", "Leda", "Sulafat", "Zephyr"}
MALE_VOICES = set(ALLOWED_VOICES)  # alias kompatibel
VOICE_NAME = os.environ.get("LIVE_VOICE", "Charon")
if VOICE_NAME not in ALLOWED_VOICES:
    VOICE_NAME = "Charon"


async def run(prompt: str = "Say hello in one sentence."):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Set GEMINI_API_KEY env var. See .env.example.")
    client = genai.Client(api_key=api_key)

    async with client.aio.live.connect(
        model=LIVE_MODEL,
        config={
            "response_modalities": ["AUDIO"],
            "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": VOICE_NAME if VOICE_NAME in ALLOWED_VOICES else "Charon"}}},
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
