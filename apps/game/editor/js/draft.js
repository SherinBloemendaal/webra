// The draft: the map being edited, saved in this browser as the author works
// (editor.js autosave), restored when the editor opens again. It names where
// the map came from (`source`: a published map's id), so reopening the
// editor link of that published map brings back the edits instead of the
// published map; a draft of any other map never replaces a published one.

import { MapDoc } from './doc.js';

export const DRAFT_KEY = 'webra.editor.draft';

/** The draft's text, with the map's JSON as the document made it once (MapDoc.snapshot). */
export function draftText({ savedAt, edited, source = null, json }) {
  return `{"savedAt":${savedAt},"edited":${!!edited},"source":${JSON.stringify(typeof source === 'string' ? source : null)},"map":${json}}`;
}

/**
 * A stored draft: `{ map, savedAt, edited, source }`, or null when there is
 * none. Throws when the text is not a draft the editor can open (the caller
 * drops it). Drafts written before `edited` and `source` existed count as
 * edited, with no source.
 */
export function parseDraft(text) {
  if (!text) return null;
  const { map, savedAt, edited = true, source = null } = JSON.parse(text);
  new MapDoc(map); // throws on undecodable layers
  return { map, savedAt, edited: !!edited, source: typeof source === 'string' ? source : null };
}

/**
 * True when the draft should open instead of published map `id`: it holds
 * edits of that same map made after it was opened (not saved to a file or
 * published since). A draft of another map, or one without changes, does not.
 */
export function draftWins(draft, id) {
  return !!draft && draft.edited && typeof id === 'string' && draft.source === id;
}
