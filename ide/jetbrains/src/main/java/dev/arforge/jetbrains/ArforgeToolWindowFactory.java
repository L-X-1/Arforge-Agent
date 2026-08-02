package dev.arforge.jetbrains;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx;
import com.intellij.codeInsight.daemon.impl.HighlightInfo;
import com.intellij.ide.impl.TrustedProjects;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.lang.annotation.HighlightSeverity;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.LogicalPosition;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.components.JBTextArea;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

public final class ArforgeToolWindowFactory implements ToolWindowFactory, DumbAware {
    private static final int MAX_SELECTION_CHARS = 20_000;
    private static final int MAX_DIAGNOSTICS = 100;
    private static final String SESSION_KEY = "arforge.session.id";

    @Override
    public void createToolWindowContent(
            @NotNull Project project,
            @NotNull ToolWindow toolWindow
    ) {
        Panel panel = new Panel(project);
        Content content = ContentFactory.getInstance().createContent(panel.root, "", false);
        Disposer.register(content, panel.client);
        toolWindow.getContentManager().addContent(content);
    }

    private static final class Panel {
        private final Project project;
        private final BridgeClient client = new BridgeClient();
        private final JPanel root = new JPanel(new BorderLayout(8, 8));
        private final JBTextArea transcript = new JBTextArea();
        private final JBTextArea input = new JBTextArea(4, 40);
        private final JBLabel status = new JBLabel("未连接");
        private final JComboBox<String> effort =
                new JComboBox<>(new String[]{"low", "medium", "high", "ultra"});
        private final JComboBox<String> permission =
                new JComboBox<>(new String[]{"requestApproval", "autoApprove", "fullAccess"});
        private volatile String sessionId = "";
        private volatile String operationId = "";

        private Panel(Project project) {
            this.project = project;
            transcript.setEditable(false);
            transcript.setLineWrap(true);
            transcript.setWrapStyleWord(true);
            input.setLineWrap(true);
            input.setWrapStyleWord(true);
            effort.setSelectedItem("medium");
            permission.setSelectedItem("autoApprove");

            JPanel toolbar = new JPanel(new FlowLayout(FlowLayout.LEFT));
            JButton explain = new JButton("解释选区");
            JButton fix = new JButton("修复选区");
            JButton review = new JButton("审查项目");
            JButton changes = new JButton("审查变更");
            JButton fresh = new JButton("新对话");
            toolbar.add(status);
            toolbar.add(new JBLabel("推理"));
            toolbar.add(effort);
            toolbar.add(new JBLabel("权限"));
            toolbar.add(permission);
            toolbar.add(explain);
            toolbar.add(fix);
            toolbar.add(review);
            toolbar.add(changes);
            toolbar.add(fresh);

            JPanel composer = new JPanel(new BorderLayout(6, 6));
            JButton send = new JButton("发送");
            composer.add(new JBScrollPane(input), BorderLayout.CENTER);
            composer.add(send, BorderLayout.EAST);

            root.add(toolbar, BorderLayout.NORTH);
            root.add(new JBScrollPane(transcript), BorderLayout.CENTER);
            root.add(composer, BorderLayout.SOUTH);

            send.addActionListener(event -> send(input.getText(), false));
            explain.addActionListener(event -> send(
                    "解释所选代码的行为、关键依赖和潜在风险。只分析，不修改文件。", false
            ));
            fix.addActionListener(event -> send(
                    "修复所选代码中的问题，保持改动最小，完成后运行相关测试。", true
            ));
            review.addActionListener(event -> send(
                    "审查当前项目的架构、正确性、安全性和测试缺口，给出有文件证据的结论。只分析，不修改文件。",
                    true
            ));
            changes.addActionListener(event -> reviewChanges(true));
            fresh.addActionListener(event -> newSession());
            client.onEvent(this::onBridgeEvent);
            connect();
        }

        private void connect() {
            if (!TrustedProjects.isTrusted(project)) {
                status.setText("工作区未受信任");
                append("Arforge 不会在未受信任项目中启动 Bridge。\n");
                return;
            }
            status.setText("连接中…");
            Path workspace = Path.of(
                    project.getBasePath() == null ? "." : project.getBasePath()
            ).toAbsolutePath().normalize();
            Map<String, String> environment = new HashMap<>();
            environment.put("ARFORGE_WORKSPACE", workspace.toString());
            environment.put("PYTHONUTF8", "1");
            String profile = System.getProperty("arforge.bridge.profile", "").trim();
            if (!profile.isEmpty()) {
                environment.put("ARFORGE_HOME", profile);
            }
            String command = System.getProperty("arforge.bridge.command", "python");
            client.start(
                    command,
                    new String[]{"-m", "arforge.bridge"},
                    workspace,
                    environment
            ).thenCompose(ignored -> resumeOrCreateSession())
                    .whenComplete((session, error) -> {
                        if (error != null) {
                            ui(() -> {
                                status.setText("连接失败");
                                append(error.getMessage() + "\n");
                            });
                            return;
                        }
                        sessionId = session.get("session_id").getAsString();
                        PropertiesComponent.getInstance(project).setValue(SESSION_KEY, sessionId);
                        ui(() -> status.setText("已连接"));
                    });
        }

