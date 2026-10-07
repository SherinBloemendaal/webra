// Support power bar: one button per support power the player has (from
// `player_json().powers`, see engine/src/powers.rs), with its name, a charge
// bar and the time left. A ready power flashes; clicking it starts targeting
// on the map (Input.startPowerTargeting): click the target, or drag from the
// target to choose the direction aircraft fly in. Escape or right click cancels.

export class PowerBar {
  /**
   * @param {HTMLElement} parent element the bar is placed in (the battlefield)
   * @param {{ ticksPerSecond: number, onSelect(power): void, onTargetLost?(): void }} hooks
   */
  constructor(parent, hooks) {
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.id = 'powers';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Support powers');
    parent.appendChild(this.root);
    this.buttons = new Map(); // key -> { el, fill, time, power }
    this.targeting = null;
  }

  /** Refresh from `player_json().powers`. */
  update(powers) {
    const seen = new Set();
    powers.forEach((p, index) => {
      seen.add(p.key);
      let b = this.buttons.get(p.key);
      if (!b) {
        b = this.create(p);
        this.buttons.set(p.key, b);
      }
      b.power = p;
      // Keep the engine's order (palette order) without moving nodes needlessly.
      if (this.root.children[index] !== b.el) this.root.insertBefore(b.el, this.root.children[index] ?? null);
      b.fill.style.width = `${Math.round(Math.max(0, Math.min(1, p.progress)) * 100)}%`;
      b.time.textContent = p.ready ? 'Ready' : p.charging ? clock(p.remainingTicks / this.hooks.ticksPerSecond) : 'Paused';
      b.el.classList.toggle('ready', p.ready);
      b.el.classList.toggle('paused', !p.ready && !p.charging);
      b.el.classList.toggle('targeting', this.targeting === p.key);
      b.el.disabled = !p.ready;
      b.el.title = `${p.name}: ${p.description}${p.ready ? '' : ` (${b.time.textContent})`}`;
    });
    for (const [key, b] of this.buttons) {
      if (!seen.has(key)) {
        b.el.remove();
        this.buttons.delete(key);
      }
    }
    // The targeted power was lost (airfield destroyed) or used: stop targeting.
    if (this.targeting && !this.buttons.get(this.targeting)?.power.ready) {
      this.setTargeting(null);
      this.hooks.onTargetLost?.();
    }
    this.root.hidden = this.buttons.size === 0;
  }

  /** Highlight the power being targeted (null: none). */
  setTargeting(key) {
    this.targeting = key;
    for (const [k, b] of this.buttons) b.el.classList.toggle('targeting', k === key);
  }

  create(p) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'power';
    const name = document.createElement('span');
    name.className = 'power-name';
    name.textContent = p.name;
    const time = document.createElement('span');
    time.className = 'power-time';
    const bar = document.createElement('span');
    bar.className = 'power-bar';
    const fill = document.createElement('span');
    fill.className = 'power-fill';
    bar.appendChild(fill);
    el.append(name, time, bar);
    // Keep the click from reaching the map (it would deselect units).
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', () => {
      const b = this.buttons.get(p.key);
      if (b?.power.ready) this.hooks.onSelect(b.power);
    });
    return { el, fill, time, power: p };
  }
}

function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
