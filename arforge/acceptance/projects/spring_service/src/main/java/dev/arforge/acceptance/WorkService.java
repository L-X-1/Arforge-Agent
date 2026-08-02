package dev.arforge.acceptance;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Service;

@Service
public class WorkService {
    private final AtomicLong ids = new AtomicLong();
    private final List<WorkItem> items = new ArrayList<>();

    public synchronized WorkItem create(String title) {
        String normalized = title == null ? "" : title.trim();
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException("title is required");
        }
        WorkItem item = new WorkItem(ids.incrementAndGet(), normalized, "open");
        items.add(item);
        return item;
    }

    public synchronized List<WorkItem> list() {
        return List.copyOf(items);
    }
}
