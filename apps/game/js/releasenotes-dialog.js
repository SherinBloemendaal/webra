// The release notes dialog (index.html: #release-notes). Opens by itself once
// after a new version is loaded ("What's new"), and from the lobby and the
// game menu ("Release notes"). Data: js/releasenotes.js.
//
// All text goes in through textContent; links only point at the https URLs
// the build wrote (sanitizeNotes drops anything else).

import {
  RELEASE_NOTES_URL,
  formatReleaseDate,
  groupByScope,
  normalizeVersion,
  readSeenVersion,
  sanitizeNotes,
  whatsNew,
  writeSeenVersion,
} from './releasenotes.js';
import { defaultRegistry } from './registry.js';

const LOAD_TIMEOUT_MS = 8000;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href, text, label) {
  const a = el('a', 'rn-link', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (label) a.setAttribute('aria-label', label);
  return a;
}

/** Fetch and sanitize the notes; throws an Error with a message for players. */
async function fetchNotes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-cache', signal: controller.signal });
  } catch {
    throw new Error('The release notes could not be loaded. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('This build has no release notes (they are added when the game is built for release).');
  }
  const notes = sanitizeNotes(await res.json().catch(() => null));
  if (!notes) throw new Error('The release notes of this build are damaged.');
  return notes;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Build the dialog into `panel`.
 * @param {HTMLElement} panel the overlay section
 * @param {{ version?: string | null, url?: string, registry?: object }} opts registry: the settings registry (js/registry.js)
 *   `version` is the running game version (the engine's "0.3.0+abcdef12" is fine).
 */
export function mountReleaseNotes(panel, { version = null, url = RELEASE_NOTES_URL, registry = defaultRegistry() } = {}) {
  const current = normalizeVersion(version);
  let notesPromise = null;
  let opener = null;
  const loadNotes = () => {
    notesPromise ??= fetchNotes(url).catch((err) => {
      notesPromise = null; // try again on the next open
      throw err;
    });
    return notesPromise;
  };

  const title = el('h1', 'rn-title');
  title.id = 'release-notes-title';
  const badge = el('span', 'rn-badge rn-current-badge');
  const close = el('button', 'rn-close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close release notes');
  const intro = el('p', 'tagline rn-intro');
  const body = el('div', 'rn-body');
  body.tabIndex = -1; // scrollable with the keyboard once focused
  const footer = el('div', 'rn-footer');
  const card = el('div', 'menu-card rn-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', title.id);
  card.setAttribute('aria-describedby', 'release-notes-intro');
  intro.id = 'release-notes-intro';
  const head = el('div', 'rn-head');
  const heading = el('div', 'rn-heading');
  heading.append(title, badge);
  head.append(heading, close);
  card.append(head, intro, body, footer);
  panel.replaceChildren(card);
  panel.hidden = true;

  const setOpen = (on) => {
    if (on === !panel.hidden) return;
    panel.hidden = !on;
    if (on) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      close.focus({ preventScroll: true });
    } else if (opener?.isConnected) {
      opener.focus({ preventScroll: true });
      opener = null;
    }
  };

  // A re-render can remove the focused button (Try again): keep focus inside.
  const keepFocus = () => {
    if (!panel.hidden && !card.contains(document.activeElement)) close.focus({ preventScroll: true });
  };

  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) setOpen(false);
  });
  // Keys inside the dialog stay here: Esc closes it, Tab cycles through it,
  // and nothing reaches the lobby (Enter starts a game) or the game hotkeys.
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      const items = [...card.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  const renderRelease = (r, { fresh }) => {
    const article = el('article', 'rn-release');
    const h2 = el('h2', 'rn-version');
    h2.append(el('span', 'rn-badge', `v${r.version}`));
    if (current && r.version === current) h2.append(el('span', 'rn-tag', 'This version'));
    else if (fresh) h2.append(el('span', 'rn-tag rn-tag-new', 'New'));
    const date = formatReleaseDate(r.date);
    if (date) {
      const time = el('time', 'rn-date', date);
      time.dateTime = r.date;
      h2.append(time);
    }
    article.append(h2);
    if (!r.sections.length) article.append(el('p', 'hint', 'Maintenance release without player-facing changes.'));
    for (const section of r.sections) {
      article.append(el('h3', `rn-section rn-section-${section.type}`, section.title));
      for (const group of groupByScope(section.entries, notes.scopes)) {
        const block = el('div', 'rn-group');
        block.append(el('h4', 'rn-scope', group.label));
        const list = el('ul', 'rn-entries');
        for (const entry of group.entries) {
          const li = el('li', 'rn-entry');
          li.append(el('span', 'rn-text', entry.text));
          if (entry.url && entry.commit) li.append(' ', link(entry.url, entry.commit, `Commit ${entry.commit} on GitHub`));
          for (const ref of entry.refs) li.append(' ', link(ref.url, ref.label, `${ref.label} on GitHub`));
          list.append(li);
        }
        block.append(list);
        article.append(block);
      }
    }
    if (r.compareUrl) {
      const more = el('p', 'rn-compare');
      more.append(link(r.compareUrl, 'All changes in this release on GitHub'));
      article.append(more);
    }
    return article;
  };

  let notes = null;

  /** Fill the dialog. `fresh`: the releases a "What's new" open shows. */
  const render = (mode, fresh = []) => {
    const whatsNewMode = mode === 'whatsNew' && fresh.length > 0;
    title.textContent = whatsNewMode ? "What's new" : 'Release notes';
    badge.textContent = current ? `v${current}` : '';
    badge.hidden = !current;
    badge.title = 'The version you are playing';
    footer.replaceChildren();
    if (!notes) {
      intro.textContent = 'Loading the release notes...';
      body.replaceChildren();
      return;
    }
    const freshVersions = new Set(fresh.map((r) => r.version));
    const shown = whatsNewMode ? fresh : notes.releases;
    intro.textContent = whatsNewMode
      ? `WebRA was updated. Here is what changed since you last played${fresh.length > 1 ? ` (${fresh.length} releases)` : ''}.`
      : 'Every WebRA release: new features and fixes, newest first. Each change links to its commit on GitHub.';
    body.replaceChildren(...shown.map((r) => renderRelease(r, { fresh: freshVersions.has(r.version) })));
    if (!shown.length) body.append(el('p', 'hint', 'No releases yet.'));
    body.scrollTop = 0;
    if (whatsNewMode && notes.releases.length > fresh.length) {
      const all = el('button', 'rn-all', 'All release notes');
      all.type = 'button';
      all.addEventListener('click', () => {
        render('all', fresh);
        keepFocus();
      });
      footer.append(all);
    }
    const done = el('button', 'primary rn-done', whatsNewMode ? 'Got it' : 'Close');
    done.type = 'button';
    done.addEventListener('click', () => setOpen(false));
    footer.append(done);
  };

  const showProblem = (message) => {
    intro.textContent = message;
    body.replaceChildren();
    const retry = el('button', 'rn-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => open());
    const done = el('button', 'primary rn-done', 'Close');
    done.type = 'button';
    done.addEventListener('click', () => setOpen(false));
    footer.replaceChildren(retry, done);
  };

  /** The full list of releases. */
  async function open() {
    render('all');
    setOpen(true);
    try {
      notes = await loadNotes();
      if (!panel.hidden) render('all');
    } catch (err) {
      if (!panel.hidden) showProblem(err.message);
    }
    keepFocus();
  }

  /**
   * Open "What's new" when this browser last saw an older version, then
   * remember the running version. Returns whether the dialog opened.
   */
  async function showWhatsNewOnce() {
    if (!current) return false;
    const seen = readSeenVersion(registry);
    if (seen === current) return false;
    try {
      notes = await loadNotes();
    } catch {
      return false; // no notes: decide again on the next load
    }
    const decision = whatsNew({ current, seen, releases: notes.releases });
    if (decision.remember) writeSeenVersion(decision.remember, registry);
    if (!decision.show || !panel.hidden) return false;
    render('whatsNew', decision.releases);
    setOpen(true);
    return true;
  }

  return { open, close: () => setOpen(false), showWhatsNewOnce, get isOpen() { return !panel.hidden; } };
}
