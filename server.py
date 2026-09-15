"""Backend web live chat: browser <-> Gemini 2.5 Flash Native Audio.

Browser kirim mic PCM 16kHz + teks via WebSocket.
Server teruskan ke Live API, kembalikan audio 24kHz + transkripsi.

Jalan:
    export GEMINI_API_KEY='kunci-anda'
    pip install -r requirements.txt
    python server.py
    buka http://localhost:8000
"""

import asyncio
import base64
import json
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from google import genai

LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
STATIC_DIR = Path(__file__).parent / "static"


def build_config():
    return {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "system_instruction": (
            "Kamu asisten suara berbahasa Indonesia. "
            "Jawab singkat, santai, maksimal 2-3 kalimat."
        ),
    }


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def gemini_to_browser(session, ws: WebSocket):
    """Teruskan audio + transkripsi Gemini ke browser. Loop per-turn."""
    while True:
        try:
            async for msg in session.receive():
                sc = msg.server_content
                if sc is None:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    await ws.send_json(
                        {
                            "type": "transcript_in",
                            "text": sc.input_transcription.text,
                        }
                    )
                if sc.output_transcription and sc.output_transcription.text:
                    await ws.send_json(
                        {
                            "type": "transcript_out",
                            "text": sc.output_transcription.text,
                        }
                    )
                model_turn = getattr(sc, "model_turn", None)
                if model_turn and model_turn.parts:
                    for part in model_turn.parts:
                        blob = getattr(part, "inline_data", None)
                        if blob is not None and getattr(blob, "data", None):
                            await ws.send_json(
                                {
                                    "type": "audio",
                                    "mime_type": "audio/pcm;rate=24000",
                                    "data": base64.b64encode(
                                        bytes(blob.data)
                                    ).decode("ascii"),
                                }
                            )
                if sc.turn_complete:
                    await ws.send_json({"type": "turn_complete"})
                    break  # buka receive() untuk turn berikut
        except Exception as e:  # koneksi Gemini putus
            try:
                await ws.send_json(
                    {"type": "status", "text": f"live terputus: {e}"}
                )
            except Exception:
                pass
            break


async def browser_to_gemini(session, ws: WebSocket):
    """Teruskan teks + audio browser ke Gemini."""
    while True:
        raw = await ws.receive_text()
        try:
            pkt = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = pkt.get("type")
        if kind == "text" and pkt.get("text", "").strip():
            await session.send_client_content(
                turns={"parts": [{"text": pkt["text"].strip()}]}
            )
        elif kind == "audio" and pkt.get("data"):
            pcm = base64.b64decode(pkt["data"])
            await session.send_realtime_input(
                audio={"data": pcm, "mime_type": "audio/pcm;rate=16000"}
            )


@app.websocket("/ws")
async def ws_bridge(ws: WebSocket):
    await ws.accept()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        await ws.send_json(
            {"type": "status", "text": "Server belum set GEMINI_API_KEY."}
        )
        await ws.close()
        return
    client = genai.Client(api_key=api_key)
    try:
        async with client.aio.live.connect(
            model=LIVE_MODEL, config=build_config()
        ) as session:
            await ws.send_json(
                {"type": "status", "text": f"Terhubung ke {LIVE_MODEL}."}
            )
            # sapaan awal biar user dengar suara langsung
            await session.send_client_content(
                turns={"parts": [{"text": "Halo! Perkenalkan dirimu singkat."}]}
            )
            recv_task = asyncio.create_task(gemini_to_browser(session, ws))
            try:
                await browser_to_gemini(session, ws)
            except WebSocketDisconnect:
                pass
            finally:
                recv_task.cancel()
                try:
                    await recv_task
                except asyncio.CancelledError:
                    pass
    except Exception as e:
        try:
            await ws.send_json({"type": "status", "text": f"Gagal: {e}"})
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
