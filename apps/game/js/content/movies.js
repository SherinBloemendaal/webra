// The original Red Alert movies (Media.PlayMovieFullscreen in the mission
// scripts), played from the player's own installed content
// (content/install.js stores the .vqa files, content/vqa.js decodes them).
// Presentation only: the mission goes on in the engine while a movie plays,
// and without the movie the game shows a card instead (campaign/view.js).
//
// The player: a full screen overlay with a canvas that shows the frames at
// the movie's frame rate (decoded a few at a time per animation frame, never
// all up front) and the sound track through Web Audio. A click, Esc, Space
// or Enter skips it.

import { openVqa } from './vqa.js';

/**
 * The movies OpenRA's content installer takes from the Red Alert CDs
 * (mods/ra-content mod.yaml, the movies-allied and movies-soviet packages:
 * movies1.mix on the Allied disc, movies2.mix on the Soviet disc).
 */
export const MOVIE_FILES = Object.freeze(
  new Set(
    [
      // movies-allied
      'aagun', 'aftrmath', 'ally1', 'ally10', 'ally10b', 'ally11', 'ally12', 'ally14', 'ally2', 'ally4', 'ally5', 'ally6', 'ally8', 'ally9',
      'allyend', 'allymorf', 'apcescpe', 'assess', 'battle', 'binoc', 'bmap', 'brdgtilt', 'crontest', 'cronfail', 'destroyr', 'dud',
      'elevator', 'flare', 'frozen', 'grvestne', 'landing', 'masasslt', 'mcv', 'mcv_land', 'montpass', 'oildrum', 'overrun', 'prolog',
      'redintro', 'shipsink', 'shorbom1', 'shorbom2', 'shorbomb', 'snowbomb', 'soviet1', 'sovtstar', 'spy', 'tanya1', 'tanya2', 'toofar',
      'trinity',
      // movies-soviet (the ones not above)
      'airfield', 'averted', 'beachead', 'bombrun', 'countdwn', 'double', 'dpthchrg', 'execute', 'mcvbrdge', 'mig', 'movingin',
      'mtnkfact', 'nukestok', 'onthprwl', 'periscop', 'radrraid', 'search', 'sfrozen', 'sitduck', 'slntsrvc', 'snstrafe', 'sovbatl',
      'sovcemet', 'sovfinal', 'soviet10', 'soviet11', 'soviet12', 'soviet13', 'soviet14', 'soviet2', 'soviet3', 'soviet4', 'soviet5',
      'soviet6', 'soviet7', 'soviet8', 'soviet9', 'sovmcv', 'spotter', 'strafe', 'take_off', 'tesla', 'v2rocket',
    ].map((n) => `${n}.vqa`),
  ),
);

/** Whether a stored file name is a movie. */
export const isMovieName = (name) => /\.vqa$/i.test(name);

