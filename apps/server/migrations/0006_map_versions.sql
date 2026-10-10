-- Map format versions (docs/contracts.md section 2, "Map versions").
--
-- Every row stores canonical JSON of the format version its map was in when
-- it was stored; every row before this migration is format 1, the baseline.
-- After a release raises the format, a row of an older version is upgraded
-- the first time it is read (and by the daily job): maps.js upgradeStoredMap
-- rewrites its json and hash in place, keeping its id, and records the old
-- hash here so links, lobbies and saves that remember it still find the map.
ALTER TABLE maps ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1;
-- Why a row cannot be upgraded automatically (the message players see), or
-- NULL. Such rows leave the map list; their text is still served by id so
-- the map editor can open it for repair.
ALTER TABLE maps ADD COLUMN upgrade_error TEXT;
-- The format version and release that failed (`<format>/<release>`): a
-- later release, which may migrate it after all, tries again.
ALTER TABLE maps ADD COLUMN upgrade_tried TEXT;
CREATE INDEX IF NOT EXISTS maps_format_version ON maps (format_version);

-- The hashes (and ids, when an upgraded map merged into a row that already
-- held it) of upgraded maps, pointing to the hash of the row that holds the
-- map now. Removed with that row (daily job).
CREATE TABLE IF NOT EXISTS map_aliases (
  old_hash TEXT PRIMARY KEY,
  old_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS map_aliases_old_id ON map_aliases (old_id);
CREATE INDEX IF NOT EXISTS map_aliases_hash ON map_aliases (hash);
