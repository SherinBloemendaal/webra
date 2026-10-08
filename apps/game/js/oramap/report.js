// The import report of an .oramap conversion as DOM, shared by the lobby and
// the map editor. Every string from the file goes in as text, never as HTML.

const SECTIONS = [
  ['errors', 'Not playable yet', 'oramap-report-errors'],
  ['converted', 'Converted', 'oramap-report-converted'],
  ['rules', 'Rules applied (modded map)', 'oramap-report-rules'],
  ['warnings', 'Warnings', 'oramap-report-warnings'],
  ['skipped', 'Skipped', 'oramap-report-skipped'],
  ['unsupported', 'Not supported (ignored)', 'oramap-report-unsupported'],
];

/** Lines of each report section, in display order. */
export function reportSections(report) {
  const rules = report?.rules ?? { applied: [], rejected: [] };
  const lists = {
    errors: report?.validation && !report.validation.ok ? report.validation.errors : [],
    converted: report?.converted ?? [],
    rules: report?.modded ? rules.applied.map((a) => a.text) : [],
    warnings: [...(report?.warnings ?? []), ...rules.rejected.map((r) => `Rule not applied, the engine refused it: ${r}`)],
    skipped: report?.skipped ?? [],
    unsupported: report?.unsupported ?? [],
  };
  return SECTIONS.map(([key, title, cls]) => ({ key, title, cls, lines: lists[key].map(String) })).filter((s) => s.lines.length);
}

/** Plain text version (for logs and the clipboard). */
export function reportText(report) {
  const head = `${report?.title ?? 'Map'} by ${report?.author ?? '?'} (${report?.tileset ?? '?'})`;
  return [head, ...reportSections(report).flatMap((s) => [`${s.title}:`, ...s.lines.map((l) => `- ${l}`)])].join('\n');
}

/**
 * Build the report element.
 * @param {object} report from importOramap
 * @param {Document} [doc]
 */
export function renderReport(report, doc = globalThis.document) {
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el('div', 'oramap-report');
  const size = report?.size ? `, ${report.size[0]} x ${report.size[1]}` : '';
  root.append(el('p', 'oramap-report-title', `"${report?.title ?? 'Map'}" by ${report?.author ?? '?'}, OpenRA tileset ${report?.tileset ?? '?'}${size}`));
  for (const s of reportSections(report)) {
    const sec = el('section', `oramap-report-section ${s.cls}`);
    sec.append(el('h3', null, s.title));
    const ul = el('ul');
    for (const line of s.lines) ul.append(el('li', null, line));
    sec.append(ul);
    root.append(sec);
  }
  return root;
}
