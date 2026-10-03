package dev.arforge.jetbrains;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.nio.file.Files;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

final class BridgeClientIntegrationTest {
    @TempDir
    Path profile;

    @Test
    void startsRealBridgeAndCreatesSession() {
        Path repository = Path.of("..", "..").toAbsolutePath().normalize();
        Path workspace = profile.resolve("workspace");
        try {
            Files.createDirectories(workspace);
            Files.writeString(workspace.resolve("tracked.txt"), "before\n");
            run(workspace, "git", "init", "-b", "main");
            run(workspace, "git", "config", "user.email", "test@arforge.local");
            run(workspace, "git", "config", "user.name", "Arforge Test");
            run(workspace, "git", "add", "tracked.txt");
            run(workspace, "git", "commit", "-m", "base");
            Files.writeString(workspace.resolve("tracked.txt"), "before\nafter\n");
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
        Map<String, String> environment = new HashMap<>();
        environment.put("ARFORGE_HOME", profile.toString());
        environment.put("ARFORGE_WORKSPACE", workspace.toString());
        environment.put(
                "ARFORGE_DB_URL",
                "sqlite:///" + profile.resolve("main.db").toString().replace('\\', '/')
        );
        environment.put(
                "ARFORGE_MULTIAGENT_DB_URL",
                "sqlite:///" + profile.resolve("multi.db").toString().replace('\\', '/')
        );

        BridgeClient bridge = new BridgeClient();
        try {
            JsonObject health = bridge.start(
                    "bun",
                    new String[]{
                            "--conditions=browser",
                            repository.resolve("packages/arforge/src/index.ts").toString(),
                            "bridge"
                    },
                    workspace,
                    environment
            ).join();
            JsonObject session = bridge.request(
                    "session.create", new JsonObject(), Duration.ofSeconds(30)
            ).join();
            JsonObject resumeParams = new JsonObject();
            resumeParams.addProperty("session_id", session.get("session_id").getAsString());
            JsonObject resumed = bridge.request(
                    "session.resume", resumeParams, Duration.ofSeconds(30)
            ).join();
            JsonObject diffParams = new JsonObject();
            diffParams.addProperty("max_chars", 10_000);
            JsonObject changes = bridge.request(
                    "git.diff", diffParams, Duration.ofSeconds(30)
            ).join();

            assertEquals("ok", health.get("status").getAsString());
            assertEquals("typescript", health.get("runtime").getAsString());
            assertFalse(session.get("session_id").getAsString().isBlank());
            assertEquals(
                    session.get("session_id").getAsString(),
                    resumed.get("session_id").getAsString()
            );
            assertFalse(changes.get("root").getAsString().isBlank());
        } finally {
            bridge.dispose();
        }
    }

    private static void run(Path cwd, String... command) throws Exception {
        Process process = new ProcessBuilder(command)
                .directory(cwd.toFile())
                .redirectErrorStream(true)
                .start();
        if (process.waitFor() != 0) {
            throw new IllegalStateException(
                    String.join(" ", command) + " failed: "
                            + new String(process.getInputStream().readAllBytes())
            );
        }
    }
}
