import os
import threading
import numpy as np
import torch
from faster_whisper import WhisperModel

class Transcriber:
    def __init__(self):
        name = os.getenv("WHISPER_MODEL", "small")
        device = os.getenv("WHISPER_DEVICE", "cpu")
        self.model = WhisperModel(name, device=device, compute_type="int8" if device == "cpu" else "float16")
        self.lock = threading.Lock()

    def transcribe(self, audio: np.ndarray) -> str:
        if audio.size < 1600:
            return ""
        with self.lock:
            segments, _ = self.model.transcribe(
                audio,
                language="en",
                vad_filter=False,
                beam_size=3,
                condition_on_previous_text=False,
                initial_prompt=(
                    "Clinical consultation in English. "
                    "The following may include medical terminology, "
                    "patient names, ages, symptoms, medication names, "
                    "dosages, allergies, medical history, vital signs, "
                    "diagnoses, investigations, and follow-up plans. "
                    "Transcribe the speech faithfully. "
                    "Preserve numbers, units, negations, and uncertainty. "
                    "Do not summarize or add words that were not spoken."
                ),
    )
            return " ".join(segment.text.strip() for segment in segments).strip()

class SpeechGate:
    """Silero VAD speech gate for 16 kHz float32 audio."""
    def __init__(self):
        from silero_vad import load_silero_vad
        self.model = load_silero_vad()
        self.threshold = float(os.getenv("VAD_THRESHOLD", "0.5"))
        self.silence_seconds = float(os.getenv("VAD_SILENCE_SECONDS", "0.6"))
        self.max_seconds = float(os.getenv("MAX_AUDIO_SECONDS", "20"))
        self.frame_samples = 512
        self.pending = np.empty(0, dtype=np.float32)
        self.speech_frames = []
        self.speech_started = False
        self.silence_samples = 0
        self.segment_samples = 0

    def reset(self):
        self.pending = np.empty(0, dtype=np.float32)
        self.speech_frames = []
        self.speech_started = False
        self.silence_samples = 0
        self.segment_samples = 0
        self.model.reset_states()

    def process(self, samples: np.ndarray):
        completed = []
        self.pending = np.concatenate((self.pending, np.asarray(samples, dtype=np.float32).flatten()))
        while len(self.pending) >= self.frame_samples:
            frame, self.pending = self.pending[:self.frame_samples], self.pending[self.frame_samples:]
            probability = float(self.model(torch.from_numpy(frame.copy()), 16000).item())
            if probability >= self.threshold:
                if not self.speech_started:
                    self.speech_started = True
                    self.speech_frames = []
                    self.segment_samples = 0
                self.speech_frames.append(frame)
                self.silence_samples = 0
            elif self.speech_started:
                self.speech_frames.append(frame) 
                self.silence_samples += len(frame)
            self.segment_samples += len(frame) if self.speech_started else 0
            if self.speech_started and (
                self.silence_samples >= self.silence_seconds * 16000
                or self.segment_samples >= self.max_seconds * 16000
            ):
                audio = np.concatenate(self.speech_frames)
                if audio.size:
                    completed.append(audio)
                self.speech_frames = []
                self.speech_started = False
                self.silence_samples = 0
                self.segment_samples = 0
                self.model.reset_states()
        return completed

    def flush(self):
        if self.speech_started and self.speech_frames:
            audio = np.concatenate(self.speech_frames)
        else:
            audio = None
        self.reset()
        return audio
