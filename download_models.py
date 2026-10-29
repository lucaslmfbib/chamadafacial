"""Baixa os pesos do face-api.js para static/models (rodar uma vez)."""
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/"
FILES = [
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_recognition_model-shard2",
]

dest = Path(__file__).parent / "static" / "models"
dest.mkdir(parents=True, exist_ok=True)
for f in FILES:
    out = dest / f
    if out.exists() and out.stat().st_size > 0:
        print(f"✓ {f} (já existe)")
        continue
    print(f"↓ {f}")
    urllib.request.urlretrieve(BASE + f, out)
print(f"Modelos prontos em {dest}")
