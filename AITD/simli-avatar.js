/**
 * Real World CE dedicated streaming-avatar component.
 * The Simli API key is NEVER used in this module, only a server-minted session token.
 * Simli SDK 3.2.0, LiveKit default; audio comes solely from existing Gemini TTS.
 */
const SDK_URL = "https://cdn.jsdelivr.net/npm/simli-client@3.2.0/+esm";
let sdkLoader;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SimliAvatar {
  constructor({video, audio, mintToken, onReady=()=>{}, onStop=()=>{}, onStatus=()=>{}, onWarning=()=>{}}) {
    if (!(video instanceof HTMLVideoElement) || !(audio instanceof HTMLAudioElement)) {
      throw Error("Avatar video and audio elements are required");
    }
    this.video = video;
    this.audio = audio;
    this.mintToken = mintToken;
    this.onReady = onReady;
    this.onStop = onStop;
    this.onStatus = onStatus;
    this.onWarning = onWarning;
    this.client = null;
    this.connected = false;
    this.starting = null;
    this.stopping = false;
    this.cancelled = false;
    this.sequence = 0;
    this.finishSpeech = null;
    this.didSpeak = false;
    this.lastVideoInfo = null;
    this.audio.autoplay = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true; // Rendered video is silent; audio element plays the synced voice.
  }

  async start() {
    if (this.connected) return true;
    if (this.starting) return this.starting;
    this.cancelled = false;
    this.starting = this._start();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async _start() {
    this.onStatus("Preparing live educator video...");
    // Only a short-lived session token is returned to the browser.
    sdkLoader ||= import(SDK_URL);
    const [sdk, data] = await Promise.all([sdkLoader, this.mintToken()]);
    if (!data?.session_token) throw Error("Avatar session token missing");
    if (this.cancelled) return false;
    const client = new sdk.SimliClient(data.session_token, this.video, this.audio, null, sdk.LogLevel.INFO);
    this.client = client;
    client.on("start", () => {
      if (this.cancelled) return;
      this.connected = true;
      this.onReady();
      // Browser autoplay policy can block sound until the learner clicks.
      this.audio.play().catch(() => this.onStatus("Tap the page once to enable the educator's sound."));
    });
    client.on("stop", () => {
      this.connected = false;
      this.finishSpeech?.();
      this.finishSpeech = null;
      this.onStop();
    });
    client.on("error", (reason) => {
      this.connected = false;
      this.finishSpeech?.();
      this.finishSpeech = null;
      this.onStatus("Video session unavailable: " + String(reason).slice(0,180));
    });
    client.on("startup_error", (reason) => {
      // SDK retries transport failures itself with backoff, not provider refusals.
      console.warn("Real World CE video network retry", reason);
      this.onStatus("Reconnecting educator video...");
    });
    client.on("warning", (reason) => { console.warn("Real World CE avatar warning", reason); this.onWarning(reason); });
    client.on("video_info", (serialized) => {
      try {
        const data = JSON.parse(serialized);
        const v = data.video_metadata || {};
        this.lastVideoInfo = v;
        console.info("TD educator video", v.width, v.height, v.fps);
      } catch {}
    });
    client.on("speaking", () => { this.didSpeak = true; this.onStatus("Your educator is speaking..."); });
    client.on("silent", () => {
      if (this.didSpeak && this.finishSpeech) {
        this.finishSpeech();
        this.finishSpeech = null;
        this.didSpeak = false;
        this.onStatus("Ready for another TD question.");
      }
    });
    // start() resolves on the first video frame; Simli handles network retry internally.
    try {
      await client.start();
      if (this.cancelled) { await client.stop().catch(()=>{}); return false; }
      if (!this.connected) { this.connected=true; this.onReady(); }
      return true;
    } catch (reason) {
      this.connected = false;
      this.client = null;
      try { await client.stop(); } catch {}
      // Propagate the actual rejection reason (including no minutes, invalid face/token).
      throw Error(typeof reason === "string" ? reason : reason?.message || String(reason));
    }
  }

  interrupt() {
    ++this.sequence;
    try { this.client?.ClearBuffer(); } catch (e) { console.warn("Avatar buffer interrupt", e); }
    if (this.finishSpeech) { this.finishSpeech(); this.finishSpeech = null; }
    this.didSpeak = false;
  }

  async speakWav(wavBytes) {
    if (!this.connected || !this.client) return false;
    // The voice endpoint sends WAV (usually PCM16 24 kHz); decode and resample to raw PCM16 16 kHz mono.
    const context = new (window.AudioContext || window.webkitAudioContext)();
    let pcm, duration;
    try {
      const decoded = await context.decodeAudioData(wavBytes.slice(0));
      duration = decoded.duration;
      const target = new OfflineAudioContext(1, Math.ceil(duration * 16000), 16000);
      const source = target.createBufferSource();
      source.buffer = decoded;
      source.connect(target.destination);
      source.start();
      const rendered = await target.startRendering();
      const floats = rendered.getChannelData(0);
      pcm = new Uint8Array(floats.length * 2);
      const view = new DataView(pcm.buffer);
      for (let i=0;i<floats.length;i++) {
        const x = Math.max(-1, Math.min(1, floats[i]));
        view.setInt16(i*2, x < 0 ? x*32768 : x*32767, true);
      }
    } finally { await context.close().catch(()=>{}); }
    if (!this.connected || !this.client || pcm.byteLength < 100) return false;
    this.interrupt(); // Drop any unfinished previous answer before sending another.
    const seq = this.sequence;
    const done = new Promise(resolve => { this.finishSpeech = resolve; });
    this.onStatus("Your educator is preparing to speak...");
    try {
      // 6000-byte chunks are the SDK's documented size; allow the transport to drain.
      for (let i=0;i<pcm.length;i+=6000) {
        if (seq !== this.sequence || !this.connected || !this.client) return false;
        this.client.sendAudioData(pcm.subarray(i, Math.min(i+6000,pcm.length)));
        // Avoid flooding transport buffers; much faster than the model's full WAV generation.
        if (i+6000 < pcm.length) await sleep(35);
      }
      await Promise.race([done, sleep(Math.min(90000,Math.max(5000, duration*1000+10000)))]);
      if (seq === this.sequence) { this.finishSpeech = null; this.didSpeak = false; }
      return seq === this.sequence;
    } catch (e) {
      this.interrupt();
      throw e;
    }
  }

  setMuted(isMuted) { this.audio.muted = Boolean(isMuted); }
  setCamera(camera, opts) { if (this.connected) this.client?.setCamera(camera, opts); }
  setBackground(id) { if (this.connected) this.client?.setBackground(id); }
  setForeground(id) { if (this.connected) this.client?.setForeground(id); }

  async stop() {
    this.cancelled = true;
    this.interrupt();
    if (this.stopping) return;
    this.stopping = true;
    const client = this.client;
    this.client = null;
    this.connected = false;
    try { await client?.stop(); }
    catch (e) { console.warn("Video stop", e); }
    finally {
      this.stopping = false;
      try { this.video.pause(); this.video.srcObject = null; } catch {}
      try { this.audio.pause(); this.audio.srcObject = null; } catch {}
    }
  }
}
