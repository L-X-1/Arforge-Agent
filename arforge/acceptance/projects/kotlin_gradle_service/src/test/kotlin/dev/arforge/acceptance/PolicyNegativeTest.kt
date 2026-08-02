package dev.arforge.acceptance

import kotlin.test.Test
import kotlin.test.assertFailsWith

class PolicyNegativeTest {
    @Test
    fun rejectsBlankTitleWithoutMutation() {
        val repository = WorkRepository()
        assertFailsWith<IllegalArgumentException> { repository.create("   ") }
        kotlin.test.assertTrue(repository.list().isEmpty())
    }
}
