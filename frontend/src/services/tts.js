// TTS for the interviewer avatar via backend proxy.
// Backend calls Typecast and returns { audio: base64_wav }.
// Frontend decodes the WAV, plays it via AudioContext, and drives the avatar
// jaw morph from audio amplitude (no viseme data required).
//
// Shared mouth state read each frame by the avatar: { visemes: {name:w}, amp }.

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export class Speaker {
  constructor(mouthState) {
    this.mouth = mouthState || { visemes: {}, amp: 0 };
    this.mouth.visemes = this.mouth.visemes || {};
    this.mouth.amp = this.mouth.amp || 0;
    this._ctx = null;
    this._source = null;
    this._raf = 0;
    this._token = 0;
  }

  setVisemes(dict) { this.mouth.visemes = dict || {}; }
  setAmp(v) { this.mouth.amp = v; }

  async speak(text, opts = {}) {
    text = (text || "").trim();
    if (!text) { opts.onEnd?.(); return; }
    this.cancel();
    const token = ++this._token;
    try {
      await this._typecastSpeak(text, opts, token);
    } catch (e) {
      if (token !== this._token) return;
      console.warn("TTS 실패 → 브라우저 TTS 사용:", e.message);
      this._webSpeechSpeak(text, opts, token);
    }
  }

  async _typecastSpeak(text, { rate = 1, pitch = 1, onStart, onEnd } = {}, token) {
    const resp = await fetch(`${BASE_URL}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, rate, pitch }),
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    if (token !== this._token) return;

    const data = await resp.json();
    if (token !== this._token) return;

    // base64 WAV → ArrayBuffer
    const audioBytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0)).buffer;

    const ctx = this._ctx || (this._ctx = new (window.AudioContext || window.webkitAudioContext)());
    await ctx.resume();
    const audioBuf = await ctx.decodeAudioData(audioBytes);
    if (token !== this._token) return;

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    this._source = src;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    const timeDomainBuf = new Uint8Array(analyser.fftSize);

    onStart?.();
    src.onended = () => {
      if (token === this._token) { this._stopMouth(); onEnd?.(); }
    };

    src.start();

    const drive = () => {
      if (token !== this._token || this._source !== src) return;

      analyser.getByteTimeDomainData(timeDomainBuf);
      let s = 0;
      for (let i = 0; i < timeDomainBuf.length; i++) {
        const v = (timeDomainBuf[i] - 128) / 128;
        s += v * v;
      }
      this.setAmp(Math.min(1, Math.sqrt(s / timeDomainBuf.length) * 3.2));

      this._raf = requestAnimationFrame(drive);
    };
    drive();
  }

  _webSpeechSpeak(text, { onStart, onEnd } = {}, token) {
    if (typeof speechSynthesis === "undefined") { onEnd?.(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    let done = false;
    const finish = () => {
      if (done || token !== this._token) return;
      done = true;
      cancelAnimationFrame(this._raf);
      this._stopMouth();
      onEnd?.();
    };
    u.onstart = () => { onStart?.(); };
    u.onend = u.onerror = finish;
    speechSynthesis.speak(u);
  }

  _stopMouth() { this.setVisemes({}); this.setAmp(0); }

  cancel() {
    this._token++;
    cancelAnimationFrame(this._raf);
    if (this._source) {
      try { this._source.onended = null; this._source.stop(); } catch { /* already stopped */ }
      this._source = null;
    }
    try { if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); } catch { /* ignore */ }
    this._stopMouth();
  }
}
