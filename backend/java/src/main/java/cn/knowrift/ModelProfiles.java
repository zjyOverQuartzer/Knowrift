package cn.knowrift;

import java.net.URI;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
final class ModelProfiles {
    record Profile(String id, String name, String protocol, String baseUrl, String model,
                   String anthropicAuth, String workspaceId, String credentialRef, int revision) {
        Map<String,Object> publicValue() {
            return Map.of("id", id, "name", name, "protocol", protocol, "baseUrl", baseUrl, "model", model,
                "anthropicAuth", anthropicAuth, "workspaceId", workspaceId, "hasKey", credentialRef != null, "revision", revision);
        }
    }
    private final Path db;
    ModelProfiles(ProjectStore projects) { db = projects.appDatabase(); }
    private static Profile row(Map<String,Object> row) {
        return new Profile((String)row.get("id"), (String)row.get("name"), (String)row.get("protocol"),
            (String)row.get("base_url"), (String)row.get("model"), (String)row.get("anthropic_auth"),
            (String)row.get("workspace_id"), (String)row.get("credential_ref"), ((Number)row.get("revision")).intValue());
    }
    private static Profile find(JdbcTemplate jdbc, String id) {
        var rows = jdbc.queryForList("SELECT * FROM model_profiles WHERE id=?", id);
        return rows.isEmpty() ? null : row(rows.get(0));
    }
    List<Profile> internalList() {
        return Database.use(db, false, jdbc -> jdbc.queryForList("SELECT * FROM model_profiles ORDER BY updated_at,id").stream().map(ModelProfiles::row).toList());
    }
    Map<String,Object> list() {
        return Database.use(db, true, jdbc -> {
            var value = new LinkedHashMap<String,Object>();
            value.put("profiles", jdbc.queryForList("SELECT * FROM model_profiles ORDER BY updated_at,id").stream().map(ModelProfiles::row).map(Profile::publicValue).toList());
            value.put("activeProfileId", jdbc.queryForObject("SELECT active_profile_id FROM model_settings WHERE singleton=1", String.class));
            return value;
        });
    }
    Profile get(String id) {
        uuid(id);
        return Database.use(db, false, jdbc -> {
            Profile value = find(jdbc, id);
            if (value == null) throw new ApiException("PROFILE_NOT_FOUND", 404, "模型配置不存在，请重新加载");
            return value;
        });
    }
    static void uuid(String value) {
        try { if (!UUID.fromString(value).toString().equals(value)) throw new IllegalArgumentException(); }
        catch (Exception error) { throw ApiException.invalid("配置标识需为 UUID"); }
    }
    static int revision(Object value) {
        if (!(value instanceof Number n) || n.doubleValue() != n.intValue() || n.intValue() < 0) throw ApiException.invalid("配置版本无效");
        return n.intValue();
    }
    private static String text(Object value, String field, int max) {
        if (!(value instanceof String s) || s.trim().isEmpty() || s.trim().length() > max || s.chars().anyMatch(Character::isISOControl)) throw ApiException.invalid(field + "格式无效");
        return s.trim();
    }
    static boolean loopback(String host) { return Set.of("localhost", "127.0.0.1", "::1", "[::1]").contains(host.toLowerCase(Locale.ROOT)); }
    static String baseUrl(Object value) {
        String raw = text(value, "基础地址", 2048);
        try {
            URI uri = URI.create(raw);
            String host = uri.getHost(), scheme = Objects.toString(uri.getScheme(), "").toLowerCase(Locale.ROOT);
            if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(scheme.equals("https") || scheme.equals("http") && loopback(host))
                || uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException();
            String path = Objects.toString(uri.getPath(), "").replaceAll("/+$", "");
            if (List.of("/chat/completions", "/messages", "/api/chat").stream().anyMatch(path::endsWith)) throw ApiException.invalid("请填写基础地址，移除末尾的模型接口路径；可查看下方最终请求地址");
            return new URI(scheme, null, host.toLowerCase(Locale.ROOT), uri.getPort(), path, null, null).normalize().toASCIIString();
        } catch (ApiException error) { throw error; }
        catch (Exception error) { throw ApiException.invalid("基础地址需为 HTTPS；本机 localhost、127.0.0.1 或 ::1 可使用 HTTP，且不能包含账号、查询参数或片段"); }
    }
    Profile save(String id, Map<String,Object> body) {
        uuid(id);
        int expected = revision(body.get("expectedRevision"));
        String name = text(body.get("name"), "配置名称", 80), model = text(body.get("model"), "模型标识", 200);
        String protocol = text(body.get("protocol"), "协议", 30), base = baseUrl(body.get("baseUrl"));
        if (!Set.of("openai-compatible", "anthropic", "ollama").contains(protocol)) throw ApiException.invalid("模型协议无效");
        String auth = Objects.toString(body.getOrDefault("anthropicAuth", "x-api-key"), "");
        if (!Set.of("x-api-key", "bearer").contains(auth)) throw ApiException.invalid("Anthropic 鉴权方式无效");
        String workspace = body.get("workspaceId") == null ? "" : Objects.toString(body.get("workspaceId")).trim();
        if (workspace.length() > 200 || workspace.chars().anyMatch(Character::isISOControl)) throw ApiException.invalid("工作区标识无效");
        if (!protocol.equals("anthropic")) { auth = "x-api-key"; workspace = ""; }
        String ref = body.get("credentialRef") == null ? null : text(body.get("credentialRef"), "凭据引用", 120);
        if (ref != null) {
            String prefix = "model-profile/" + id + "/";
            if (!ref.startsWith(prefix)) throw ApiException.invalid("凭据引用无效");
            uuid(ref.substring(prefix.length()));
        }
        if (ref == null && !loopback(URI.create(base).getHost())) throw ApiException.invalid("远程模型配置需要密钥；本机免密服务可留空");
        Profile requested = new Profile(id, name, protocol, base, model, auth, workspace, ref, expected + 1);
        return Database.use(db, true, jdbc -> {
            Profile old = find(jdbc, id);
            if (old != null && sameContent(old, requested)) return old;
            if (old == null ? expected != 0 : old.revision() != expected) throw new ApiException("PROFILE_CONFLICT", 409, "配置已变化，请重新加载后编辑");
            if (old != null && old.credentialRef() != null && Objects.equals(old.credentialRef(), requested.credentialRef())
                && (!old.protocol().equals(requested.protocol()) || !old.baseUrl().equals(requested.baseUrl()))) throw ApiException.invalid("协议或基础地址已变化，请重新输入或显式清除密钥");
            jdbc.update("INSERT INTO model_profiles(id,name,protocol,base_url,model,anthropic_auth,workspace_id,credential_ref,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,model=excluded.model,anthropic_auth=excluded.anthropic_auth,workspace_id=excluded.workspace_id,credential_ref=excluded.credential_ref,revision=excluded.revision,updated_at=excluded.updated_at",
                id, name, protocol, base, model, requested.anthropicAuth(), requested.workspaceId(), ref, requested.revision(), Instant.now().toString());
            return requested;
        });
    }
    private static boolean sameContent(Profile a, Profile b) {
        return a.name().equals(b.name()) && a.protocol().equals(b.protocol()) && a.baseUrl().equals(b.baseUrl()) && a.model().equals(b.model())
            && a.anthropicAuth().equals(b.anthropicAuth()) && a.workspaceId().equals(b.workspaceId()) && Objects.equals(a.credentialRef(), b.credentialRef());
    }
    void delete(String id, int expected) {
        uuid(id);
        Database.use(db, true, jdbc -> {
            Profile old = find(jdbc, id);
            if (old == null) throw new ApiException("PROFILE_NOT_FOUND", 404, "模型配置不存在");
            if (old.revision() != expected) throw new ApiException("PROFILE_CONFLICT", 409, "配置已变化，请重新加载后删除");
            jdbc.update("DELETE FROM model_profiles WHERE id=?", id); return null;
        });
    }
    void activate(Object id) {
        if (id != null && !(id instanceof String)) throw ApiException.invalid("当前配置标识无效");
        if (id != null) uuid((String)id);
        Database.use(db, true, jdbc -> {
            if (id != null && find(jdbc, (String)id) == null) throw new ApiException("PROFILE_NOT_FOUND", 404, "模型配置不存在");
            jdbc.update("UPDATE model_settings SET active_profile_id=? WHERE singleton=1", id); return null;
        });
    }
}
