"""Live chat audio dua arah: Gemini 2.5 Flash Native Audio Dialog.

Key dari env GEMINI_API_KEY, tidak pernah hardcoded.

Cara pakai (di mesin dengan mic + speaker):
    export GEMINI_API_KEY='kunci-anda'
    pip install -r requirements.txt
    python live_audio_chat.py

Perintah saat jalan:
    ketik teks + Enter = kirim pesan teks
    /quit = keluar

Tanpa mic/speaker (server): otomatis mode teks,
tetap tampilkan transkripsi balasan audio model.
"""

import asyncio
import os
import queue
import sys
import threading

from google import genai

LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

INPUT_RATE = 16000   # mic ke model: PCM 16-bit mono 16kHz
OUTPUT_RATE = 24000  # model ke speaker: PCM 16-bit mono 24kHz
CHANNELS = 1
FRAME_MS = 100  # 100ms per chunk mic


try:
    from server import ALLOWED_VOICES
except Exception:
    ALLOWED_VOICES = {"Puck", "Charon", "Fenrir", "Orus", "Algenib", "Rasalgethi", "Gacrux", "Sadaltager",
                      "Kore", "Aoede", "Leda", "Sulafat", "Zephyr"}
MALE_VOICES = set(ALLOWED_VOICES)  # alias kompatibel
VOICE_NAME = os.environ.get("LIVE_VOICE", "Charon")
if VOICE_NAME not in ALLOWED_VOICES:
    VOICE_NAME = "Charon"


def build_config():
    voice = VOICE_NAME if VOICE_NAME in ALLOWED_VOICES else "Charon"
    return {
        "response_modalities": ["AUDIO"],
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": voice}}},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "system_instruction": (
            "Kamu asisten suara berbahasa Indonesia. "
            "Jawab singkat, santai, maksimal 2-3 kalimat."
        ),
    }


async def receive_loop(session, audio_q):
    """Terima pesan server: cetak transkripsi, antrekan audio.

    SDK `session.receive()` berhenti tiap `turn_complete`,
    jadi loop luar dibuka per turn agar chat multi-turn.
    Berhenti saat task di-cancel dari run() atau koneksi tutup.
    """
    import websockets

    while True:
        try:
            async for msg in session.receive():
                sc = msg.server_content
                if sc is None:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    print(f"\n[kamu] {sc.input_transcription.text}", flush=True)
                if sc.output_transcription and sc.output_transcription.text:
                    print(sc.output_transcription.text, end="", flush=True)
                model_turn = getattr(sc, "model_turn", None)
                if model_turn and model_turn.parts:
                    for part in model_turn.parts:
                        blob = getattr(part, "inline_data", None)
                        if blob is not None and getattr(blob, "data", None):
                            audio_q.put(bytes(blob.data))
                if sc.turn_complete:
                    print(flush=True)
                    break  # turn selesai, buka receive() untuk turn berikut
        except websockets.ConnectionClosed:
            print("\n[koneksi live terputus]", flush=True)
            break


def mic_thread(session, loop, stop_event):
    """Baca mic 16kHz, kirim realtime. Jalan di thread sendiri."""
    import sounddevice as sd

    def callback(indata, frames, time_info, status):
        if stop_event.is_set():
            return
        pcm = bytes(indata)
        coro = session.send_realtime_input(
            audio={"data": pcm, "mime_type": "audio/pcm;rate=16000"}
        )
        asyncio.run_coroutine_threadsafe(coro, loop)

    try:
        with sd.InputStream(
            samplerate=INPUT_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=INPUT_RATE * FRAME_MS // 1000,
            callback=callback,
        ):
            print("[mic aktif, bicara saja...]", flush=True)
            stop_event.wait()
    except Exception as e:  # tidak ada mic: mode teks saja
        print(f"[mic tidak tersedia: {e}] mode teks saja.", flush=True)
        stop_event.wait()


def speaker_thread(audio_q, stop_event):
    """Mainkan antrean audio 24kHz. Jalan di thread sendiri."""
    import sounddevice as sd
    import numpy as np

    try:
        with sd.OutputStream(
            samplerate=OUTPUT_RATE, channels=CHANNELS, dtype="int16"
        ) as stream:
            print("[speaker aktif]", flush=True)
            while not stop_event.is_set():
                try:
                    pcm = audio_q.get(timeout=0.2)
                except queue.Empty:
                    continue
                data = np.frombuffer(pcm, dtype=np.int16)
                stream.write(data)
    except Exception as e:  # tidak ada speaker: buang antrean
        print(f"[speaker tidak tersedia: {e}] audio dibuang.", flush=True)
        while not stop_event.is_set():
            try:
                audio_q.get(timeout=0.2)
            except queue.Empty:
                continue


async def keyboard_loop(session, loop, stop_event):
    """Baca stdin tanpa blokir event loop. /quit = selesai."""
    print("Ketik pesan + Enter (atau /quit keluar):", flush=True)
    while not stop_event.is_set():
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:  # EOF (stdin piped habis)
            stop_event.set()
            break
        line = line.strip()
        if not line:
            continue
        if line == "/quit":
            stop_event.set()
            break
        await session.send_client_content(
            turns={"parts": [{"text": line}]}
        )


async def run():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Set GEMINI_API_KEY. Lihat .env.example.")
    client = genai.Client(api_key=api_key)

    audio_q: queue.Queue = queue.Queue()
    stop_event = threading.Event()
    loop = asyncio.get_running_loop()

    async with client.aio.live.connect(
        model=LIVE_MODEL, config=build_config()
    ) as session:
        print(f"model: {LIVE_MODEL}", flush=True)
        print("Terhubung. Sapa model dulu...", flush=True)
        await session.send_client_content(
            turns={"parts": [{"text": "Halo! Perkenalkan dirimu singkat."}]}
        )

        mic_t = threading.Thread(
            target=mic_thread, args=(session, loop, stop_event),
            daemon=True,
        )
        spk_t = threading.Thread(
            target=speaker_thread, args=(audio_q, stop_event),
            daemon=True,
        )
        mic_t.start()
        spk_t.start()

        recv_task = asyncio.create_task(receive_loop(session, audio_q))
        kb_task = asyncio.create_task(keyboard_loop(session, loop, stop_event))
        try:
            # selesai saat user /quit atau stdin EOF
            await kb_task
        finally:
            stop_event.set()
            recv_task.cancel()
            try:
                await recv_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    asyncio.run(run())
