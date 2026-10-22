package cn.knowrift;

import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class ProjectStoreTest {
    @TempDir Path temp;
    Map<String,Object> input(String name, Path root) {
        var value = new HashMap<String,Object>(); value.put("name", name); value.put("clientRequestId", UUID.randomUUID().toString());
        if (root != null) value.put("directory", root.toString()); return value;
    }
    @Test void projectLifecycleAndFilesSurviveRestart() throws Exception {
        Path root = Files.createDirectories(temp.resolve("中文 目录"));
        Files.writeString(root.resolve("MEMORY.md"), "保留用户原文\r\n");
        String id;
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var created = store.create(input("  学习项目  ", root)); id = created.project().id();
            assertEquals("学习项目", created.project().name()); assertFalse(created.replayed());
            assertEquals("available", created.project().availability());
            store.patch(id, Map.of("name", "重命名项目")); store.patch(id, Map.of("archived", true));
            assertEquals("保留用户原文\r\n", Files.readString(root.resolve("MEMORY.md")));
            assertTrue(Files.isDirectory(root.resolve(".history"))); assertFalse(Files.exists(root.resolve(".zhixi/state.json")));
        }
        try (var store = new ProjectStore(temp.resolve("home"))) {
            assertEquals(1, store.list().size()); assertEquals("重命名项目", store.get(id).name()); assertTrue(store.get(id).archived());
            assertFalse(store.patch(id, Map.of("archived", false)).archived());
        }
    }
    @Test void idempotencyParameterConflictAndCanonicalDirectory() throws Exception {
        Path root = Files.createDirectories(temp.resolve("project"));
        var request = input("项目", root);
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var first = store.create(request); var repeated = store.create(request);
            assertEquals(first.project().id(), repeated.project().id()); assertTrue(repeated.replayed());
            var different = new HashMap<>(request); different.put("name", "另一个名称");
            assertEquals("REQUEST_CONFLICT", assertThrows(ApiException.class, () -> store.create(different)).code);
            var alias = input("别名", root.resolve("..").resolve("project"));
            assertEquals("DIRECTORY_CONFLICT", assertThrows(ApiException.class, () -> store.create(alias)).code);
            if (System.getProperty("os.name").toLowerCase().contains("win")) {
                assertThrows(ApiException.class, () -> store.create(input("大小写", Path.of(root.toString().toUpperCase(Locale.ROOT)))));
            }
            assertEquals(1, store.list().size());
        }
    }
    @Test void oldAndForeignProjectsAreNotOverwritten() throws Exception {
        try (var store = new ProjectStore(temp.resolve("home"))) {
            for (String marker : List.of("state.json", "project.db", "creating.id")) {
                Path root = Files.createDirectories(temp.resolve(marker).resolve(".zhixi")).getParent();
                Path file = root.resolve(".zhixi").resolve(marker); Files.writeString(file, "original bytes");
                assertThrows(ApiException.class, () -> store.create(input("冲突", root)));
                assertEquals("original bytes", Files.readString(file));
            }
            assertTrue(store.list().isEmpty());
        }
        Path legacyHome = Files.createDirectories(temp.resolve("legacy")); Files.writeString(legacyHome.resolve("projects.json"), "[]");
        assertEquals("DATA_ROOT_CONFLICT", assertThrows(ApiException.class, () -> new ProjectStore(legacyHome)).code);
        assertFalse(Files.exists(legacyHome.resolve("app.db")));
    }
    static class Crash extends Error {}
    @Test void unfinishedCreationRecoversAtEveryBoundary() throws Exception {
        for (String boundary : List.of("intent", "marker", "database", "files")) {
            Path home = temp.resolve(boundary).resolve("home"), root = Files.createDirectories(temp.resolve(boundary).resolve("资料"));
            Files.writeString(root.resolve("PROJECT_PROMPT.md"), "不可覆盖");
            var request = input("恢复项目", root);
            try (var store = new ProjectStore(home, stage -> { if (stage.equals(boundary)) throw new Crash(); })) {
                assertThrows(Crash.class, () -> store.create(request));
            }
            try (var store = new ProjectStore(home)) {
                assertEquals(1, store.list().size(), boundary);
                assertEquals(store.list().get(0).id(), store.create(request).project().id());
                assertEquals("不可覆盖", Files.readString(root.resolve("PROJECT_PROMPT.md")));
                assertFalse(Files.exists(root.resolve(".zhixi/creating.id")));
            }
        }
    }
    @Test void directoryFailureCanBeRetriedWithoutReplacingFiles() throws Exception {
        Path root = Files.createDirectories(temp.resolve("root")); Files.writeString(root.resolve("notes"), "这是文件");
        var request = input("失败恢复", root);
        try (var store = new ProjectStore(temp.resolve("home"))) {
            assertThrows(ApiException.class, () -> store.create(request));
            assertTrue(store.list().isEmpty()); assertEquals("这是文件", Files.readString(root.resolve("notes")));
            Files.move(root.resolve("notes"), root.resolve("original-note.txt"));
            assertEquals("available", store.create(request).project().availability());
            assertEquals("这是文件", Files.readString(root.resolve("original-note.txt")));
        }
    }
    @Test void missingAndCorruptProjectDoNotBreakTheList() throws Exception {
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var one = store.create(input("项目一", temp.resolve("one"))).project();
            var two = store.create(input("项目二", temp.resolve("two"))).project();
            Files.move(Path.of(one.root()), temp.resolve("moved"));
            assertEquals("missing", store.get(one.id()).availability());
            assertTrue(store.patch(one.id(), Map.of("archived", true)).archived());
            assertThrows(ApiException.class, () -> store.patch(one.id(), Map.of("name", "无法修改")));
            Files.writeString(Path.of(two.root()).resolve(".zhixi/project.db"), "broken database");
            assertEquals("invalid", store.get(two.id()).availability()); assertEquals(2, store.list().size());
        }
    }
    @Test void workspaceLockValidationAndDatabasePragmas() throws Exception {
        Path home = temp.resolve("home");
        try (var store = new ProjectStore(home)) {
            assertEquals("WORKSPACE_BUSY", assertThrows(ApiException.class, () -> new ProjectStore(home)).code);
            assertThrows(ApiException.class, () -> store.create(input(" ", null)));
            var request = input("默认目录", null); var project = store.create(request).project();
            assertTrue(Path.of(project.root()).startsWith(home.toRealPath()));
            Database.use(Path.of(project.root()).resolve(".zhixi/project.db"), false, jdbc -> {
                assertEquals(1, jdbc.queryForObject("PRAGMA foreign_keys", Integer.class));
                assertEquals(5000, jdbc.queryForObject("PRAGMA busy_timeout", Integer.class));
                assertEquals("wal", jdbc.queryForObject("PRAGMA journal_mode", String.class)); return null;
            });
            assertThrows(ApiException.class, () -> store.patch(project.id(), Map.of("archived", "true")));
            assertThrows(ApiException.class, () -> store.patch(project.id(), Map.of("root", "elsewhere")));
        }
    }
    @Test void newerSchemaIsNotDowngraded() throws Exception {
        Path home = temp.resolve("home");
        try (var store = new ProjectStore(home)) { assertTrue(store.list().isEmpty()); }
        Database.use(home.resolve("app.db"), true, jdbc -> { jdbc.execute("PRAGMA user_version=2"); return null; });
        assertEquals("SCHEMA_UNSUPPORTED", assertThrows(ApiException.class, () -> new ProjectStore(home)).code);
    }
    @Test void unreadableProjectIsIsolatedAndRecoversAfterPermissionsRestore() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(System.getProperty("os.name").toLowerCase().contains("win"));
        try (var store = new ProjectStore(temp.resolve("home"))) {
            var project = store.create(input("权限测试", temp.resolve("restricted"))).project();
            Path db = Path.of(project.root()).resolve(".zhixi/project.db");
            AclFileAttributeView view = Files.getFileAttributeView(db, AclFileAttributeView.class);
            var original = view.getAcl();
            var user = db.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName(System.getProperty("user.name"));
            var restricted = new ArrayList<>(original);
            restricted.add(0, AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(user).setPermissions(AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA).build());
            try {
                view.setAcl(restricted);
                assertEquals("unreadable", store.get(project.id()).availability());
                assertEquals(1, store.list().size());
                assertThrows(ApiException.class, () -> store.patch(project.id(), Map.of("name", "拒绝写入")));
                assertTrue(store.patch(project.id(), Map.of("archived", true)).archived());
            } finally { view.setAcl(original); }
            assertEquals("available", store.get(project.id()).availability());
            assertEquals("权限测试", store.get(project.id()).name());
        }
    }
    @Test void windowsInternalJunctionCannotWriteIntoAnotherDirectory() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(System.getProperty("os.name").toLowerCase().contains("win"));
        Path root = Files.createDirectories(temp.resolve("root")), outside = Files.createDirectories(temp.resolve("outside"));
        Files.writeString(outside.resolve("keep.txt"), "preserve");
        Path link = root.resolve(".zhixi");
        Process junction = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", link.toString(), outside.toString()).redirectErrorStream(true).start();
        String output = new String(junction.getInputStream().readAllBytes(), java.nio.charset.Charset.defaultCharset());
        assertEquals(0, junction.waitFor(), output);
        try (var store = new ProjectStore(temp.resolve("home"))) {
            assertThrows(ApiException.class, () -> store.create(input("外部联接", root)));
            assertEquals("preserve", Files.readString(outside.resolve("keep.txt")));
            assertFalse(Files.exists(outside.resolve("creating.id"))); assertFalse(Files.exists(outside.resolve("project.db")));
        } finally { Files.delete(link); }
    }
}
