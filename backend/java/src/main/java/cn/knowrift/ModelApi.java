package cn.knowrift;

import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
final class ModelApi {
    private final ModelProfiles profiles;
    private final ModelTests tests;
    ModelApi(ModelProfiles profiles, ModelTests tests) { this.profiles = profiles; this.tests = tests; }
    @GetMapping("/api/v1/model-profiles") Map<String,Object> list() { return profiles.list(); }
    @GetMapping("/internal/model-profiles") List<ModelProfiles.Profile> internalList() { return profiles.internalList(); }
    @PutMapping("/api/v1/model-profiles/{id}") Map<String,Object> save(@PathVariable String id, @RequestBody Map<String,Object> body) { return profiles.save(id, body).publicValue(); }
    @DeleteMapping("/api/v1/model-profiles/{id}") Map<String,Object> delete(@PathVariable String id, @RequestBody Map<String,Object> body) {
        profiles.delete(id, ModelProfiles.revision(body.get("expectedRevision"))); return Map.of("deleted", true);
    }
    @PutMapping("/api/v1/model-settings/active") Map<String,Object> activate(@RequestBody Map<String,Object> body) {
        if (!body.containsKey("profileId")) throw ApiException.invalid("需要指定配置或明确清空选择");
        profiles.activate(body.get("profileId")); return profiles.list();
    }
    @PostMapping("/internal/model-profiles/{id}/test") Map<String,Object> test(@PathVariable String id, @RequestBody Map<String,Object> body) { return tests.test(id, body); }
}
