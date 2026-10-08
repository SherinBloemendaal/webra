// Installed original sounds live in the content store with the other
// installed content (js/content/store.js): IndexedDB in this browser, on this
// device only. Records are { name, bytes (ArrayBuffer of the .aud file),
// size, from (the file it came from), kind }.

export { IdbStore, MemoryStore, openContentStore, storeError } from '../content/store.js';
