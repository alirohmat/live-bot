# gemini-live

Live API demo with `google-genai` SDK.

## Setup

```bash
pip install -r requirements.txt
export GEMINI_API_KEY='your-key'
```

## Run

```bash
python live_text_demo.py
python list_models.py
# live chat audio dua arah (butuh mic + speaker)
python live_audio_chat.py
# versi web (browser mic + speaker, server bridge)
python server.py
# buka http://localhost:8000
```

Di dalam `live_audio_chat.py`: ketik teks + Enter untuk kirim pesan,
`/quit` untuk keluar. Di server tanpa mic/speaker otomatis mode teks.

## Notes

- `gemini-2.5-flash` retired for new users. Use `gemini-3.6-flash` for `generateContent`.
- Live models use `bidiGenerateContent`, need `AUDIO` modality:
  - `gemini-2.5-flash-native-audio-preview-12-2025` works with `output_audio_transcription`.
  - `gemini-3.1-flash-live-preview` rejects `AUDIO` + transcription combo on this key.
- `TEXT` modality rejected on native-audio Live models.

## Suara

Default pria `Charon` (env `LIVE_VOICE`). Web: dropdown Suara di footer. CLI `live_audio_chat.py` / `live_text_demo.py`: set `LIVE_VOICE` atau ubah `VOICE_NAME`. Pilihan pria: `Puck`, `Charon`, `Fenrir`, `Orus`, `Algenib`, `Rasalgethi`, `Gacrux`, `Sadaltager`. Ganti voice = sesi Live baru.
