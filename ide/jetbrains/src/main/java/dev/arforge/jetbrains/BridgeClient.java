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
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

public final class BridgeClient implements Disposable {
    public static final String PROTOCOL = "arforge.bridge";
    public static final String VERSION = "1.2";
    public static final int MAX_REQUEST_BYTES = 1024 * 1024;

    private final Gson gson = new Gson();
    private final AtomicLong ids = new AtomicLong(1);
    private final Map<Long, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
    private final Queue<String> stderr = new ArrayDeque<>();
    private volatile Consumer<JsonObject> eventConsumer = ignored -> {};
    private volatile Process process;
    private volatile BufferedWriter writer;

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
            return request("health", new JsonObject(), Duration.ofSeconds(15));
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
        for (CompletableFuture<JsonObject> future : pending.values()) {
            future.completeExceptionally(error);
        }
        pending.clear();
    }

    @Override
    public void dispose() {
        Process current = process;
        process = null;
        writer = null;
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
