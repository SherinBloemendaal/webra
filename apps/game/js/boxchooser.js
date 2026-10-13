// Small pop-ups at the end of a box dragged in a sidebar mode (WebRA bulk
// repair and bulk sell, js/input.js): the repair box asks what to repair
// (structures, combat units, ore trucks, other units or all), the sell box
// asks to confirm selling several structures. Both open next to the point
// where the drag ended, inside the battlefield, and answer with a promise.
//
// Mouse, keyboard and touch: the buttons are 44 px targets on touch screens;
// the number keys (and each button's letter) pick, Enter takes the focused
// button (the remembered choice, or Sell), Esc, a press outside, or the
// mode ending cancel. While one is open it takes every key, so the game's
// hotkeys and Esc's menu wait.

/** Labels and keys of the repair box choices, in the order offered. */
export const REPAIR_CHOICES = Object.freeze([
  { key: 'buildings', label: 'Structures', letter: 'S' },
  { key: 'combat', label: 'Combat units', letter: 'C' },
  { key: 'harvesters', label: 'Ore trucks', letter: 'O' },
  { key: 'other', label: 'Other units', letter: 'U' },
  { key: 'all', label: 'All', letter: 'A' },
]);

/** "1,234" style credits. */
export function formatCredits(n) {
  return `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`;
}

/** The sell box's question for `count` structures worth `refund` credits. */
export function sellConfirmText(count, refund) {
  return `Sell ${count} structures for ${formatCredits(refund)}?`;
}

/**
 * The pop-up host: one pop-up at a time inside `parent` (the battlefield,
 * #field). `doc` and `win` default to the page's (tests pass fakes).
 */
export class BoxChooser {
  constructor(parent, { doc = globalThis.document, win = globalThis.window } = {}) {
    this.parent = parent;
    this.doc = doc;
    this.win = win;
    this.el = null;
    this.finish = null;
  }

  /** Whether a pop-up is open. */
  get open() {
    return !!this.el;
  }

  /**
   * Ask which repair choice to apply: `options` are keys of REPAIR_CHOICES,
   * `last` the remembered one (focused first when offered), `at` the client
   * point where the drag ended. Resolves with the key, or null when cancelled.
   */
  chooseRepair({ options, last, at }) {
    const choices = REPAIR_CHOICES.filter((c) => options.includes(c.key));
    const focus = choices.some((c) => c.key === last) ? last : 'all';
    return this.show({
      title: 'Repair what?',
      kind: 'repair',
      at,
      buttons: choices.map((c, i) => ({ value: c.key, label: c.label, keys: [String(i + 1), c.letter], focus: c.key === focus })),
      cancel: null,
    });
  }

  /** Ask to sell `count` structures for `refund` credits. Resolves with true to sell. */
  confirmSell({ count, refund, at }) {
    return this.show({
      title: sellConfirmText(count, refund),
      kind: 'sell',
      at,
      buttons: [
        { value: true, label: 'Sell', keys: ['1', 'S'], focus: true, tone: 'danger' },
        { value: false, label: 'Cancel', keys: ['2', 'C'] },
      ],
      cancel: false,
    });
  }

  /** Close the open pop-up as cancelled (the mode ended). */
  cancel() {
    this.finish?.(this.cancelValue);
  }

  show({ title, kind, at, buttons, cancel }) {
    this.cancel();
    const d = this.doc;
    const el = d.createElement('div');
    el.className = `box-chooser box-chooser-${kind}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    const head = d.createElement('div');
    head.className = 'box-chooser-title';
    head.textContent = title;
    el.append(head);
    const list = d.createElement('div');
    list.className = 'box-chooser-buttons';
    el.append(list);
    let focusBtn = null;
    const byKey = new Map();
    this.cancelValue = cancel;
    const done = (value) => {
      if (this.el !== el) return;
      this.el = null;
      this.finish = null;
      this.win.removeEventListener('keydown', onKey, true);
      this.win.removeEventListener('pointerdown', onOutside, true);
      el.remove();
      resolve(value);
    };
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    for (const b of buttons) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = `box-chooser-button${b.tone ? ` ${b.tone}` : ''}`;
      const key = d.createElement('kbd');
      key.textContent = b.keys[0];
      btn.append(key, ` ${b.label}`);
      btn.addEventListener('click', () => done(b.value));
      list.append(btn);
      for (const k of b.keys) byKey.set(k.toLowerCase(), b.value);
      if (b.focus) focusBtn = btn;
    }
    const onKey = (e) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        done(cancel);
      } else if (e.key === 'Enter' || e.key === ' ') {
        // The focused button (Tab moves it) takes Enter and Space itself.
      } else if (e.key === 'Tab') {
        // Focus moves between the buttons as usual.
      } else if (byKey.has(String(e.key).toLowerCase()) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        done(byKey.get(String(e.key).toLowerCase()));
      }
    };
    const onOutside = (e) => {
      if (!el.contains(e.target)) done(cancel);
    };
    this.win.addEventListener('keydown', onKey, true);
    this.win.addEventListener('pointerdown', onOutside, true);
    this.el = el;
    this.finish = done;
    this.parent.append(el);
    this.place(el, at);
    focusBtn?.focus();
    return promise;
  }

  /** Next to client point `at`, kept inside the battlefield. */
  place(el, at) {
    const r = this.parent.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    const w = el.offsetWidth ?? 0;
    const h = el.offsetHeight ?? 0;
    const pad = 8;
    let x = (at?.x ?? r.left + r.width / 2) - r.left + 12;
    let y = (at?.y ?? r.top + r.height / 2) - r.top + 12;
    if (x + w + pad > r.width) x = Math.max(pad, x - w - 24);
    if (y + h + pad > r.height) y = Math.max(pad, y - h - 24);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
