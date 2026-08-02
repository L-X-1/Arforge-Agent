import Foundation

public struct WorkItem: Equatable {
    public let id: Int
    public let title: String
    public let status: String
}

public enum PolicyError: Error {
    case blankTitle
}

public final class Repository {
    private var items: [WorkItem] = []

    public init() {}

    public func create(_ title: String) throws -> WorkItem {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            throw PolicyError.blankTitle
        }
        let item = WorkItem(id: items.count + 1, title: normalized, status: "open")
        items.append(item)
        return item
    }

    public func list() -> [WorkItem] {
        items
    }
}
