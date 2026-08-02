package dev.arforge.acceptance

import kotlin.test.Test
import kotlin.test.assertEquals

class RepositoryIntegrationTest {
    @Test
    fun preservesInsertionOrderAcrossOperations() {
        val repository = WorkRepository()
        repository.create("first")
        repository.create("second")
        assertEquals(listOf("first", "second"), repository.list().map { it.title })
    }
}
