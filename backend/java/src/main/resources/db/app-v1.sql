CREATE TABLE create_operations (
  request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
  project_id TEXT NOT NULL UNIQUE, root TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','complete','failed')), error TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY REFERENCES create_operations(project_id),
  root TEXT NOT NULL, root_key TEXT NOT NULL UNIQUE, name_cache TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
