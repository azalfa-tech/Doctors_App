import asyncio
import base64
import os
from contextlib import asynccontextmanager
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .schemas import AnalyzeRequest, AnalyzeResponse
from .llm import analyze_transcript
from .transcription import Transcriber, SpeechGate

load_dotenv()
transcriber = None
asr_error = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global transcriber, asr_error
    try:
        transcriber = await asyncio.to_thread(Transcriber)
    except Exception as exc:
        asr_error = str(exc)
        print(f"ASR initialization failed: {exc}")
    yield

app = FastAPI(title="ClinScribe Local API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500", "http://127.0.0.1:8000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "asr_ready": transcriber is not None,
        "asr_error": asr_error,
        "whisper_model": os.getenv("WHISPER_MODEL", "small"),
        "ollama_model": os.getenv("OLLAMA_MODEL", "qwen2.5:3b"),
    }

@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest):
    try:
        note, model = await analyze_transcript(request.transcript.strip())
        return AnalyzeResponse(note=note, model=model)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

@app.websocket("/ws/transcribe")
async def websocket_transcribe(ws: WebSocket):
    await ws.accept()
    if transcriber is None:
        await ws.send_json({"type": "error", "message": f"Whisper model unavailable: {asr_error or 'initializing'}"})
        await ws.close(code=1011)
        return
    gate = None
    parts = []
    try:
        gate = await asyncio.to_thread(SpeechGate)
        await ws.send_json({"type": "status", "message": "ready"})
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "audio":
                try:
                    raw = base64.b64decode(msg.get("data", ""), validate=True)
                    if len(raw) > 1_000_000:
                        await ws.send_json({"type": "error", "message": "Audio chunk too large"})
                        continue
                    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    segments = await asyncio.to_thread(gate.process, pcm)
                    for segment in segments:
                        text = await asyncio.to_thread(transcriber.transcribe, segment)
                        if text:
                            parts.append(text)
                            await ws.send_json({"type": "transcript", "text": text, "full_transcript": " ".join(parts)})
                except Exception as exc:
                    await ws.send_json({"type": "error", "message": f"Audio processing failed: {exc}"})
            elif msg.get("type") == "stop":
                tail = await asyncio.to_thread(gate.flush)
                if tail is not None:
                    text = await asyncio.to_thread(transcriber.transcribe, tail)
                    if text:
                        parts.append(text)
                        await ws.send_json({"type": "transcript", "text": text, "full_transcript": " ".join(parts)})
                await ws.send_json({"type": "stopped", "full_transcript": " ".join(parts)})
                break
    except WebSocketDisconnect:
        pass
    finally:
        if gate:
            try: gate.reset()
            except Exception: pass
