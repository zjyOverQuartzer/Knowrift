package cn.knowrift;

import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class ModelProfilesTest {
    @TempDir Path temp;
    Map<String,Object> input(int revision) {
        var body = new HashMap<String,Object>();
        body.put("name", " 中文配置 "); body.put("protocol", "openai-compatible"); body.put("baseUrl", "http://127.0.0.1:11434/v1/");
        body.put("model", " test-model "); body.put("expectedRevision", revision);
        return body;
    }
    @Test void lifecycleRevisionSelectionAndRestart() throws Exception {
        Path home = temp.resolve("全局工作区"); String id = UUID.randomUUID().toString();
        try (var store = new ProjectStore(home)) {
            var profiles = new ModelProfiles(store);
            assertNull(profiles.list().get("activeProfileId"));
            var first = profiles.save(id, input(0));
            assertEquals(1, first.revision()); assertEquals("中文配置", first.name()); assertEquals("test-model", first.model());
            assertEquals("http://127.0.0.1:11434/v1", first.baseUrl());
            assertEquals(1, profiles.save(id, input(0)).revision());
            profiles.activate(id);
            var changed = input(1); changed.put("name", "第二版");
            assertEquals(2, profiles.save(id, changed).revision());
            var stale = input(1); stale.put("name", "过期编辑");
            assertEquals("PROFILE_CONFLICT", assertThrows(ApiException.class, () -> profiles.save(id, stale)).code);
            assertThrows(ApiException.class, () -> profiles.delete(id, 1));
            assertEquals("第二版", profiles.get(id).name());
        }
        try (var store = new ProjectStore(home)) {
            var profiles = new ModelProfiles(store);
            assertEquals(id, profiles.list().get("activeProfileId"));
            assertEquals(2, profiles.get(id).revision());
            profiles.delete(id, 2);
            assertNull(profiles.list().get("activeProfileId")); assertTrue(profiles.internalList().isEmpty());
            assertEquals("PROFILE_NOT_FOUND", assertThrows(ApiException.class, () -> profiles.activate(id)).code);
        }
    }
    @Test void credentialsAreReferencesAndEndpointChangesRequireReplacement() throws Exception {
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var profiles = new ModelProfiles(store); String id = UUID.randomUUID().toString();
            var body = input(0); body.put("baseUrl", "https://example.com/compatible-mode/v1");
            assertThrows(ApiException.class, () -> profiles.save(id, body));
            String firstRef = "model-profile/" + id + "/" + UUID.randomUUID(); body.put("credentialRef", firstRef);
            var saved = profiles.save(id, body);
            assertTrue((boolean)saved.publicValue().get("hasKey")); assertFalse(saved.publicValue().containsKey("credentialRef"));
            assertFalse(LocalApplication.JSON.writeValueAsString(profiles.list()).contains(firstRef));
            var other = new HashMap<>(body); other.put("expectedRevision", 1); other.put("baseUrl", "https://other.example.com/v1");
            assertThrows(ApiException.class, () -> profiles.save(id, other));
            assertEquals(firstRef, profiles.get(id).credentialRef());
            other.put("credentialRef", "model-profile/" + id + "/" + UUID.randomUUID());
            assertEquals(2, profiles.save(id, other).revision());
            other.put("expectedRevision", 2); other.put("protocol", "anthropic");
            assertThrows(ApiException.class, () -> profiles.save(id, other));
            other.put("credentialRef", "model-profile/" + id + "/" + UUID.randomUUID());
            other.put("anthropicAuth", "bearer"); other.put("workspaceId", "workspace-test");
            assertEquals("workspace-test", profiles.save(id, other).workspaceId());
        }
    }
    @Test void inputValidationDoesNotPersistInvalidProfiles() throws Exception {
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var profiles = new ModelProfiles(store); String id = UUID.randomUUID().toString();
            for (String base : List.of("http://example.com/v1", "https://u:p@example.com/v1", "https://example.com/v1?q=secret", "https://example.com/#key", "http://localhost:0", "http://localhost/v1/chat/completions", "http://localhost/api/chat")) {
                var body = input(0); body.put("baseUrl", base);
                assertThrows(ApiException.class, () -> profiles.save(id, body), base);
            }
            var protocol = input(0); protocol.put("protocol", "gemini");
            assertThrows(ApiException.class, () -> profiles.save(id, protocol));
            var ref = input(0); ref.put("credentialRef", "model-profile/" + UUID.randomUUID() + "/" + UUID.randomUUID());
            assertThrows(ApiException.class, () -> profiles.save(id, ref));
            var revision = input(0); revision.put("expectedRevision", 1.5);
            assertThrows(ApiException.class, () -> profiles.save(id, revision));
            assertTrue(profiles.internalList().isEmpty());
        }
    }
    private String makeV1(Path home) throws Exception {
        String id;
        try (var store = new ProjectStore(home)) {
            id = store.create(Map.of("name", "升级前项目", "clientRequestId", UUID.randomUUID().toString())).project().id();
            store.patch(id, Map.of("archived", true));
        }
        Database.use(home.resolve("app.db"), true, jdbc -> { jdbc.execute("DROP TABLE model_settings"); jdbc.execute("DROP TABLE model_profiles"); jdbc.execute("PRAGMA user_version=1"); return null; });
        return id;
    }
    @Test void v1MigrationCreatesConsistentBackupAndPreservesProjects() throws Exception {
        Path home = temp.resolve("中文 升级"); String id = makeV1(home);
        try (var store = new ProjectStore(home)) {
            assertTrue(store.get(id).archived()); assertEquals("升级前项目", store.get(id).name());
            assertTrue(new ModelProfiles(store).internalList().isEmpty());
            assertEquals(2, Database.use(home.resolve("app.db"), false, jdbc -> jdbc.queryForObject("PRAGMA user_version", Integer.class)).intValue());
            Path projectDb = Path.of(store.get(id).root()).resolve(".zhixi/project.db");
            assertEquals(1, Database.use(projectDb, false, jdbc -> jdbc.queryForObject("PRAGMA user_version", Integer.class)).intValue());
        }
        try (var files = Files.list(home.resolve("backups"))) {
            var backups = files.toList(); assertEquals(1, backups.size());
            Database.use(backups.get(0), false, jdbc -> {
                assertEquals("ok", jdbc.queryForObject("PRAGMA integrity_check", String.class));
                assertEquals(1, jdbc.queryForObject("PRAGMA user_version", Integer.class));
                assertEquals(1, jdbc.queryForObject("SELECT archived FROM projects WHERE id=?", Integer.class, id)); return null;
            });
        }
        try (var store = new ProjectStore(home)) { assertEquals(1, store.list().size()); }
        try (var files = Files.list(home.resolve("backups"))) { assertEquals(1, files.count()); }
    }
    @Test void failedBackupLeavesV1UntouchedAndCanBeRetried() throws Exception {
        Path home = temp.resolve("home"); String id = makeV1(home);
        Files.writeString(home.resolve("backups"), "existing user file");
        assertEquals("MIGRATION_BACKUP_FAILED", assertThrows(ApiException.class, () -> new ProjectStore(home)).code);
        Database.use(home.resolve("app.db"), false, jdbc -> {
            assertEquals(1, jdbc.queryForObject("PRAGMA user_version", Integer.class));
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM sqlite_master WHERE name='model_profiles'", Integer.class)); return null;
        });
        assertEquals("existing user file", Files.readString(home.resolve("backups")));
        Files.delete(home.resolve("backups"));
        try (var store = new ProjectStore(home)) { assertEquals(id, store.list().get(0).id()); }
    }
    @Test void failedSchemaMigrationRollsBackAllNewTables() throws Exception {
        Path home = temp.resolve("home"); String id = makeV1(home);
        Database.use(home.resolve("app.db"), true, jdbc -> { jdbc.execute("CREATE TABLE model_settings(conflict TEXT)"); return null; });
        assertThrows(RuntimeException.class, () -> new ProjectStore(home));
        Database.use(home.resolve("app.db"), false, jdbc -> {
            assertEquals(1, jdbc.queryForObject("PRAGMA user_version", Integer.class));
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM sqlite_master WHERE name='model_profiles'", Integer.class));
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM projects WHERE id=?", Integer.class, id)); return null;
        });
        Database.use(home.resolve("app.db"), true, jdbc -> { jdbc.execute("DROP TABLE model_settings"); return null; });
        try (var store = new ProjectStore(home)) { assertEquals(id, store.list().get(0).id()); }
    }
}
