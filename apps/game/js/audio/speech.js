// Spoken unit replies and announcer lines through the browser's Web Speech API
// (speechSynthesis). Voices differ per operating system and some browsers have
// none, so speech is optional (a setting) and every line also has a
// synthesized cue. The API cannot be routed through Web Audio, so the "radio"
// feel comes from squelch clicks around the line (index.js), plus pitch and
// rate per role.

const ROLES = {
  // Announcer: calm, slightly low, clear.
  eva: { pitch: 0.85, rate: 1.0, prefer: /female|samantha|zira|susan|serena|karen|moira|tessa|google uk english female/i },
  // Units: quick radio chatter.
  unit: { pitch: 1.0, rate: 1.2, prefer: /male|daniel|alex|fred|david|george|google uk english male/i },
};

export class Speech {
  constructor(synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
    this.synth = synth ?? null;
    this.Utterance = Utterance ?? null;
    this.voices = { eva: null, unit: null };
    if (this.available) {
      this.pickVoices();
      // Chrome loads its voice list asynchronously.
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoices());
    }
  }

  get available() {
    return !!(this.synth && this.Utterance);
  }

  get speaking() {
    return !!this.synth?.speaking;
  }

  pickVoices() {
    const all = this.synth.getVoices?.() ?? [];
    const english = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
    const pool = english.length ? english : all;
    for (const role of Object.keys(ROLES)) {
      this.voices[role] = pool.find((v) => ROLES[role].prefer.test(v.name)) ?? pool.find((v) => v.default) ?? pool[0] ?? null;
    }
  }

  /**
   * Speak `text`; resolves when done (or after a timeout, since some engines
   * never fire `end`).
   */
  speak(text, { role = 'eva', volume = 1 } = {}) {
    if (!this.available || volume <= 0) return Promise.resolve(false);
    const r = ROLES[role] ?? ROLES.eva;
    const u = new this.Utterance(text);
    if (this.voices[role]) u.voice = this.voices[role];
    u.lang = this.voices[role]?.lang ?? 'en-US';
    u.pitch = r.pitch;
    u.rate = r.rate;
    u.volume = Math.max(0, Math.min(1, volume));
    return new Promise((resolve) => {
      const limit = setTimeout(() => resolve(true), 600 + text.length * 120);
      const end = () => {
        clearTimeout(limit);
        resolve(true);
      };
      u.onend = end;
      u.onerror = end;
      this.synth.speak(u);
    });
  }

  cancel() {
    if (this.available) this.synth.cancel();
  }
}
