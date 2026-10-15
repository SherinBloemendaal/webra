// What a game screen sets up and must take down again when the game goes
// without a page reload (Restart, the next mission: js/main.js start()):
// event listeners on the window, the document and elements that outlive the
// game, subscriptions to settings and registries, timers and parts of the
// screen. Everything goes in last added, first taken down; a step that throws
// does not stop the others.
//
//   const scope = new Disposer();
//   scope.on(window, 'resize', onResize);
//   scope.add(settings.subscribe('healthBars', apply));
//   scope.own(new CommandBar(...));   // its dispose(), destroy() or remove()
//   scope.dispose();

export class Disposer {
  constructor({ onError = (err) => console.warn('Could not take a part of the game down:', err) } = {}) {
    this.fns = [];
    this.disposed = false;
    this.onError = onError;
  }

  /** How many steps wait (tests: nothing is left over after dispose). */
  get size() {
    return this.fns.length;
  }

  /** Run `fn` on dispose (at once when this was disposed already). Returns `fn`. Anything but a function is ignored. */
  add(fn) {
    if (typeof fn !== 'function') return fn;
    if (this.disposed) this.run(fn);
    else this.fns.push(fn);
    return fn;
  }

  /** `target.addEventListener(type, fn, options)`, removed again on dispose. Returns `fn`. */
  on(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this.add(() => target.removeEventListener(type, fn, options));
    return fn;
  }

  /** A part with its own `dispose()`, `destroy()` or `remove()`: called on dispose. Returns the part. */
  own(part) {
    if (!part) return part;
    const end = ['dispose', 'destroy', 'remove'].find((name) => typeof part[name] === 'function');
    if (!end) throw new Error('Disposer.own: the part has no dispose(), destroy() or remove()');
    this.add(() => part[end]());
    return part;
  }

  /** `setTimeout` that is cleared on dispose. */
  timeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  run(fn) {
    try {
      fn();
    } catch (err) {
      this.onError(err);
    }
  }

  /** Take everything down, newest first. Later calls do nothing. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    while (this.fns.length) this.run(this.fns.pop());
  }
}
