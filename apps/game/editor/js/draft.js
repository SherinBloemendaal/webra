// The draft: the map being edited, saved in this browser as the author works
// (editor.js autosave), restored when the editor opens again. It names where
// the map came from (`source`: a published map's id), so reopening the
// editor link of that published map brings back the edits instead of the
// published map; a draft of any other map never replaces a published one.
// It keeps the document's key too (MapDoc.origin), so the restored map is
// the same map for its recovery copy.

import { MapDoc, newOrigin } from './doc.js';

export const DRAFT_KEY = 'webra.editor.draft';

/** The draft's text, with the map's JSON as the document made it once (MapDoc.snapshot). */
export function draftText({ savedAt, edited, origin, json }) {
  const str = (v) => JSON.stringify(typeof v === 'string' ? v : null);
  return `{"savedAt":${savedAt},"edited":${!!edited},"key":${str(origin?.key)},"source":${str(origin?.source)},"map":${json}}`;
}

/**
 * A stored draft: `{ map, savedAt, edited, origin }` (origin: newOrigin with
 * the draft's key and source), or null when there is none. Throws when the
 * text is not a draft the editor can open (the caller drops it). Drafts
 * written before `edited`, `key` and `source` existed count as edited, with
 * a new key and no source.
 */
export function parseDraft(text) {
  if (!text) return null;
  const { map, savedAt, edited = true, key = null, source = null } = JSON.parse(text);
  new MapDoc(map); // throws on undecodable layers
  return { map, savedAt, edited: !!edited, origin: newOrigin(source, key) };
}

/**
 * True when the draft should open instead of published map `id`: it holds
 * edits of that same map made after it was opened (not saved to a file or
 * published since). A draft of another map, or one without changes, does not.
 */
export function draftWins(draft, id) {
  return !!draft && draft.edited && typeof id === 'string' && draft.origin.source === id;
}

/**
 * The recovery copies with `map` (document key `key`) as the newest one:
 * its older copy goes, the copies of every other map stay, newest first.
 * Copies written before keys existed are told apart by the map's name.
 */
export function withRecoveryCopy(list, key, map, savedAt) {
  const others = list.filter((r) => (typeof r.id === 'string' ? r.id !== key : r.map?.name !== map.name));
  return [{ id: key, savedAt, map }, ...others];
}
