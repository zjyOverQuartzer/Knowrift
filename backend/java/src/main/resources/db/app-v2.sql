CREATE TABLE model_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK(protocol IN ('openai-compatible','anthropic','ollama')),
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    anthropic_auth TEXT NOT NULL DEFAULT 'x-api-key' CHECK(anthropic_auth IN ('x-api-key','bearer')),
    workspace_id TEXT NOT NULL DEFAULT '',
    credential_ref TEXT UNIQUE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL
);
CREATE TABLE model_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    active_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL
);
INSERT INTO model_settings(singleton,active_profile_id) VALUES(1,NULL);
