
const API_BASE = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000/ws/transcribe";

const $ = (id) => document.getElementById(id);
const state = {
  recording: false, transcript: "", note: null, ws: null, stream: null,
  audioContext: null, source: null, processor: null, recorder: null, recordedChunks: [], recordedBlob: null, chunkCount: 0, startedAt: 0, timer: null,
  stopRequested: false, socketReady: false
};

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = "toast"; }, 3200);
}
function setServiceStatus(message, ready = false) {
  $("serviceStatus").textContent = message;
  $("serviceDot").classList.toggle("ready", ready);
}
function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}
function updateTranscript(text) {
  state.transcript = text;
  const box = $("transcriptBox");
  box.textContent = "";
  if (!text.trim()) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<span class="empty-icon">≋</span><strong>Waiting for speech</strong><p>Start recording to see the conversation transcribed here.</p>';
    box.appendChild(empty);
  } else {
    box.textContent = text;
  }
  $("wordCount").textContent = `${text.trim() ? text.trim().split(/\s+/).length : 0}`;
  box.scrollTop = box.scrollHeight;
}
async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) throw new Error("API unavailable");
    const data = await response.json();
    if (data.asr_ready) setServiceStatus(`Local services ready · ${data.whisper_model} Whisper`, true);
    else setServiceStatus(`Backend online; ASR unavailable${data.asr_error ? ": " + data.asr_error : ""}`, false);
  } catch {
    setServiceStatus("Backend offline — start the Python API", false);
  }
}
function floatToPcm16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Uint8Array(buffer);
}
function resample(input, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0, count = 0;
    for (let j = start; j < end; j++) { sum += input[j]; count++; }
    output[i] = count ? sum / count : 0;
  }
  return output;
}
function arrayBufferToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
async function startRecording() {
  if (state.recording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Microphone access is unavailable. Open the app on localhost or HTTPS.", true); return;
  }
  $("startBtn").disabled = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    state.recordedChunks = []; state.recordedBlob = null;
    if (window.MediaRecorder) {
      state.recorder = new MediaRecorder(state.stream);
      state.recorder.ondataavailable = (event) => { if (event.data?.size) state.recordedChunks.push(event.data); };
      state.recorder.onstop = () => { state.recordedBlob = new Blob(state.recordedChunks, { type: state.recorder?.mimeType || "audio/webm" }); };
      state.recorder.start(1000);
    }
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await state.audioContext.resume();
    state.source = state.audioContext.createMediaStreamSource(state.stream);
    // ScriptProcessorNode is deprecated but broadly supported for this simple starter.
    // A production implementation should use AudioWorklet.
    state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.ws = new WebSocket(WS_BASE);
    state.stopRequested = false;
    state.socketReady = false;
    state.ws.onopen = () => { state.socketReady = true; };
    state.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "status" && msg.message === "ready") {
        state.recording = true;
        state.startedAt = Date.now();
        $("recordingState").textContent = "Recording consultation";
        $("recordingCaption").textContent = "Speech detection is active";
        $("recordingVisual").classList.add("active");
        $("livePulse").classList.add("active");
        $("micGlyph").textContent = "🎙";
        $("startBtn").disabled = true;
        $("stopBtn").disabled = false;
        state.timer = setInterval(() => $("timer").textContent = formatTime(Math.floor((Date.now()-state.startedAt)/1000)), 1000);
        toast("Recording started. Speak naturally.");
      } else if (msg.type === "transcript") {
        updateTranscript(msg.full_transcript || (state.transcript + " " + msg.text).trim());
        state.chunkCount++; $("chunkCount").textContent = state.chunkCount;
      } else if (msg.type === "stopped") {
        updateTranscript(msg.full_transcript || state.transcript);
        finalizeStop();
      } else if (msg.type === "error") {
        toast(msg.message || "Audio processing error", true);
      }
    };
    state.ws.onerror = () => toast("WebSocket connection failed. Check that the backend is running.", true);
    state.ws.onclose = () => {
      if (state.recording && !state.stopRequested) {
        toast("Connection closed unexpectedly.", true);
        finalizeStop();
      }
    };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Backend did not respond in time")), 10000);
      const poll = setInterval(() => {
        if (state.socketReady) { clearInterval(poll); clearTimeout(timeout); resolve(); }
        if (state.ws?.readyState === WebSocket.CLOSED) { clearInterval(poll); clearTimeout(timeout); reject(new Error("Could not connect to transcription backend")); }
      }, 50);
    });
    state.processor.onaudioprocess = (event) => {
      if (!state.recording || !state.socketReady || state.ws?.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const samples = resample(input, state.audioContext.sampleRate, 16000);
      if (!samples.length) return;
      state.ws.send(JSON.stringify({ type: "audio", data: arrayBufferToBase64(floatToPcm16(samples)) }));
    };
    state.source.connect(state.processor);
    state.processor.connect(state.audioContext.destination);
    // Mute processor output to avoid microphone feedback.
    const mute = state.audioContext.createGain(); mute.gain.value = 0;
    state.processor.connect(mute); mute.connect(state.audioContext.destination);
    state.mute = mute;
  } catch (error) {
    await cleanupAudio();
    state.ws?.close();
    $("startBtn").disabled = false;
    toast(error.message || "Could not start recording", true);
  }
}
function finalizeStop() {
  state.recording = false;
  state.stopRequested = false;
  clearInterval(state.timer);
  $("recordingState").textContent = "Recording stopped";
  $("recordingCaption").textContent = "Review the transcript before generating the note";
  $("recordingVisual").classList.remove("active");
  $("livePulse").classList.remove("active");
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  if (state.recorder && state.recorder.state !== "inactive") { try { state.recorder.stop(); } catch {} }
  cleanupAudio();
}
function cleanupAudio() {
  try { state.processor?.disconnect(); } catch {}
  try { state.source?.disconnect(); } catch {}
  try { state.mute?.disconnect(); } catch {}
  state.stream?.getTracks().forEach(track => track.stop());
  if (state.audioContext && state.audioContext.state !== "closed") state.audioContext.close().catch(()=>{});
  state.processor = state.source = state.mute = state.stream = state.audioContext = null;
}
function stopRecording() {
  if (!state.recording || state.stopRequested) return;
  state.stopRequested = true;
  $("recordingState").textContent = "Finishing speech segment…";
  $("recordingCaption").textContent = "Waiting for the final transcription";
  $("stopBtn").disabled = true;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "stop" }));
  else finalizeStop();
}
function safeText(value) {
  if (value === null || value === undefined || value === "") return "Not mentioned";
  if (Array.isArray(value)) return value.length ? value.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)).join("; ") : "Not mentioned";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function displayValue(value) { return safeText(value); }
