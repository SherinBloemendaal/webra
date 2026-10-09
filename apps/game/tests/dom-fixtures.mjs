// A small DOM stand-in for headless UI tests: elements with attributes,
// classes, children, text, properties the UI code uses (hidden, disabled,
// value, checked, files), events that bubble, and simple queries (#id,
// .class, tag, [attr], [attr="value"]). It has no innerHTML on purpose:
// code that reaches for it fails here.
//
//   const doc = installDom();             // globalThis.document, window, HTMLElement
//   const root = doc.createElement('div');
//   doc.body.append(root);
//   click(root.querySelector('#save'));
//   uninstallDom();

const REFLECTED = new Set(['hidden', 'disabled', 'checked', 'multiple', 'required', 'open', 'selected', 'readonly']);

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get list() {
    return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
  set(list) {
    this.el.setAttribute('class', [...new Set(list)].join(' '));
  }
  add(...c) {
    this.set([...this.list, ...c]);
  }
  remove(...c) {
    this.set(this.list.filter((x) => !c.includes(x)));
  }
  contains(c) {
    return this.list.includes(c);
  }
  toggle(c, force) {
    const on = force ?? !this.contains(c);
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
}

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

export class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument?.documentElement || n === this.ownerDocument;
  }
  append(...nodes) {
    for (let n of nodes) {
      if (n === null || n === undefined) continue;
      if (typeof n === 'string' || typeof n === 'number') n = this.ownerDocument.createTextNode(String(n));
      n.parentNode?.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  prepend(...nodes) {
    const rest = this.childNodes.splice(0);
    this.append(...nodes);
    for (const n of rest) this.childNodes.push(n);
  }
  before(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    const added = nodes.map((n) => (typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
    for (const n of added) {
      n.parentNode?.removeChild(n);
      n.parentNode = p;
    }
    p.childNodes.splice(p.childNodes.indexOf(this) >= 0 ? p.childNodes.indexOf(this) : i, 0, ...added);
  }
  after(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    const added = nodes.map((n) => (typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
    for (const n of added) {
      n.parentNode?.removeChild(n);
      n.parentNode = p;
    }
    p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...added);
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  replaceWith(...nodes) {
    this.before(...nodes);
    this.remove();
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren();
    if (v !== '' && v !== null && v !== undefined) this.append(String(v));
  }
  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, once: !!opts?.once });
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((x) => x.fn !== fn));
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (let n = this; n; n = n.parentNode ?? (n === n.ownerDocument?.documentElement ? n.ownerDocument : null)) {
      event.currentTarget = n;
      for (const l of [...(n.listeners.get(event.type) ?? [])]) {
        if (l.once) n.removeEventListener(event.type, l.fn);
        l.fn.call(n, event);
      }
      if (!event.bubbles || event.propagationStopped) break;
      if (n === n.ownerDocument) break;
    }
    return !event.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) {
    super(doc);
    this.data = text;
    this.nodeType = 3;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

export class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.dataset = new Proxy(
      {},
      {
        get: (_, k) => this.getAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`) ?? undefined,
        set: (_, k, v) => {
          this.setAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, v);
          return true;
        },
      },
    );
    this.style = new Proxy({ setProperty() {}, removeProperty() {} }, { set: () => true });
    this._value = '';
    this._checked = false;
    this.files = [];
    this.clicks = 0;
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  setAttribute(k, v) {
    if (k === 'style') throw new Error('inline style attribute: the CSP forbids it');
    this.attributes.set(k, String(v));
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  toggleAttribute(k, force) {
    const on = force ?? !this.hasAttribute(k);
    if (on) this.setAttribute(k, '');
    else this.removeAttribute(k);
    return on;
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get className() {
    return this.getAttribute('class') ?? '';
  }
  set className(v) {
    this.setAttribute('class', v);
  }
  get value() {
    if (this.localName === 'select' && !this._valueSet) {
      const opt = this.querySelectorAll('option').find((o) => o.selected) ?? this.querySelector('option');
      return opt ? opt.value : '';
    }
    if (this.localName === 'option' && !this.hasAttribute('value')) return this.textContent;
    if (this.localName === 'option') return this.getAttribute('value');
    return this._value;
  }
  set value(v) {
    if (this.localName === 'option') this.setAttribute('value', v);
    else {
      this._value = String(v);
      this._valueSet = true;
      if (this.localName === 'select') for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v);
    }
  }
  get checked() {
    return this._checked;
  }
  set checked(v) {
    this._checked = !!v;
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  click() {
    this.clicks++;
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click'));
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  }
  getContext() {
    return null;
  }
  matches(selector) {
    return selector.split(',').some((s) => matchOne(this, s.trim()));
  }
  closest(selector) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get innerHTML() {
    throw new Error('innerHTML is not allowed (CSP-safe DOM only)');
  }
  set innerHTML(_v) {
    throw new Error('innerHTML is not allowed (CSP-safe DOM only)');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML is not allowed (CSP-safe DOM only)');
  }
}

for (const prop of REFLECTED) {
  if (prop === 'checked') continue;
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.hasAttribute(prop);
    },
    set(v) {
      if (v) this.setAttribute(prop, '');
      else this.removeAttribute(prop);
    },
  });
}
for (const prop of ['href', 'type', 'name', 'placeholder', 'title', 'min', 'max', 'step', 'accept', 'autocomplete', 'htmlFor', 'rel', 'target', 'download', 'role', 'tabIndex', 'maxLength', 'minLength', 'pattern', 'inputMode', 'label']) {
  const attr = prop === 'htmlFor' ? 'for' : prop.toLowerCase();
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.getAttribute(attr) ?? '';
    },
    set(v) {
      this.setAttribute(attr, v);
    },
  });
}

function matchOne(el, selector) {
  // Combinators: "a b" (descendant) and "a > b" (child).
  const tokens = selector.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  const steps = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>') continue;
    steps.push({ sel: tokens[i], child: tokens[i - 1] === '>' });
  }
  const walk = (node, k) => {
    if (!matchSimple(node, steps[k].sel)) return false;
    if (k === 0) return true;
    if (steps[k].child) {
      const p = node.parentNode;
      return !!p && p.nodeType === 1 && walk(p, k - 1);
    }
    for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (walk(p, k - 1)) return true;
    return false;
  };
  return walk(el, steps.length - 1);
}

function matchSimple(el, s) {
  const re = /([#.]?[\w-]+|\[[^\]]+\]|:not\([^)]*\))/g;
  let m;
  let any = false;
  while ((m = re.exec(s))) {
    any = true;
    const t = m[1];
    if (t.startsWith('#')) {
      if (el.id !== t.slice(1)) return false;
    } else if (t.startsWith('.')) {
      if (!el.classList.contains(t.slice(1))) return false;
    } else if (t.startsWith('[')) {
      const [, k, v] = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(t) ?? [];
      if (!k || !el.hasAttribute(k) || (v !== undefined && el.getAttribute(k) !== v)) return false;
    } else if (t.startsWith(':not(')) {
      if (matchSimple(el, t.slice(5, -1))) return false;
    } else if (el.localName !== t.toLowerCase()) return false;
  }
  return any;
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement(this, 'html');
    this.documentElement.parentNode = null;
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
    this.title = '';
    this.cookie = '';
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createElementNS(_ns, tag) {
    return new FakeElement(this, tag);
  }
  createTextNode(text) {
    return new FakeText(this, text);
  }
  createDocumentFragment() {
    return new FakeElement(this, '#fragment');
  }
  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector(s) {
    return this.documentElement.querySelector(s);
  }
  querySelectorAll(s) {
    return this.documentElement.querySelectorAll(s);
  }
}

/** A Web Storage stand-in. */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

let saved = null;

/** Put a fresh fake document (and window, HTMLElement, Event) on globalThis. Returns the document. */
export function installDom({ coarse = false } = {}) {
  saved ??= { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement, Event: globalThis.Event };
  const doc = new FakeDocument();
  const win = {
    document: doc,
    location: { href: 'https://webra.sherin.dev/play/', origin: 'https://webra.sherin.dev', pathname: '/play/', hash: '', search: '' },
    history: { replaceState() {} },
    matchMedia: (q) => ({ matches: coarse ? /coarse/.test(q) : /fine/.test(q), addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.HTMLElement = FakeElement;
  return doc;
}

export function uninstallDom() {
  if (!saved) return;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
  saved = null;
}

export const click = (el) => el.click();

/** Set an input's value and fire input and change. */
export function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new FakeEvent('input'));
  el.dispatchEvent(new FakeEvent('change'));
}

export function check(el, on = true) {
  el.checked = on;
  el.dispatchEvent(new FakeEvent('change'));
}

/** Submit a form (fires submit; the handler should preventDefault). */
export function submit(form) {
  return form.dispatchEvent(new FakeEvent('submit'));
}

/** Let pending promises and microtasks run. */
export const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** All text under a node, whitespace collapsed. */
export const textOf = (node) => node.textContent.replace(/\s+/g, ' ').trim();
