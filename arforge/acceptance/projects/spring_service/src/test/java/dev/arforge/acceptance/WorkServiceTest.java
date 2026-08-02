package dev.arforge.acceptance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class WorkServiceTest {
    @Test
    void normalizesAndStoresWorkItems() {
        WorkService service = new WorkService();
        WorkItem item = service.create("  project depth  ");
        assertEquals("project depth", item.title());
        assertEquals(1, service.list().size());
    }
}
