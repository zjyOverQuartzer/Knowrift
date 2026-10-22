package cn.knowrift;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.boot.*;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.dao.DataAccessException;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

@SpringBootApplication(excludeName = "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration")
public class LocalApplication {
    static final JsonMapper JSON = JsonMapper.builder().build();
    static Map<String,Object> bootstrap;
    public static void main(String[] args) throws Exception {
        if (Runtime.version().feature() != 17) throw new IllegalStateException("JDK 17 is required");
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line = input.readLine();
        if (line == null) throw new IllegalArgumentException("Missing bootstrap configuration");
        bootstrap = JSON.readValue(line, Map.class);
        if (!Objects.equals(bootstrap.get("protocolVersion"), 1) || !(bootstrap.get("token") instanceof String token) || token.length() < 32 || !(bootstrap.get("instanceId") instanceof String) || !(bootstrap.get("home") instanceof String)) throw new IllegalArgumentException("Invalid bootstrap configuration");
        Thread parent = new Thread(() -> {
            try { while (input.readLine() != null) { } } catch (IOException ignored) { }
            // System.exit also covers a parent disappearing while Spring is still starting.
            System.exit(0);
        }, "parent-pipe"); parent.setDaemon(true); parent.start();
        SpringApplication application = new SpringApplication(LocalApplication.class);
        application.setDefaultProperties(Map.of("server.address", "127.0.0.1", "server.port", "0", "spring.main.banner-mode", "off", "logging.level.root", "WARN", "server.shutdown", "graceful", "spring.lifecycle.timeout-per-shutdown-phase", "5s"));
        ConfigurableApplicationContext context = application.run("--server.address=127.0.0.1", "--server.port=0");
        int port = ((WebServerApplicationContext)context).getWebServer().getPort();
        System.out.println(JSON.writeValueAsString(Map.of("type", "ready", "service", "java", "port", port, "instanceId", bootstrap.get("instanceId"), "protocolVersion", 1)));
        System.out.flush();
    }
    @Bean(destroyMethod = "close") ProjectStore projects() throws IOException { return new ProjectStore(Path.of((String)bootstrap.get("home"))); }
    @Bean OncePerRequestFilter accessToken() {
        return new OncePerRequestFilter() {
            @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
                String expected = "Bearer " + bootstrap.get("token");
                String received = Objects.toString(request.getHeader("Authorization"), "");
                if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8))) {
                    response.setStatus(401); response.setContentType("application/json;charset=UTF-8");
                    response.getWriter().write("{\"code\":\"UNAUTHORIZED\",\"message\":\"本机服务访问凭据无效\"}"); return;
                }
                chain.doFilter(request, response);
            }
        };
    }
    @RestController static class Api {
        private final ProjectStore projects;
        Api(ProjectStore projects) { this.projects = projects; }
        @GetMapping("/health/ready") Map<String,Object> ready() { return Map.of("ready", true, "service", "java", "instanceId", bootstrap.get("instanceId"), "protocolVersion", 1); }
        @PostMapping("/internal/shutdown") Map<String,Object> shutdown() {
            Thread exit = new Thread(() -> { try { Thread.sleep(100); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } System.exit(0); }, "requested-shutdown");
            exit.setDaemon(true); exit.start(); return Map.of("stopping", true);
        }
        @GetMapping("/api/v1/projects") List<ProjectStore.Project> list() { return projects.list(); }
        @GetMapping("/api/v1/projects/{id}") ProjectStore.Project get(@PathVariable String id) { return projects.get(id); }
        @PostMapping("/api/v1/projects") ResponseEntity<ProjectStore.Project> create(@RequestBody Map<String,Object> body) {
            var created = projects.create(body); return ResponseEntity.status(created.replayed() ? 200 : 201).body(created.project());
        }
        @PatchMapping("/api/v1/projects/{id}") ProjectStore.Project patch(@PathVariable String id, @RequestBody Map<String,Object> body) { return projects.patch(id, body); }
    }
    @RestControllerAdvice static class Errors {
        @ExceptionHandler(ApiException.class) ResponseEntity<Map<String,String>> api(ApiException error) { return ResponseEntity.status(error.status).body(Map.of("code", error.code, "message", error.getMessage())); }
        @ExceptionHandler(HttpMessageNotReadableException.class) ResponseEntity<Map<String,String>> input() { return ResponseEntity.badRequest().body(Map.of("code", "INVALID_INPUT", "message", "请求内容格式无效")); }
        @ExceptionHandler(DataAccessException.class) ResponseEntity<Map<String,String>> database() { return ResponseEntity.status(503).body(Map.of("code", "DATABASE_BUSY", "message", "数据库暂不可用，请稍后重试")); }
        @ExceptionHandler(Exception.class) ResponseEntity<Map<String,String>> other() { return ResponseEntity.status(500).body(Map.of("code", "INTERNAL_ERROR", "message", "项目服务暂时无法完成操作，请检查本机服务日志")); }
    }
}