        private CompletableFuture<JsonObject> resumeOrCreateSession() {
            String stored = PropertiesComponent.getInstance(project).getValue(SESSION_KEY, "");
            if (stored.isBlank()) {
                return client.request("session.create", new JsonObject(), Duration.ofSeconds(30));
            }
            JsonObject params = new JsonObject();
            params.addProperty("session_id", stored);
            return client.request("session.resume", params, Duration.ofSeconds(30))
                    .exceptionallyCompose(error ->
                            client.request("session.create", new JsonObject(), Duration.ofSeconds(30))
                    );
        }

        private void newSession() {
            if (!client.isRunning()) {
                append("Bridge 尚未就绪。\n");
                return;
            }
            PropertiesComponent.getInstance(project).unsetValue(SESSION_KEY);
            client.request("session.create", new JsonObject(), Duration.ofSeconds(30))
                    .whenComplete((session, error) -> {
                        if (error != null) {
                            ui(() -> append(error.getMessage() + "\n"));
                            return;
                        }
                        sessionId = session.get("session_id").getAsString();
                        PropertiesComponent.getInstance(project).setValue(SESSION_KEY, sessionId);
                        ui(() -> {
                            transcript.setText("");
                            status.setText("已连接");
                        });
                    });
        }

        private void send(String prompt, boolean longTask) {
            String trimmed = prompt == null ? "" : prompt.trim();
            if (trimmed.isEmpty()) {
                return;
            }
            if (sessionId.isEmpty()) {
                append("Bridge 尚未就绪。\n");
                return;
            }
            JsonObject context = buildEditorContext(longTask);
            input.setText("");
            append("\n你：\n" + trimmed + "\n\nArforge：\n");
            JsonObject params = new JsonObject();
            params.addProperty("session_id", sessionId);
            params.addProperty("input", trimmed);
            params.addProperty("timeout_ms", 0);
            params.addProperty("reasoning_effort", String.valueOf(effort.getSelectedItem()));
            params.addProperty("permission_mode", String.valueOf(permission.getSelectedItem()));
            params.add("context", context);
            status.setText("运行中…");
            client.request("chat.start", params, Duration.ofMinutes(2))
                    .whenComplete((operation, error) -> {
                        if (error != null) {
                            ui(() -> {
                                status.setText("失败");
                                append(error.getMessage() + "\n");
                            });
                        } else {
                            operationId = operation.get("operation_id").getAsString();
                        }
                    });
        }

        private JsonObject buildEditorContext(boolean longTask) {
            JsonObject context = new JsonObject();
            if (longTask) {
                context.addProperty("long_task", true);
            }
            Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
            if (editor == null) {
                return context;
            }
            Document document = editor.getDocument();
            VirtualFile file = FileDocumentManager.getInstance().getFile(document);
            if (file == null) {
                return context;
            }
            String relative = file.getPath();
            String basePath = project.getBasePath();
            if (basePath != null) {
                try {
                    Path base = Path.of(basePath).toAbsolutePath().normalize();
                    Path active = Path.of(file.getPath()).toAbsolutePath().normalize();
                    if (active.startsWith(base)) {
                        relative = base.relativize(active).toString().replace('\\', '/');
                    }
                } catch (RuntimeException ignored) {
                    // Keep the absolute virtual-file path if the local path cannot be normalized.
                }
            }
            JsonArray paths = new JsonArray();
            JsonObject path = new JsonObject();
            path.addProperty("path", relative);
            path.addProperty("kind", "file");
            paths.add(path);
            context.add("paths", paths);

            JsonObject editorContext = new JsonObject();
            editorContext.addProperty("file", relative);
            editorContext.addProperty("language", file.getFileType().getName());
            editorContext.addProperty(
                    "cursor",
                    positionText(editor.offsetToLogicalPosition(editor.getCaretModel().getOffset()))
            );
            String selection = editor.getSelectionModel().getSelectedText();
            if (selection != null && !selection.isEmpty()) {
                editorContext.addProperty(
                        "selection",
                        selection.substring(0, Math.min(selection.length(), MAX_SELECTION_CHARS))
                );
                LogicalPosition start = editor.offsetToLogicalPosition(
                        editor.getSelectionModel().getSelectionStart()
                );
                LogicalPosition end = editor.offsetToLogicalPosition(
                        editor.getSelectionModel().getSelectionEnd()
                );
                editorContext.addProperty("range", positionText(start) + "-" + positionText(end));
            }
            JsonArray diagnostics = collectDiagnostics(document);
            if (!diagnostics.isEmpty()) {
                editorContext.add("diagnostics", diagnostics);
            }
            context.add("editor", editorContext);
            return context;
        }

