package dev.arforge.acceptance

data class WorkItem(val id: Long, val title: String, val status: String = "open")

class WorkRepository {
    private val items = mutableListOf<WorkItem>()

    fun create(title: String): WorkItem {
        val normalized = title.trim()
        require(normalized.isNotEmpty()) { "title is required" }
        val item = WorkItem(items.size.toLong() + 1, normalized)
        items += item
        return item
    }

    fun list(): List<WorkItem> = items.toList()
}
