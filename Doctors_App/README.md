It is a web application that converts speech into text and uses AI to generate structured clinical notes.

## Features
- Live medical transcription
- AI-generated clinical notes
- Structured patient information and clinical summaries

## Tech Stack
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Python, FastAPI
- **Speech-to-Text:** Faster-Whisper
- **LLM:** Ollama with Qwen 2.5 3B

## Run Locally
load the requirements 

download Ollama and pull the model

open first terminal,start the model
ollama run qwen2.5:3b

in a secon terminal,start the backend:
python -m uvicorn backend.app.main:app --reload

In a third terminal, start the frontend:
python -m http.server 5500 --directory frontend


Open `http://127.0.0.1:5500` in your browser.