        private JsonArray collectDiagnostics(Document document) {
            JsonArray diagnostics = new JsonArray();
            ReadAction.run(() ->
                    DaemonCodeAnalyzerEx.processHighlights(
                            document,
                            project,
                            HighlightSeverity.INFORMATION,
                            0,
                            document.getTextLength(),
                            info -> {
                                if (diagnostics.size() >= MAX_DIAGNOSTICS) {
                                    return false;
                                }
                                String description = info.getDescription();
                                if (description == null || description.isBlank()) {
                                    return true;
                                }
                                JsonObject diagnostic = new JsonObject();
                                diagnostic.addProperty("severity", severityName(info));
                                diagnostic.addProperty(
                                        "message",
                                        description.substring(0, Math.min(description.length(), 2_000))
                                );
                                String source = info.getInspectionToolId();
                                if (source != null && !source.isBlank()) {
                                    diagnostic.addProperty("source", source);
                                }
                                int startOffset = Math.max(0, Math.min(info.getStartOffset(), document.getTextLength()));
                                int endOffset = Math.max(startOffset, Math.min(info.getEndOffset(), document.getTextLength()));
                                diagnostic.addProperty(
                                        "range",
                                        positionText(document, startOffset) + "-" + positionText(document, endOffset)
                                );
                                diagnostics.add(diagnostic);
                                return true;
                            }
                    )
            );
            return diagnostics;
        }

        private String severityName(HighlightInfo info) {
            HighlightSeverity severity = info.getSeverity();
            if (HighlightSeverity.ERROR.equals(severity)) {
                return "error";
            }
            if (HighlightSeverity.WARNING.equals(severity)
                    || HighlightSeverity.WEAK_WARNING.equals(severity)) {
                return "warning";
            }
            if (HighlightSeverity.INFORMATION.equals(severity)) {
                return "information";
            }
            return "hint";
        }

        private String positionText(Document document, int offset) {
            int safe = Math.max(0, Math.min(offset, document.getTextLength()));
            int line = document.getLineNumber(safe);
            return (line + 1) + ":" + (safe - document.getLineStartOffset(line) + 1);
        }

        private String positionText(LogicalPosition position) {
            return (position.line + 1) + ":" + (position.column + 1);
        }

        private void reviewChanges(boolean openVersionControl) {
            client.request("git.diff", params("max_chars", 240_000), Duration.ofSeconds(30))
                    .whenComplete((changes, error) -> {
                        if (error != null) {
                            ui(() -> append("\n无法读取工作区变更：" + error.getMessage() + "\n"));
                            return;
                        }
                        int count = changes.has("files")
                                ? changes.getAsJsonArray("files").size()
                                : 0;
                        String patch = changes.has("patch")
                                ? changes.get("patch").getAsString()
                                : "";
                        ui(() -> {
                            append("\n工作区变更：" + count + " 个文件\n");
                            if (!patch.isBlank()) {
                                append(patch.substring(0, Math.min(patch.length(), 40_000)) + "\n");
                            }
                            if (openVersionControl) {
                                ToolWindow versionControl = ToolWindowManager.getInstance(project)
                                        .getToolWindow("Version Control");
                                if (versionControl != null) {
                                    versionControl.show();
                                }
                            }
                        });
                    });
        }

        private JsonObject params(String name, int value) {
            JsonObject params = new JsonObject();
            params.addProperty(name, value);
            return params;
        }

        private void onBridgeEvent(JsonObject event) {
            if (!event.has("operation_id")
                    || !event.get("operation_id").getAsString().equals(operationId)) {
                return;
            }
            String type = event.get("type").getAsString();
            JsonObject data = event.has("data")
                    ? event.getAsJsonObject("data")
                    : new JsonObject();
            if ("answer.delta".equals(type) && data.has("content")) {
                ui(() -> append(data.get("content").getAsString()));
            } else if ("reasoning.started".equals(type)) {
                ui(() -> status.setText("完整推理中…"));
            } else if ("answer.reset".equals(type)) {
                ui(() -> append("\n[回答已根据验证结果更新]\n"));
            } else if ("operation.completed".equals(type)) {
                operationId = "";
                ui(() -> status.setText("已连接"));
                reviewChanges(false);
            } else if ("operation.failed".equals(type) || "operation.cancelled".equals(type)) {
                operationId = "";
                ui(() -> {
                    status.setText("失败");
                    append(data + "\n");
                });
            }
        }

        private void append(String text) {
            transcript.append(text == null ? "" : text);
            transcript.setCaretPosition(transcript.getDocument().getLength());
        }

        private void ui(Runnable action) {
            ApplicationManager.getApplication().invokeLater(action);
        }
    }
}
