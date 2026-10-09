-- Maps shared in an online lobby (docs/security.md, "Map sharing").
--
-- A map the host shares with a session is stored like any upload, but
-- unlisted: it is not in the public map list, GET /api/maps/<id> does not
-- serve it and a lobby cannot pick it by id. Only members of a session whose
-- lobby or game uses it can download it, through that session. Publishing
-- the same map (the map editor) makes the row listed for good.
ALTER TABLE maps ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
-- When a session last used the map (shared or downloaded); unlisted maps
-- unused for 30 days are deleted by the daily job.
ALTER TABLE maps ADD COLUMN used_at INTEGER;
CREATE INDEX IF NOT EXISTS maps_unlisted ON maps (listed, used_at);
