# ============================================================
#  Railway Server — Serves the Frontend HTML/JS
#  main.py
# ============================================================

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import os

app = FastAPI(title="Devanagari ASR Frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Serve static files (JS, CSS, etc.) ───
# Only mount if the static directory exists
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory="static"), name="static")

# ─── Serve app.js directly from root ───
@app.get("/app.js")
async def serve_js():
    js_path = os.path.join(os.path.dirname(__file__), "app.js")
    return FileResponse(js_path, media_type="application/javascript")

# ─── Serve index.html for all routes ───
@app.get("/")
@app.get("/{full_path:path}")
async def serve_frontend(full_path: str = ""):
    index_path = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path, media_type="text/html")
    return HTMLResponse("<h1>index.html not found</h1>", status_code=404)

# ─── Health check ───
@app.get("/ping")
async def ping():
    return {"status": "ok", "service": "Devanagari ASR Frontend"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)