// The start screen's main menu (index.html #start-nav, css/startmenu.css):
// one bar over the skirmish lobby instead of buttons in every corner.
// Play first (Skirmish, the screen below; Play online; Campaign), then the
// saved games (Load game, Replays, js/records.js), then the account and a
// More list for the rest (Original content, Sound and music, Release notes,
// Stress test). The online, records, account and content entries keep
// their ids, and their modules fill or show them as before.
//
// More is a disclosure: the button toggles the list (aria-expanded), Escape
// closes it and returns focus to the button, and so do a click outside and
// Tab leaving it; ArrowDown on the button opens it at the first entry, the
// arrows, Home and End move within it. Entries without a handler stay hidden.

/** The dialogs the More entries open (index.html). */
const DIALOGS = '#audio-panel, #music-panel, #content-panel, #release-notes';

/**
 * @param {HTMLElement} nav the #start-nav element
 * @param {{
 *   onSkirmish?: () => void,  show the skirmish lobby (close what covers it)
 *   onSound?: () => void,
 *   onReleaseNotes?: () => void,
 *   onStress?: () => void,
 * }} handlers
 */
export function mountStartMenu(nav, handlers = {}) {
  const doc = nav.ownerDocument;
  const byId = (id) => nav.querySelector(`#${id}`);
  const moreButton = byId('start-more-button');
  const list = byId('start-more-list');
  const entries = () => [...list.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
  // A dialog an entry opened (Sound, Original content, Release notes) keeps
  // the list open, so closing it returns the focus to its entry.
  const away = (t) => !!t && !moreButton.parentNode.contains(t) && !t.closest?.(DIALOGS);

  const onOutside = (e) => {
    if (away(e.target)) setOpen(false, false);
  };
  function setOpen(on, refocus = true) {
    if (on === !list.hidden) return;
    list.hidden = !on;
    moreButton.setAttribute('aria-expanded', String(on));
    if (on) doc.addEventListener('pointerdown', onOutside, true);
    else {
      doc.removeEventListener('pointerdown', onOutside, true);
      if (refocus) moreButton.focus();
    }
  }

  moreButton.addEventListener('click', () => setOpen(list.hidden));
  moreButton.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    setOpen(true);
    entries()[0]?.focus();
  });
  list.addEventListener('keydown', (e) => {
    const items = entries();
    const at = items.indexOf(doc.activeElement);
    let next = -1;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next]?.focus();
  });
  list.addEventListener('focusout', (e) => {
    if (!list.hidden && away(e.relatedTarget)) setOpen(false, false);
  });

  const wire = (id, handler) => {
    const b = byId(id);
    if (!b) return;
    b.hidden = !handler;
    if (handler) b.addEventListener('click', () => handler());
  };
  wire('start-sound', handlers.onSound);
  wire('start-notes', handlers.onReleaseNotes);
  wire('start-stress', handlers.onStress);
  byId('start-skirmish')?.addEventListener('click', () => handlers.onSkirmish?.());

  return {
    /** Whether the More list is open. */
    get open() {
      return !list.hidden;
    },
    setOpen,
  };
}
