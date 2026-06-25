// Streams microphone audio as 16kHz mono int16 PCM to the gateway's
// /ws/audio WebSocket, surfaces real-time alerts, and aggregates the periodic
// STATUS metrics so a per-answer voice summary can be sent with the recording.
//
// PCM downsampling logic ported from Audio/manual_test_client.html.
//
// Pre-transcription: while the candidate speaks, raw PCM is also encoded as WAV
// chunks (every STT_CHUNK_SECONDS) and uploaded to /api/transcribe_partial so
// Whisper finishes most of its work before recording stops. submit_answer then
// skips the full Whisper pass and only waits for the LLM evaluation.

import { BASE_URL } from "./api";

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 0.1;
const ALERT_EVENTS = ["TOO_FAST", "PITCH_UNSTABLE", "LONG_SILENCE"];

// STT pre-transcription tuning
const STT_CHUNK_SECONDS = 15;             // upload a chunk every N seconds of speech
const STT_MIN_SECONDS = 2;               // skip flush if remaining audio is too short

function wsUrl() {
  const url = new URL("/ws/audio", BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function downsampleTo16k(input, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatToInt16(samples) {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return int16;
}

// Encode mono float32 PCM as a minimal WAV blob (no external dependency).
function encodeWav(samples, sampleRate) {
  const int16 = floatToInt16(samples);
  const buf = new ArrayBuffer(44 + int16.byteLength);
  const v = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + int16.byteLength, true);
  wr(8, "WAVE"); wr(12, "fmt ");
  v.setUint32(16, 16, true);  v.setUint16(20, 1, true);  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);   v.setUint16(34, 16, true);
  wr(36, "data"); v.setUint32(40, int16.byteLength, true);
  new Int16Array(buf, 44).set(int16);
  return new Blob([buf], { type: "audio/wav" });
}

export class AudioFeedbackStream {
  // onAlert(event), onStatus(statusObj), onError(err) are optional callbacks for live UI.
  // persona ("A"|"B"|"C"|"D") selects the interviewer strictness for alert thresholds.
  // customStrictness (1-5) is used when persona is "D" to interpolate thresholds.
  constructor({ onAlert, onStatus, onError, persona, customStrictness } = {}) {
    this.onAlert = onAlert;
    this.onStatus = onStatus;
    this.onError = onError;
    this.persona = persona || "B";
    this.customStrictness = customStrictness ?? null;
    this.ws = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.pending = [];
    this.statusSamples = []; // collected STATUS payloads for aggregation

    // STT pre-transcription state
    this.recordingId = null;
    this._sttBuffer = [];     // float32 samples accumulating toward next chunk
    this._sttSeq = 0;
    this._sttUploads = [];    // Promise[] — awaited in stop() before returning
  }

  // Reuse an existing mic MediaStream (e.g. the recorder's) so we don't open a second one.
  start(stream) {
    this.statusSamples = [];
    this.pending = [];
    this._sttBuffer = [];
    this._sttSeq = 0;
    this._sttUploads = [];
    this.recordingId = crypto.randomUUID();

    this.ws = new WebSocket(wsUrl());
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      const configMsg = { event: "config", dtype: "int16", vad_level: 2, persona: this.persona };
      if (this.persona === "D" && this.customStrictness !== null) {
        configMsg.custom_strictness = this.customStrictness;
      }
      this.ws.send(JSON.stringify(configMsg));

      this.audioContext = new AudioContext();
      this.source = this.audioContext.createMediaStreamSource(stream);
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      const chunkSize = Math.floor(TARGET_SAMPLE_RATE * CHUNK_SECONDS);
      const sttChunkSamples = STT_CHUNK_SECONDS * TARGET_SAMPLE_RATE;

      this.processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(input, this.audioContext.sampleRate);

        // --- STT pre-transcription accumulator (independent of WS state) ---
        this._sttBuffer.push(...downsampled);
        if (this._sttBuffer.length >= sttChunkSamples) {
          const chunk = new Float32Array(this._sttBuffer.splice(0, sttChunkSamples));
          this._uploadSttChunk(chunk);
        }

        // --- WebSocket DSP stream (existing) ---
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.pending.push(...downsampled);
        while (this.pending.length >= chunkSize) {
          const chunk = this.pending.slice(0, chunkSize);
          this.pending = this.pending.slice(chunkSize);
          this.ws.send(floatToInt16(chunk).buffer);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
    };

    this.ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.event === "STATUS") {
        this.statusSamples.push(message);
        this.onStatus?.(message);
      } else if (ALERT_EVENTS.includes(message.event)) {
        this.onAlert?.(message);
      }
    };

    // Surface connection failures instead of silently dropping real-time feedback.
    this.ws.onerror = () => {
      this.onError?.(new Error("실시간 음성 분석 서버에 연결하지 못했습니다."));
    };

    this.ws.onclose = (event) => {
      // 1000 = normal close (our own stop()). Anything else is unexpected.
      if (!event.wasClean && event.code !== 1000) {
        this.onError?.(new Error("실시간 음성 분석 연결이 끊어졌습니다."));
      }
    };
  }

  // Upload one STT chunk to the server for background transcription.
  // Failures are swallowed — submit_answer falls back to full Whisper if the
  // server store is empty.
  _uploadSttChunk(samples) {
    const seq = this._sttSeq++;
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
    const form = new FormData();
    form.append("recording_id", this.recordingId);
    form.append("seq", String(seq));
    form.append("audio", wav, `chunk_${seq}.wav`);
    const upload = fetch(`${BASE_URL}/api/transcribe_partial`, {
      method: "POST",
      body: form,
    }).catch(() => {});
    this._sttUploads.push(upload);
  }

  // Average the collected STATUS metrics into a single per-answer voice summary.
  getVoiceSummary() {
    const samples = this.statusSamples;
    if (!samples.length) return {};
    const keys = [
      "syllables_per_second",
      "pitch_mean_hz",
      "pitch_std_hz",
      "pitch_jitter_hz",
      "longest_silence_seconds",
      "speech_ratio",
    ];
    const summary = { sample_count: samples.length };
    for (const key of keys) {
      const values = samples.map((s) => s[key]).filter((v) => typeof v === "number");
      if (values.length) {
        summary[key] = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
      }
    }
    return summary;
  }

  async stop() {
    // Disconnect the processor first so onaudioprocess stops firing — the
    // buffer is then stable and we can safely flush the final chunk.
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    // Flush any remaining PCM that hasn't reached a full chunk yet.
    if (this._sttBuffer.length >= STT_MIN_SECONDS * TARGET_SAMPLE_RATE) {
      this._uploadSttChunk(new Float32Array(this._sttBuffer));
    }
    this._sttBuffer = [];

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.pending = [];

    // Wait for all chunk uploads to land before returning so that submit_answer
    // finds the partials in the server store and can skip the full Whisper call.
    await Promise.allSettled(this._sttUploads);
    this._sttUploads = [];
    this._sttSeq = 0;
  }
}
