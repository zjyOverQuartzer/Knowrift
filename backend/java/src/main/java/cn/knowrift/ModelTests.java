package cn.knowrift;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Service;

@Service
final class ModelTests implements AutoCloseable {
    private final ModelProfiles profiles;
    private final AtomicBoolean testing = new AtomicBoolean();
    private final Set<CompletableFuture<?>> pending = ConcurrentHashMap.newKeySet();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    ModelTests(ModelProfiles profiles) { this.profiles = profiles; }
    @SuppressWarnings("unchecked")
    Map<String,Object> test(String id, Map<String,Object> body) {
        if (!testing.compareAndSet(false, true)) throw new ApiException("TEST_BUSY", 409, "已有连接测试正在进行，请稍后再试");
        try {
            var profile = profiles.get(id);
            if (profile.revision() != ModelProfiles.revision(body.get("expectedRevision"))) throw new ApiException("PROFILE_CONFLICT", 409, "配置已变化，请重新加载后测试");
            String key = body.get("apiKey") instanceof String s ? s : "";
            if (key.length() > 8192 || key.chars().anyMatch(Character::isISOControl)) throw ApiException.invalid("密钥格式无效");
            if (profile.credentialRef() != null && key.isEmpty()) throw new ApiException("CREDENTIAL_UNAVAILABLE", 503, "无法读取该配置的密钥，请重新输入并保存");
            if (profile.credentialRef() == null && !key.isEmpty()) throw ApiException.invalid("配置凭据已变化，请重新加载后测试");
            if (!(body.get("peer") instanceof Map<?,?> peer) || !(peer.get("port") instanceof Number port)
                || port.intValue() != port.doubleValue() || port.intValue() < 1 || port.intValue() > 65535
                || !(peer.get("token") instanceof String token) || !token.matches("[a-f0-9]{64}")
                || !(peer.get("instanceId") instanceof String instance) || !Objects.equals(peer.get("protocolVersion"), 1)) throw ApiException.invalid("智能服务连接信息无效");
            ModelProfiles.uuid(instance);
            String root = "http://127.0.0.1:" + port.intValue();
            var health = request(root + "/health/ready", token, null, 3);
            if (!Boolean.TRUE.equals(health.get("ready")) || !"python".equals(health.get("service"))
                || !instance.equals(health.get("instanceId")) || !Objects.equals(health.get("protocolVersion"), 1)) throw new ApiException("SERVICE_UNAVAILABLE", 503, "智能服务实例已变化，请等待就绪后重试");
            var parameters = new LinkedHashMap<String,Object>();
            parameters.put("instanceId", instance);
            parameters.put("profile", Map.of("protocol", profile.protocol(), "baseUrl", profile.baseUrl(), "model", profile.model(), "anthropicAuth", profile.anthropicAuth(), "workspaceId", profile.workspaceId()));
            parameters.put("apiKey", key);
            var result = request(root + "/internal/models/test", token, parameters, 65);
            var response = new LinkedHashMap<String,Object>();
            response.put("profileId", id); response.put("revision", profile.revision());
            response.put("ok", Boolean.TRUE.equals(result.get("ok")));
            response.put("code", safe(result.get("code"), key, 80));
            response.put("message", safe(result.get("message"), key, 200));
            response.put("preview", safe(result.get("preview"), key, 200));
            response.put("latencyMs", result.get("latencyMs") instanceof Number n ? Math.max(0, n.longValue()) : 0);
            return response;
        } finally { testing.set(false); }
    }
    private static String safe(Object value, String key, int length) {
        String text = value instanceof String s ? s : "";
        if (!key.isEmpty()) text = text.replace(key, "[已隐藏]");
        return text.substring(0, Math.min(length, text.length()));
    }
    @SuppressWarnings("unchecked")
    private Map<String,Object> request(String url, String token, Object body, int seconds) {
        CompletableFuture<HttpResponse<String>> future = null;
        try {
            var builder = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(seconds)).header("Authorization", "Bearer " + token);
            if (body != null) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(LocalApplication.JSON.writeValueAsString(body)));
            future = client.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString()); pending.add(future);
            var response = future.get(seconds, TimeUnit.SECONDS);
            if (response.statusCode() != 200 || response.body().length() > 16384) throw new IllegalStateException();
            return LocalApplication.JSON.readValue(response.body(), Map.class);
        } catch (Exception error) {
            if (future != null) future.cancel(true);
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new ApiException("SERVICE_UNAVAILABLE", 503, "智能服务连接中断或不可用，请检查状态后手动重试");
        } finally { if (future != null) pending.remove(future); }
    }
    @Override @jakarta.annotation.PreDestroy public void close() { pending.forEach(future -> future.cancel(true)); }
}
