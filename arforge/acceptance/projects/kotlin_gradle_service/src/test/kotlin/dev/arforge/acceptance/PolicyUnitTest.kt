package dev.arforge.acceptance

import kotlin.test.Test
import kotlin.test.assertEquals

class PolicyUnitTest {
    @Test
    fun normalizesTitle() {
        val item = WorkRepository().create("  project depth  ")
        assertEquals("project depth", item.title)
        assertEquals("open", item.status)
    }
}
