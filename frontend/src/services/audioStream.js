// Streams microphone audio as 16kHz mono int16 PCM to the gateway's
// /ws/audio WebSocket, surfaces real-time alerts, and aggregates the periodic
// STATUS metrics so a per-answer voice summary can be sent with the recording.
//
// PCM downsampling logic ported from Audio/manual_test_client.html.

import { BASE_URL } from "./api";

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 0.1;
const ALERT_EVENTS = ["TOO_FAST", "PITCH_UNSTABLE", "LONG_SILENCE"];

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

export class AudioFeedbackStream {
  // onAlert(event), onStatus(statusObj) are optional callbacks for live UI.
  constructor({ onAlert, onStatus } = {}) {
    this.onAlert = onAlert;
    this.onStatus = onStatus;
    this.ws = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.pending = [];
    this.statusSamples = []; // collected STATUS payloads for aggregation
  }

  // Reuse an existing mic MediaStream (e.g. the recorder's) so we don't open a second one.
  start(stream) {
    this.statusSamples = [];
    this.pending = [];
    this.ws = new WebSocket(wsUrl());
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ event: "config", dtype: "int16", vad_level: 2 }));

      this.audioContext = new AudioContext();
      this.source = this.audioContext.createMediaStreamSource(stream);
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      const chunkSize = Math.floor(TARGET_SAMPLE_RATE * CHUNK_SECONDS);

      this.processor.onaudioprocess = (event) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(input, this.audioContext.sampleRate);
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
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.pending = [];
  }
}
