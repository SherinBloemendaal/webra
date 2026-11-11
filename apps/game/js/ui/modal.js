// Keeps a modal dialog modal: while it is open, the rest of the page is
// inert, so Tab, a screen reader and a click cannot reach the controls behind
// its backdrop (the dialog's aria-modal="true" says so).
//
//   const release = holdPage(panel); // the dialog opened
//   release(); // it closed: the page is as it was (before the focus goes back)
//
// Every sibling of the dialog and of each of its ancestors up to the body is
// made inert; what was inert already stays so afterwards. Holds may overlap
// (a dialog opened from another): the newest open dialog is the one the page
// is held for, and closing it in any order gives the page back to the one
// still open, or to nobody.

/** Open dialogs that hold the page, oldest first. */
const holds = [];
/** Nodes made inert for the newest hold, with whether each was inert before. */
let covered = [];

function restore() {
  for (const [node, was] of covered.reverse()) node.inert = was;
  covered = [];
}

function cover(panel) {
  for (let node = panel; node?.parentNode && node !== node.ownerDocument?.body; node = node.parentNode) {
    for (const other of node.parentNode.children ?? []) {
      if (other === node) continue;
      covered.push([other, !!other.inert]);
      other.inert = true;
    }
  }
}

function apply() {
  restore();
  const top = holds.at(-1);
  if (top) cover(top.panel);
}

/**
 * Make the page around `panel` inert while it is open.
 * @param {HTMLElement} panel the dialog (or its backdrop)
 * @returns {() => void} gives the page back; calling it again does nothing
 */
export function holdPage(panel) {
  const hold = { panel };
  holds.push(hold);
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = holds.indexOf(hold);
    if (i >= 0) holds.splice(i, 1);
    apply();
  };
}
