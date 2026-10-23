package cn.knowrift;

import java.io.IOException;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.function.Consumer;
import org.springframework.dao.DataAccessException;

public final class ProjectStore implements AutoCloseable {
    public record Project(String id, String name, String root, boolean archived, String availability) {}
    public record Created(Project project, boolean replayed) {}
    private final Path home;
    private final Path appDb;
    private final FileChannel lockChannel;
    private final FileLock lock;
    private final Consumer<String> checkpoint;

    public ProjectStore(Path home) throws IOException { this(home, stage -> {}); }
    Path appDatabase() { return appDb; }
    public ProjectStore(Path home, Consumer<String> checkpoint) throws IOException {
        this.home = home.toAbsolutePath().normalize();
        this.checkpoint = checkpoint;
        if (Files.exists(this.home.resolve("projects.json"))) throw new ApiException("DATA_ROOT_CONFLICT", 409, "该工作区包含旧版登记数据，请选择独立的新版工作区");
        Files.createDirectories(this.home);
        this.appDb = this.home.resolve("app.db");
        this.lockChannel = FileChannel.open(this.home.resolve(".service.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        FileLock acquired;
        try { acquired = lockChannel.tryLock(); } catch (OverlappingFileLockException error) { acquired = null; }
        if (acquired == null) { lockChannel.close(); throw new ApiException("WORKSPACE_BUSY", 409, "该工作区已被另一个项目服务使用"); }
        this.lock = acquired;
        try {
            if (!Files.exists(appDb)) Files.createFile(appDb);
            Database.initialize(appDb, "app");
            recover();
        } catch (IOException | RuntimeException | Error error) { close(); throw error; }
    }
    private static String text(Object value, String field) {
        if (!(value instanceof String s)) throw ApiException.invalid(field + "格式无效");
        return s;
    }
    private static String name(Object value) {
        String name = text(value, "项目名称").trim();
        if (name.isEmpty() || name.length() > 80) throw ApiException.invalid("项目名称需为1至80个字符");
        return name;
    }
    private static Path canonical(Path path) throws IOException {
        Path absolute = path.toAbsolutePath().normalize();
        Path parent = absolute;
        Deque<Path> missing = new ArrayDeque<>();
        while (!Files.exists(parent)) {
            if (Files.isSymbolicLink(parent)) throw ApiException.conflict("项目目录包含失效链接");
            missing.addFirst(parent.getFileName()); parent = parent.getParent();
        }
        Path result = parent.toRealPath();
        for (Path part : missing) result = result.resolve(part);
        return result.normalize();
    }
    private static String pathKey(Path path) {
        String value = path.toString();
        return System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win") ? value.toLowerCase(Locale.ROOT) : value;
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }
    public synchronized Created create(Map<String,Object> input) {
        String name = name(input.get("name"));
        String requestId = text(input.get("clientRequestId"), "请求标识");
        try { if (!UUID.fromString(requestId).toString().equals(requestId)) throw ApiException.invalid("请求标识需为 UUID"); }
        catch (IllegalArgumentException error) { throw ApiException.invalid("请求标识需为 UUID"); }
        String directory = input.get("directory") == null ? "" : text(input.get("directory"), "项目目录").trim();
        try {
            Path requested = directory.isEmpty() ? null : canonical(Path.of(directory));
            if (requested != null && (!Path.of(directory).isAbsolute() || directory.startsWith("\\\\") || directory.startsWith("//"))) throw ApiException.invalid("请选择本机磁盘上的绝对目录");
            String requestHash = hash(name + "\n" + (requested == null ? "<default>" : pathKey(requested)));
            var old = operation(requestId);
            if (old != null) {
                if (!requestHash.equals(old.get("request_hash"))) throw new ApiException("REQUEST_CONFLICT", 409, "同一请求标识不能用于不同的创建参数");
                if (!"complete".equals(old.get("state"))) initialize(old);
                return new Created(get((String)old.get("project_id")), true);
            }
            String id = UUID.randomUUID().toString();
            String safeName = name.replaceAll("[<>:\"/\\\\|?*\\p{Cntrl}]", "_");
            if (safeName.length() > 30) safeName = safeName.substring(0, 30);
            Path root = requested == null ? canonical(home.resolve("workspaces").resolve(safeName + "-" + id)) : requested;
            validateNewRoot(root);
            var row = new HashMap<String,Object>();
            row.put("request_id", requestId); row.put("request_hash", requestHash); row.put("project_id", id);
            row.put("root", root.toString()); row.put("root_key", pathKey(root)); row.put("name", name); row.put("created_at", Instant.now().toString());
            Database.use(appDb, true, jdbc -> {
                if (!jdbc.queryForList("SELECT project_id FROM create_operations WHERE root_key=?", pathKey(root)).isEmpty()) throw ApiException.conflict("该目录已经登记或正在创建项目");
                jdbc.update("INSERT INTO create_operations(request_id,request_hash,project_id,root,root_key,name,created_at,state) VALUES(?,?,?,?,?,?,?,'pending')", requestId, requestHash, id, root.toString(), pathKey(root), name, row.get("created_at"));
                return null;
            });
            checkpoint.accept("intent");
            initialize(row);
            return new Created(get(id), false);
        } catch (ApiException error) { throw error; }
        catch (InvalidPathException error) { throw ApiException.invalid("项目目录格式无效"); }
        catch (IOException error) { throw new ApiException("ACCESS_DENIED", 403, "项目目录不可访问，请检查路径与权限"); }
        catch (DataAccessException error) { throw new ApiException("DATABASE_BUSY", 503, "数据库暂时不可写，请稍后重试"); }
    }
    private void validateNewRoot(Path root) throws IOException {
        if (Files.exists(root) && !Files.isDirectory(root)) throw ApiException.conflict("项目路径不是文件夹");
        if (Files.exists(root.resolve(".zhixi/state.json")) || Files.exists(root.resolve(".zhixi/project.db")) || Files.exists(root.resolve(".zhixi/creating.id"))) throw ApiException.conflict("目录已有项目数据，请保留原目录；旧项目将在后续支持复制迁移");
        if (Files.exists(root) && !Files.isWritable(root)) throw new ApiException("ACCESS_DENIED", 403, "项目目录不可写");
    }
    private Map<String,Object> operation(String id) {
        return Database.use(appDb, false, jdbc -> { var rows = jdbc.queryForList("SELECT * FROM create_operations WHERE request_id=?", id); return rows.isEmpty() ? null : rows.get(0); });
    }
    private void initialize(Map<String,Object> row) {
        Path root = Path.of((String)row.get("root"));
        String id = (String)row.get("project_id");
        Path internal = root.resolve(".zhixi"); Path marker = internal.resolve("creating.id"); Path db = internal.resolve("project.db");
        try {
            if (!pathKey(canonical(root)).equals(row.get("root_key"))) throw ApiException.conflict("项目路径指向发生变化，已停止创建");
            if (Files.exists(internal.resolve("state.json"))) throw ApiException.conflict("目录出现旧版项目数据，已停止创建");
            Files.createDirectories(internal);
            // Windows junctions are not always reported as symbolic links.
            if (!pathKey(internal.toRealPath()).equals(pathKey(root.resolve(".zhixi")))) throw ApiException.conflict("项目内部目录不能是链接");
            if (Files.isSymbolicLink(marker)) throw ApiException.conflict("项目初始化标记不能是链接");
            if (Files.exists(marker)) {
                if (!Files.readString(marker).equals(id)) throw ApiException.conflict("目录正在被其他项目初始化");
            } else {
                // After a crash following registration, a complete operation needs no replay.
                if (Files.exists(db)) throw ApiException.conflict("目录已有项目数据库");
                Files.writeString(marker, id, StandardOpenOption.CREATE_NEW);
            }
            checkpoint.accept("marker");
            if (!Files.exists(db)) Files.createFile(db);
            if (Files.isSymbolicLink(db)) throw ApiException.conflict("项目数据库不能是链接");
            Database.initialize(db, "project");
            Database.use(db, true, jdbc -> {
                var existing = jdbc.queryForList("SELECT id FROM project_meta WHERE singleton=1");
                if (existing.isEmpty()) jdbc.update("INSERT INTO project_meta(singleton,id,name,created_at) VALUES(1,?,?,?)", id, row.get("name"), row.get("created_at"));
                else if (!id.equals(existing.get(0).get("id"))) throw ApiException.conflict("项目身份不匹配");
                return null;
            });
            checkpoint.accept("database");
            for (String directory : List.of("notes", "references", "summaries", ".history")) {
                Path target = root.resolve(directory);
                if (Files.isSymbolicLink(target)) throw ApiException.conflict("标准项目目录不能是链接");
                Files.createDirectories(target);
                if (!pathKey(target.toRealPath()).equals(pathKey(root.resolve(directory)))) throw ApiException.conflict("标准项目目录不能指向外部目录");
            }
            for (String file : List.of("MEMORY.md", "PROJECT_PROMPT.md")) {
                Path target = root.resolve(file);
                if (!Files.exists(target)) Files.writeString(target, "", StandardOpenOption.CREATE_NEW);
            }
            checkpoint.accept("files");
            Database.use(appDb, true, jdbc -> {
                jdbc.update("INSERT INTO projects(id,root,root_key,name_cache) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING", id, root.toString(), row.get("root_key"), row.get("name"));
                jdbc.update("UPDATE create_operations SET state='complete',error=NULL WHERE request_id=?", row.get("request_id"));
                return null;
            });
            // A leftover own marker is harmless and removed on the next startup.
            try { Files.deleteIfExists(marker); } catch (IOException ignored) { }
        } catch (IOException | RuntimeException error) {
            Database.use(appDb, true, jdbc -> { jdbc.update("UPDATE create_operations SET state='failed',error=? WHERE request_id=?", "创建未完成，请检查目标目录后重试", row.get("request_id")); return null; });
            if (error instanceof ApiException api) throw api;
            throw new ApiException("PROJECT_UNAVAILABLE", 503, "项目创建未完成，已有文件保留；请检查目录权限或同名文件后重试");
        }
    }
    private void recover() {
        var rows = Database.use(appDb, false, jdbc -> jdbc.queryForList("SELECT * FROM create_operations WHERE state='pending'"));
        for (var row : rows) { try { initialize(row); } catch (ApiException ignored) { /* Failed operation remains inspectable and manually retryable. */ } }
        var completed = Database.use(appDb, false, jdbc -> jdbc.queryForList("SELECT project_id,root FROM create_operations WHERE state='complete'"));
        for (var row : completed) {
            Path marker = Path.of((String)row.get("root")).resolve(".zhixi/creating.id");
            try { if (Files.isRegularFile(marker) && Files.readString(marker).equals(row.get("project_id"))) Files.delete(marker); } catch (IOException ignored) { }
        }
    }
    public synchronized List<Project> list() {
        return Database.use(appDb, false, jdbc -> jdbc.queryForList("SELECT * FROM projects ORDER BY rowid")).stream().map(this::describe).toList();
    }
    public synchronized Project get(String id) {
        var rows = Database.use(appDb, false, jdbc -> jdbc.queryForList("SELECT * FROM projects WHERE id=?", id));
        if (rows.isEmpty()) throw new ApiException("NOT_FOUND", 404, "项目不存在");
        return describe(rows.get(0));
    }
    private Project describe(Map<String,Object> row) {
        String id = (String)row.get("id"), name = (String)row.get("name_cache"), root = (String)row.get("root");
        boolean archived = ((Number)row.get("archived")).intValue() != 0;
        Path directory = Path.of(root), db = directory.resolve(".zhixi/project.db");
        String availability = "available";
        if (Files.notExists(directory)) availability = "missing";
        else if (!Files.exists(directory) || !Files.isReadable(directory)) availability = "unreadable";
        else if (Files.notExists(db)) availability = "invalid";
        else if (!Files.isReadable(db)) availability = "unreadable";
        else try {
            if (!pathKey(canonical(directory)).equals(row.get("root_key")) || !pathKey(directory.resolve(".zhixi").toRealPath()).equals(pathKey(directory.resolve(".zhixi"))) || Files.isSymbolicLink(db)) throw ApiException.conflict("项目路径发生变化");
            var meta = Database.use(db, false, jdbc -> {
                if (jdbc.queryForObject("PRAGMA user_version", Integer.class) != 1) throw ApiException.conflict("项目结构版本不兼容");
                return jdbc.queryForMap("SELECT id,name FROM project_meta WHERE singleton=1");
            });
            if (!id.equals(meta.get("id"))) throw ApiException.conflict("项目身份不匹配");
            name = (String)meta.get("name");
            if (!name.equals(row.get("name_cache"))) {
                String updated = name;
                Database.use(appDb, true, jdbc -> { jdbc.update("UPDATE projects SET name_cache=? WHERE id=?", updated, id); return null; });
            }
        } catch (IOException | RuntimeException error) { availability = "invalid"; }
        return new Project(id, name, root, archived, availability);
    }
    public synchronized Project patch(String id, Map<String,Object> input) {
        if (input.isEmpty() || input.keySet().stream().anyMatch(key -> !Set.of("name", "archived").contains(key))) throw ApiException.invalid("仅支持修改项目名称和归档状态");
        String newName = input.containsKey("name") ? name(input.get("name")) : null;
        if (input.containsKey("archived") && !(input.get("archived") instanceof Boolean)) throw ApiException.invalid("归档状态格式无效");
        Project project = get(id);
        if (newName != null) {
            if (!project.availability().equals("available")) throw new ApiException("PROJECT_UNAVAILABLE", 503, "项目目录不可用，无法保存名称");
            try {
                Database.use(Path.of(project.root()).resolve(".zhixi/project.db"), true, jdbc -> { jdbc.update("UPDATE project_meta SET name=? WHERE singleton=1 AND id=?", newName, id); return null; });
            } catch (DataAccessException error) { throw new ApiException("PROJECT_UNAVAILABLE", 503, "项目名称未保存，请检查目录权限后重试"); }
        }
        Database.use(appDb, true, jdbc -> {
            if (newName != null) jdbc.update("UPDATE projects SET name_cache=? WHERE id=?", newName, id);
            if (input.containsKey("archived")) jdbc.update("UPDATE projects SET archived=? WHERE id=?", Boolean.TRUE.equals(input.get("archived")) ? 1 : 0, id);
            return null;
        });
        return get(id);
    }
    @Override public void close() throws IOException { try { lock.release(); } finally { lockChannel.close(); } }
}
