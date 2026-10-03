package dev.arforge.jetbrains;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.stream.Collectors;

public final class BridgeClient implements Disposable {
    public static final String PROTOCOL = "arforge.bridge";
    public static final String VERSION = "1.2";
    public static final int MAX_REQUEST_BYTES = 1024 * 1024;
    private static final Set<String> REQUIRED_METHODS = Set.of(
            "protocol.describe",
            "health",
            "workspace.get",
            "session.create",
            "session.resume",
            "chat.start",
            "chat.cancel",
            "git.diff"
    );

    private final Gson gson = new Gson();
    private final AtomicLong ids = new AtomicLong(1);
    private final Map<Long, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
    private final Queue<String> stderr = new ArrayDeque<>();
    private volatile Consumer<JsonObject> eventConsumer = ignored -> {};
    private volatile Process process;
    private volatile BufferedWriter writer;
    private volatile Set<String> methods = Set.of();

    public CompletableFuture<JsonObject> start(
            String command,
            String[] args,
            Path workspace,
            Map<String, String> environment
    ) {
        if (isRunning()) {
            return CompletableFuture.completedFuture(new JsonObject());
        }
        try {
            String[] fullCommand = new String[args.length + 1];
            fullCommand[0] = command;
            System.arraycopy(args, 0, fullCommand, 1, args.length);
            ProcessBuilder builder = new ProcessBuilder(fullCommand);
            builder.directory(workspace.toFile());
            builder.environment().putAll(environment);
            builder.redirectErrorStream(false);
            process = builder.start();
            writer = new BufferedWriter(
                    new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)
            );
            startReaders(process);
            return request("protocol.describe", new JsonObject(), Duration.ofSeconds(15))
                    .thenCompose(description -> {
                        Set<String> advertised = advertisedMethods(description);
                        Set<String> missing = new HashSet<>(REQUIRED_METHODS);
                        missing.removeAll(advertised);
                        if (!isTypeScriptDescription(description) || !missing.isEmpty()) {
                            return CompletableFuture.failedFuture(
                                    new IllegalStateException(
                                            missing.isEmpty()
                                                    ? "Arforge Bridge 不是受支持的 TypeScript 运行时"
                                                    : "Arforge Bridge 缺少必需能力："
                                                            + missing.stream().sorted().collect(Collectors.joining(", "))
                                    )
                            );
                        }
                        methods = Collections.unmodifiableSet(advertised);
                        return request("health", new JsonObject(), Duration.ofSeconds(15));
                    })
                    .thenCompose(health -> {
                        if (!isTypeScriptHealth(health)) {
                            return CompletableFuture.failedFuture(
                                    new IllegalStateException(
                                            "Arforge Bridge 健康检查未确认 TypeScript 运行时"
                                    )
                            );
                        }
                        return CompletableFuture.completedFuture(health);
                    })
                    .whenComplete((ignored, error) -> {
                        if (error != null) {
                            terminateProcess(error);
                        }
                    });
        } catch (IOException error) {
            return CompletableFuture.failedFuture(error);
        }
    }

    public boolean isRunning() {
        Process current = process;
        return current != null && current.isAlive();
    }

    public void onEvent(Consumer<JsonObject> consumer) {
        eventConsumer = Objects.requireNonNull(consumer);
    }

    public CompletableFuture<JsonObject> request(
            String method,
            JsonObject params,
            Duration timeout
    ) {
        if (!isRunning() || writer == null) {
            return CompletableFuture.failedFuture(
                    new IllegalStateException("Arforge Bridge 未运行")
            );
        }
        if (!methods.isEmpty() && !methods.contains(method)) {
            return CompletableFuture.failedFuture(
                    new IllegalStateException("当前 Bridge 未宣布能力：" + method)
            );
        }
        long id = ids.getAndIncrement();
        JsonObject request = new JsonObject();
        request.addProperty("protocol", PROTOCOL);
        request.addProperty("version", VERSION);
        request.addProperty("id", id);
        request.addProperty("method", method);
        request.add("params", params);
        String encoded = gson.toJson(request) + "\n";
        if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            return CompletableFuture.failedFuture(
                    new IllegalArgumentException("Bridge 请求超过 1 MiB")
            );
        }

        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        pending.put(id, future);
        timers.schedule(
                () -> {
                    CompletableFuture<JsonObject> waiting = pending.remove(id);
                    if (waiting != null) {
                        waiting.completeExceptionally(
                                new IllegalStateException("Bridge 请求超时：" + method)
                        );
                    }
                },
                timeout.toMillis(),
                TimeUnit.MILLISECONDS
        );
        try {
            synchronized (this) {
                writer.write(encoded);
                writer.flush();
            }
        } catch (IOException error) {
            pending.remove(id);
            future.completeExceptionally(error);
        }
        return future;
    }

    private void startReaders(Process child) {
        Thread stdoutThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = reader.readLine()) != null) {
                    handleLine(line);
                }
            } catch (IOException error) {
                closeWithError(error);
            }
        }, "arforge-bridge-out");
        stdoutThread.setDaemon(true);
        stdoutThread.start();

        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(child.getErrorStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = reader.readLine()) != null) {
                    synchronized (stderr) {
                        stderr.add(line.substring(0, Math.min(line.length(), 1000)));
                        while (stderr.size() > 20) {
                            stderr.remove();
                        }
                    }
                }
            } catch (IOException ignored) {
                // The stream normally closes when the bridge process exits.
            }
        }, "arforge-bridge-err");
        stderrThread.setDaemon(true);
        stderrThread.start();

        child.onExit().thenRun(() -> {
            if (process == child) {
                closeWithError(new IllegalStateException(diagnostic(child.exitValue())));
            }
        });
    }

    private void handleLine(String line) {
        JsonObject message;
        try {
            message = gson.fromJson(line, JsonObject.class);
        } catch (RuntimeException ignored) {
            return;
        }
        if (message == null) {
            return;
        }
        if (message.has("event") && message.get("event").getAsBoolean()) {
            if (protocolMatches(message)) {
                eventConsumer.accept(message);
            }
            return;
        }
        if (!message.has("id")) {
            return;
        }
        CompletableFuture<JsonObject> future = pending.remove(message.get("id").getAsLong());
        if (future == null) {
            return;
        }
        if (!protocolMatches(message)) {
            future.completeExceptionally(new IllegalStateException("Bridge 协议版本不匹配"));
        } else if (!message.has("ok") || !message.get("ok").getAsBoolean()) {
            String detail = message.has("error")
                    ? message.get("error").toString()
                    : "Bridge 请求失败";
            future.completeExceptionally(new IllegalStateException(detail));
        } else {
            future.complete(message.has("data")
                    ? message.getAsJsonObject("data")
                    : new JsonObject());
        }
    }

    private boolean protocolMatches(JsonObject message) {
        return message.has("protocol")
                && PROTOCOL.equals(message.get("protocol").getAsString())
                && message.has("version")
                && VERSION.equals(message.get("version").getAsString());
    }

    private boolean isTypeScriptDescription(JsonObject description) {
        return description != null
                && description.has("protocol")
                && PROTOCOL.equals(description.get("protocol").getAsString())
                && description.has("runtime")
                && "typescript".equals(description.get("runtime").getAsString());
    }

    private boolean isTypeScriptHealth(JsonObject health) {
        return health != null
                && health.has("status")
                && "ok".equals(health.get("status").getAsString())
                && health.has("runtime")
                && "typescript".equals(health.get("runtime").getAsString());
    }

    private Set<String> advertisedMethods(JsonObject description) {
        if (description == null || !description.has("methods") || !description.get("methods").isJsonArray()) {
            return Set.of();
        }
        Set<String> result = new HashSet<>();
        description.getAsJsonArray("methods").forEach(value -> {
            if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
                result.add(value.getAsString());
            }
        });
        return result;
    }

    private String diagnostic(int exitCode) {
        synchronized (stderr) {
            if (!stderr.isEmpty()) {
                return String.join("\n", stderr);
            }
        }
        return "Arforge Bridge 已退出（code " + exitCode + "）";
    }

    private void closeWithError(Throwable error) {
        process = null;
        writer = null;
        methods = Set.of();
        for (CompletableFuture<JsonObject> future : pending.values()) {
            future.completeExceptionally(error);
        }
        pending.clear();
    }

    private void terminateProcess(Throwable error) {
        Process current = process;
        process = null;
        writer = null;
        methods = Set.of();
        for (CompletableFuture<JsonObject> future : pending.values()) {
            future.completeExceptionally(error);
        }
        pending.clear();
        if (current != null && current.isAlive()) {
            current.destroy();
        }
    }

    @Override
    public void dispose() {
        Process current = process;
        process = null;
        writer = null;
        methods = Set.of();
        timers.shutdownNow();
        if (current != null && current.isAlive()) {
            current.destroy();
            try {
                if (!current.waitFor(2, TimeUnit.SECONDS)) {
                    current.destroyForcibly();
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                current.destroyForcibly();
            }
        }
    }
}
