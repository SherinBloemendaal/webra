// Driving select plates (js/ui/controls.js selectPlate) in DOM tests like a
// player does: open the list with a click on the plate, click an option.
import { FakeEvent } from './dom-fixtures.mjs';

const click = (el) => el.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }));

/** The option elements of a plate (its root element or the plate object). */
export function plateOptionsOf(plate) {
  const root = plate.root ?? plate;
  return root.querySelectorAll('[role="option"]');
}

/** The label text of each option of a plate. */
export function plateLabels(plate) {
  return plateOptionsOf(plate).map((o) => o.querySelector('.ui-sp-label').textContent);
}

/** The text on a plate's face (its chosen option). */
export function plateText(plate) {
  const root = plate.root ?? plate;
  return root.querySelector('.ui-sp-value').textContent;
}

/** Choose the option labelled `label`: a click on the plate, then on the option. */
export function chooseLabel(plate, label) {
  const root = plate.root ?? plate;
  const option = plateOptionsOf(root).find((o) => o.querySelector('.ui-sp-label').textContent === label);
  if (!option) throw new Error(`no option "${label}" in ${plateLabels(root).join(', ')}`);
  click(root.querySelector('.ui-sp-button'));
  click(option);
}

/** Choose the option with `value` of a plate object (the label it shows is looked up). */
export function chooseValue(plate, value) {
  const option = plate.option(value);
  if (!option) throw new Error(`no option ${value}`);
  chooseLabel(plate, option.label);
}