function createField(label, value, path) {
  const wrap = document.createElement("label"); wrap.className = "field";
  const title = document.createElement("span"); title.textContent = label; wrap.appendChild(title);
  const multi = Array.isArray(value) || (typeof value === "string" && value.length > 90);
  const input = document.createElement(multi ? "textarea" : "input");
  input.value = Array.isArray(value) ? value.join("\n") : (value ?? "");
  input.placeholder = "Not mentioned in transcript";
  if (multi) input.rows = 3;
  input.dataset.path = path;
  input.addEventListener("change", () => {
    const val = multi ? input.value.split("\n").map(s=>s.trim()).filter(Boolean) : (input.value.trim() || null);
    setPath(state.note, path.split("."), val);
  });
  wrap.appendChild(input); return wrap;
}
function setPath(obj, path, value) {
  let current = obj;
  for (const key of path.slice(0,-1)) current = current[key];
  current[path[path.length-1]] = value;
}
function renderNote(note) {
  state.note = note;
  const root = $("noteContent"); root.textContent = "";
  const patient = note.patient_details || {};
  $("patientName").textContent = `Patient Name: ${safeText(patient.name)}`;
  const transcriptText = state.transcript || "";
const ageMatch = transcriptText.match(/\b(?:age\s*(?:is|:)?\s*)(\d{1,3})\b/i);

const rawAge = String(patient.age ?? "").trim();

const validAge =
  /^\d{1,3}$/.test(rawAge) && Number(rawAge) <= 120
    ? rawAge
    : null;

const displayedAge = validAge || ageMatch?.[1] || "Not mentioned";

$("patientMeta").textContent =
  `Age: ${displayedAge}   Gender: ${safeText(patient.sex)}`;
  const summary = document.createElement("section"); summary.className = "summary-section";
  summary.innerHTML = '<h3>▤ CLINICAL SUMMARY</h3>';
  const summaryText = document.createElement("textarea"); summaryText.rows = 3; summaryText.value = note.concise_summary || ""; summaryText.placeholder = "AI-generated clinical summary will appear here…";
  summaryText.addEventListener("change", () => { note.concise_summary = summaryText.value; });
  summary.appendChild(summaryText); root.appendChild(summary);
  const sections = [
    ["☷ CHIEF COMPLAINTS", [["Primary reason for visit", "chief_complaint"]]],
    ["♙ SYMPTOMS", [["Positive symptoms", "symptoms.positives"], ["Stated negatives", "symptoms.stated_negatives"]]],
    ["♧ CLINICAL IMPRESSION", [["Provisional diagnosis", "assessment.provisional_diagnosis"], ["Differentials", "assessment.differentials"]]],
    ["▤ MEDICATIONS", [["Medication history", "medication_history"], ["Prescriptions", "plan.prescriptions"]]],
    ["♙ EXAMINATIONS & TESTS", [["Vitals", "clinical_observations.vitals"], ["Examination findings", "clinical_observations.examination_findings"], ["Investigations", "plan.investigations"]]],
    ["⚠ ALLERGIES", [["Known allergies", "known_allergies"]]],
    ["◷ PAST MEDICAL HISTORY", [["Conditions, surgeries, hospitalisations", "past_medical_history"]]],
    ["▦ HISTORY & FOLLOW-UP", [["History of present illness", "history_of_present_illness.narrative"], ["Onset / duration / progression", "history_of_present_illness.duration"], ["Advice", "plan.advice"], ["Follow-up", "plan.follow_up"]]]
  ];
  for (const [heading, fields] of sections) {
    const section = document.createElement("section"); section.className = "summary-section";
    const h = document.createElement("h3"); h.textContent = heading; section.appendChild(h);
    const grid = document.createElement("div"); grid.className = "field-grid";
    for (const [label,path] of fields) {
      const value = path.split(".").reduce((o,k)=>o?.[k], note);
      grid.appendChild(createField(label, value, path));
    }
    section.appendChild(grid); root.appendChild(section);
  }
  $("noteStatus").textContent = "Draft generated · review required";
  $("copyBtn").disabled = false; $("downloadBtn").disabled = false;
}