/** The stored name of a movie the scripts ask for ("LANDING.VQA", "movies/landing.vqa": "landing.vqa"). */
export function movieKey(file) {
  const name = String(file ?? '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return isMovieName(name) ? name : `${name}.vqa`;
}

/** Frames decoded at most per animation frame (a movie that fell behind catches up without blocking the page). */
export const DECODE_PER_TICK = 4;

const SKIP_KEYS = new Set(['Escape', ' ', 'Enter']);

/**
 * @param {{
 *   content: { hasMovie(name: string): boolean, movieBytes(name: string): Promise<Uint8Array | null> },
 *   audio?: () => ({ context: AudioContext, destination: AudioNode } | null),  where the sound goes; null plays the movie silent
 *   raf?: (fn: FrameRequestCallback) => number, cancelRaf?: (id: number) => void, now?: () => number,  ms
 * }} o
 */
export function createMoviePlayer({
  content,
  audio = () => null,
  raf = (fn) => globalThis.requestAnimationFrame(fn),
  cancelRaf = (id) => globalThis.cancelAnimationFrame(id),
  now = () => performance.now(),
}) {
  /** The movie on screen (or loading): { finish(result) }. */
  let current = null;

  const el = (tag, className, text) => {
    const e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** The sound track as a playing source, or null (no sound, audio locked or a sound track that does not decode). */
  function startSound(video, name) {
    let out;
    try {
      out = audio();
      if (!out || !video.hasAudio) return null;
      const pcm = video.decodeAudio();
      if (!pcm || !pcm.data[0].length) return null;
      const ctx = out.context;
      const buffer = ctx.createBuffer(pcm.channels, pcm.data[0].length, pcm.sampleRate);
      pcm.data.forEach((d, ch) => buffer.copyToChannel(d, ch));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out.destination);
      const at = ctx.currentTime + 0.05;
      source.start(at);
      return { source, context: ctx, at, duration: buffer.duration };
    } catch (err) {
      console.warn(`Movie ${name}: no sound (${err.message ?? err})`);
      return null;
    }
  }

  const player = {
    /** Whether the movie is installed. */
    has(file) {
      return !!file && content.hasMovie(movieKey(file));
    },

    /** Whether a movie is on screen or loading. */
    get playing() {
      return current !== null;
    },

    /** End the movie on screen (as skipped). */
    stop() {
      current?.finish('skipped');
    },

    /**
     * Play a movie full screen over `parent`. Resolves when it ends:
     * 'played', 'skipped' (by the player, or `stop`, or another movie),
     * 'missing' (not installed) or 'failed' (it does not decode).
     * @param {string} file
     * @param {HTMLElement} parent
     * @returns {Promise<'played' | 'skipped' | 'missing' | 'failed'>}
     */
    play(file, parent) {
      const name = movieKey(file);
      if (!content.hasMovie(name)) return Promise.resolve('missing');
      player.stop();
      return new Promise((resolve) => {
        let overlay = null;
        let sound = null;
        let frameId = null;
        const onKey = (e) => {
          if (!SKIP_KEYS.has(e.key)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          session.finish('skipped');
        };
        const session = {
          done: false,
          finish(result) {
            if (session.done) return;
            session.done = true;
            if (current === session) current = null;
            if (frameId !== null) cancelRaf(frameId);
            window.removeEventListener('keydown', onKey, true);
            if (sound) {
              try {
                sound.source.stop();
              } catch {
                // not started or already ended
              }
              sound.source.disconnect();
            }
            overlay?.remove();
            resolve(result);
          },
        };
        current = session;
        window.addEventListener('keydown', onKey, true);

        const fail = (err) => {
          console.warn(`Movie ${name} could not be played: ${err?.message ?? err}`);
          session.finish('failed');
        };

        const start = (bytes) => {
          if (session.done) return;
          if (!bytes) {
            session.finish('missing');
            return;
          }
          const video = openVqa(bytes);
          overlay = el('div', 'movie-overlay');
          overlay.setAttribute('role', 'dialog');
          overlay.setAttribute('aria-modal', 'true');
          overlay.setAttribute('aria-label', `Movie: ${name.replace(/\.vqa$/, '')}`);
          overlay.tabIndex = -1;
          const canvas = el('canvas', 'movie-canvas');
          canvas.width = video.width;
          canvas.height = video.height;
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Movie ${name.replace(/\.vqa$/, '')}, playing`);
          const hint = el('p', 'movie-hint', 'Click, or press Esc, Space or Enter, to skip');
          overlay.append(canvas, hint);
          overlay.addEventListener('click', () => session.finish('skipped'));
          const g = canvas.getContext('2d');
          if (!g) throw new Error('no 2D canvas');
          const image = g.createImageData(video.width, video.height);
          const show = (rgba) => {
            image.data.set(rgba);
            g.putImageData(image, 0, 0);
          };
          parent.append(overlay);
          overlay.focus({ preventScroll: true });
          show(video.nextFrame());
          let shown = 0;
          sound = startSound(video, name);
          const startedAt = now();
          // The sound track sets the clock when there is one, so the pictures follow it.
          const clock = sound ? () => sound.context.currentTime - sound.at : () => (now() - startedAt) / 1000;
          const length = Math.max(video.frameCount / video.frameRate, sound?.duration ?? 0);
          const tick = () => {
            frameId = null;
            if (session.done) return;
            try {
              const t = clock();
              const want = Math.min(video.frameCount - 1, Math.floor(Math.max(0, t) * video.frameRate));
              let rgba = null;
              for (let n = 0; shown < want && n < DECODE_PER_TICK; n++, shown++) rgba = video.nextFrame();
              if (rgba) show(rgba);
              if (shown >= video.frameCount - 1 && t >= length) {
                session.finish('played');
                return;
              }
            } catch (err) {
              fail(err);
              return;
            }
            frameId = raf(tick);
          };
          frameId = raf(tick);
        };

        content.movieBytes(name).then(
          (bytes) => {
            try {
              start(bytes);
            } catch (err) {
              fail(err);
            }
          },
          fail,
        );
      });
    },
  };
  return player;
}
