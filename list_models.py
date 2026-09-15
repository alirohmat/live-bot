"""List available Gemini models. Key from env."""

import os
import urllib.request
import json

key = os.environ.get("GEMINI_API_KEY")
if not key:
    raise SystemExit("Set GEMINI_API_KEY env var.")

url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=100"
all_models = []
token = ""
while True:
    u = url + (f"&pageToken={token}" if token else "")
    d = json.load(urllib.request.urlopen(u))
    all_models.extend(d.get("models", []))
    token = d.get("nextPageToken", "")
    if not token:
        break

print(f"total: {len(all_models)}")
for m in all_models:
    print(m["name"], m.get("supportedGenerationMethods"))
