import AcceptanceService
import Testing

struct RepositoryIntegrationTests {
    @Test
    func preservesInsertionOrder() throws {
        let repository = Repository()
        _ = try repository.create("first")
        _ = try repository.create("second")
        #expect(repository.list().map(\.title) == ["first", "second"])
    }
}
