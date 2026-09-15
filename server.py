"""Backend web live chat: browser <-> Gemini 2.5 Flash Native Audio.

Browser kirim mic PCM 16kHz + teks via WebSocket.
Server teruskan ke Live API, kembalikan audio 24kHz + transkripsi.

Memori sesi (docs: live-api/session-management):
- context_window_compression sliding window: sesi audio tak terbatas,
  konteks lama diringkas bukan dibuang.
- session_resumption: handle disimpan per client, koneksi putus dalam
  2 jam bisa resume tanpa kehilangan konteks.
- MEMORY per client: ringkasan turn terakhir dikirim ulang saat koneksi
  baru tanpa handle (misal restart server).

Google Search grounding (docs: google-search):
- query param ?search=1 mengaktifkan tool google_search di setup.
- grounding_metadata diteruskan ke browser sebagai sitasi.

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
MAX_MEMORY_TURNS = 20  # turn tersimpan per client (user+model)

# Memori proses: client_id -> list[{"role": "user"|"model", "text": str}]
MEMORY: dict = {}
# Handle resumption: client_id -> handle string (valid 2 jam)
HANDLES: dict = {}


MALE_VOICES = {"Puck", "Charon", "Fenrir", "Orus", "Algenib", "Rasalgethi", "Gacrux", "Sadaltager"}
DEFAULT_VOICE = os.environ.get("LIVE_VOICE", "Charon")
if DEFAULT_VOICE not in MALE_VOICES:
    DEFAULT_VOICE = "Charon"


def build_config(enable_search: bool = False, resume_handle=None, voice_name: str = DEFAULT_VOICE):
    if voice_name not in MALE_VOICES:
        voice_name = DEFAULT_VOICE
    config = {
        "response_modalities": ["AUDIO"],
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": voice_name}}},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # Sesi audio tak terbatas: konteks lama diringkas otomatis.
        "context_window_compression": {"sliding_window": {}},
        # Kirim update handle agar sesi bisa di-resume.
        "session_resumption": {},
        "system_instruction": (
            "Kamu asisten suara berbahasa Indonesia. "
            "Jawab singkat, santai, maksimal 2-3 kalimat. "
            "Ingat konteks percakapan sebelumnya dalam sesi ini."
        ),
    }
    if resume_handle:
        config["session_resumption"] = {"handle": resume_handle}
    if enable_search:
        config["tools"] = [{"google_search": {}}]
    return config


def remember(client_id: str, role: str, text: str):
    buf = MEMORY.setdefault(client_id, [])
    buf.append({"role": role, "text": text})
    del buf[: -MAX_MEMORY_TURNS]


def memory_summary(client_id: str) -> str:
    buf = MEMORY.get(client_id, [])
    if not buf:
        return ""
    lines = []
    for t in buf[-8:]:
        who = "Pengguna" if t["role"] == "user" else "Asisten"
        lines.append(f"{who}: {t['text']}")
    return "\n".join(lines)


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def gemini_to_browser(session, ws: WebSocket, client_id: str, voice_name: str = DEFAULT_VOICE):
    """Teruskan audio + transkripsi + sitasi Gemini ke browser.

    Loop per-turn karena SDK receive() berhenti tiap turn_complete.
    """
    turn_text = ""
    while True:
        try:
            async for msg in session.receive():
                # Handle resumption: simpan untuk koneksi berikutnya.
                update = getattr(msg, "session_resumption_update", None)
                if update is not None and getattr(
                    update, "new_handle", None
                ):
                    HANDLES[client_id] = update.new_handle
                    HANDLES[client_id + ":voice"] = voice_name

                # GoAway: koneksi akan diputus, beri tahu browser.
                if getattr(msg, "go_away", None) is not None:
                    try:
                        await ws.send_json(
                            {
                                "type": "status",
                                "text": "Koneksi Live hampir berakhir, "
                                "menyambung ulang otomatis...",
                            }
                        )
                    except Exception:
                        pass

                sc = msg.server_content
                if sc is None:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    text = sc.input_transcription.text
                    remember(client_id, "user", text)
                    await ws.send_json(
                        {"type": "transcript_in", "text": text}
                    )
                if sc.output_transcription and sc.output_transcription.text:
                    chunk = sc.output_transcription.text
                    turn_text += chunk
                    await ws.send_json(
                        {"type": "transcript_out", "text": chunk}
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
                # Sitasi Google Search grounding.
                gm = getattr(sc, "grounding_metadata", None)
                if gm is not None:
                    chunks = getattr(gm, "grounding_chunks", None) or []
                    sources = []
                    for c in chunks:
                        web = getattr(c, "web", None)
                        if web is not None and getattr(web, "uri", None):
                            sources.append(
                                {
                                    "title": getattr(web, "title", None)
                                    or web.uri,
                                    "url": web.uri,
                                }
                            )
                    if sources:
                        await ws.send_json(
                            {"type": "sources", "items": sources}
                        )
                if sc.turn_complete:
                    if turn_text.strip():
                        remember(client_id, "model", turn_text.strip())
                    turn_text = ""
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


async def browser_to_gemini(session, ws: WebSocket, client_id: str):
    """Teruskan teks + audio browser ke Gemini."""
    while True:
        raw = await ws.receive_text()
        try:
            pkt = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = pkt.get("type")
        if kind == "text" and pkt.get("text", "").strip():
            text = pkt["text"].strip()
            remember(client_id, "user", text)
            await session.send_client_content(
                turns={"parts": [{"text": text}]}
            )
        elif kind == "audio" and pkt.get("data"):
            pcm = base64.b64decode(pkt["data"])
            await session.send_realtime_input(
                audio={"data": pcm, "mime_type": "audio/pcm;rate=16000"}
            )


@app.websocket("/ws")
async def ws_bridge(ws: WebSocket):
    await ws.accept()
    params = ws.query_params
    client_id = params.get("client", "default")
    enable_search = params.get("search", "0") == "1"
    voice_name = params.get("voice", DEFAULT_VOICE)
    if voice_name not in MALE_VOICES:
        voice_name = DEFAULT_VOICE
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        await ws.send_json(
            {"type": "status", "text": "Server belum set GEMINI_API_KEY."}
        )
        await ws.close()
        return
    client = genai.Client(api_key=api_key)
    # Resume sesi sebelumnya bila handle masih valid (< 2 jam).
    last_voice = HANDLES.get(client_id + ":voice")
    handle = HANDLES.get(client_id)
    if last_voice is not None and last_voice != voice_name:
        handle = None
    resumed = bool(handle)
    try:
        async with client.aio.live.connect(
            model=LIVE_MODEL,
            config=build_config(enable_search, handle, voice_name),
        ) as session:
            mode = " + Google Search" if enable_search else ""
            mode += f" + suara {voice_name}"
            if resumed:
                await ws.send_json(
                    {
                        "type": "status",
                        "text": f"Sesi dilanjutkan{mode}.",
                    }
                )
            else:
                await ws.send_json(
                    {
                        "type": "status",
                        "text": f"Terhubung ke {LIVE_MODEL}{mode}.",
                    }
                )
            summary = memory_summary(client_id)
            if summary:
                # Konteks dikirim sebagai bagian turn yang belum
                # selesai (turn_complete=False), jadi model menunggu
                # pesan user berikutnya dalam turn yang sama.
                # Tidak perlu drain receive() di sini karena itu
                # berebut dengan gemini_to_browser.
                await session.send_client_content(
                    turns={
                        "parts": [
                            {
                                "text": "Konteks percakapan sebelumnya "
                                "dengan pengguna ini (jadikan memori):\n"
                                + summary
                            }
                        ]
                    },
                    turn_complete=False,
                )
            if not MEMORY.get(client_id):
                # Sapaan awal hanya untuk client benar-benar baru.
                await session.send_client_content(
                    turns={
                        "parts": [
                            {"text": "Halo! Perkenalkan dirimu singkat."}
                        ]
                    }
                )
            recv_task = asyncio.create_task(
                gemini_to_browser(session, ws, client_id, voice_name)
            )
            try:
                await browser_to_gemini(session, ws, client_id)
            except WebSocketDisconnect:
                pass
            finally:
                recv_task.cancel()
                try:
                    await recv_task
                except asyncio.CancelledError:
                    pass
    except Exception as e:
        # Handle basi -> hapus agar koneksi berikut mulai sesi baru.
        HANDLES.pop(client_id, None)
        try:
            await ws.send_json({"type": "status", "text": f"Gagal: {e}"})
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