async function generateNote() {
  const text = ($("manualTranscript").value.trim() || state.transcript.trim());
  if (!text) { toast("Record a consultation or enter a transcript first.", true); return; }
  $("generateBtn").disabled = true;
  $("generateBtn").textContent = "Generating…";
  $("noteStatus").textContent = "Local LLM is analyzing transcript…";
  try {
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ transcript: text })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not generate clinical note");
    renderNote(data.note);
    toast(`Draft generated with local model ${data.model}. Please review every field.`);
  } catch (error) {
    $("noteStatus").textContent = "Could not generate note";
    toast(error.message, true);
  } finally {
    $("generateBtn").disabled = false;
    $("generateBtn").innerHTML = "<span>✧</span> Generate note";
  }
}
function noteAsText(note) {
  const lines = [];
  const add = (title, value) => lines.push(`${title}: ${safeText(value)}`);
  add("Patient details", note.patient_details);
  add("Chief complaint", note.chief_complaint);
  add("History of present illness", note.history_of_present_illness);
  add("Positive symptoms", note.symptoms?.positives);
  add("Stated negatives", note.symptoms?.stated_negatives);
  add("Past medical history", note.past_medical_history);
  add("Medication history", note.medication_history);
  add("Known allergies", note.known_allergies);
  add("Clinical observations", note.clinical_observations);
  add("Assessment", note.assessment);
  add("Plan", note.plan);
  add("Concise summary", note.concise_summary);
  add("Uncertainties or conflicts", note.uncertainties_or_conflicts);
  add("Items for clinician review", note.items_for_clinician_review);
  return lines.join("\n\n");
}
$("saveRecordingBtn").addEventListener("click", () => {
  if (!state.recordedBlob) { toast("Record audio first, then stop to save it.", true); return; }
  const url = URL.createObjectURL(state.recordedBlob);
  const a = document.createElement("a"); a.href = url; a.download = "consultation-recording.webm"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("clearSummaryBtn").addEventListener("click", () => {
  state.note = null; $("patientName").textContent = "Patient Name: -"; $("patientMeta").textContent = "Age: - Gender: -";
  $("noteContent").innerHTML = '<section class="summary-section"><h3>▤ CLINICAL SUMMARY</h3><textarea id="clinicalSummary" placeholder="AI-generated clinical summary will appear here…" rows="3"></textarea></section><section class="summary-section"><h3>☷ CHIEF COMPLAINTS</h3><p class="placeholder">No complaints extracted yet</p></section><section class="summary-section"><h3>♙ SYMPTOMS</h3><p class="placeholder">No symptoms extracted yet</p></section><section class="summary-section"><h3>♧ CLINICAL IMPRESSION</h3><p class="placeholder">No diagnosis inferred</p></section><section class="summary-section"><h3>▤ MEDICATIONS</h3><p class="placeholder">No medications extracted yet</p></section><section class="summary-section"><h3>♙ EXAMINATIONS &amp; TESTS</h3><p class="placeholder">No examinations extracted yet</p></section><section class="summary-section"><h3>⚠ ALLERGIES</h3><p class="placeholder">No allergies extracted yet</p></section><section class="summary-section"><h3>◷ PAST MEDICAL HISTORY</h3><p class="placeholder">No past medical history extracted yet</p></section><section class="summary-section"><h3>▦ HISTORY &amp; FOLLOW-UP</h3><p class="placeholder">No history or follow-up extracted yet</p></section>';
  $("copyBtn").disabled = true; $("downloadBtn").disabled = true; $("noteStatus").textContent = "No note generated"; toast("Summary cleared.");
});
$("startBtn").addEventListener("click", startRecording);
$("stopBtn").addEventListener("click", stopRecording);
$("generateBtn").addEventListener("click", generateNote);
$("clearTranscriptBtn").addEventListener("click", () => { updateTranscript(""); $("manualTranscript").value = ""; state.chunkCount = 0; $("chunkCount").textContent = "0"; toast("Transcript cleared."); });
$("copyBtn").addEventListener("click", async () => {
  if (!state.note) return;
  try { await navigator.clipboard.writeText(noteAsText(state.note)); toast("Clinical note copied."); }
  catch { toast("Clipboard access denied by browser.", true); }
});
$("downloadBtn").addEventListener("click", () => {
  if (!state.note) return;
  const blob = new Blob([JSON.stringify(state.note,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "clinical-note-draft.json"; a.click();
  URL.revokeObjectURL(url);
});
checkHealth();
setInterval(checkHealth, 30000);
