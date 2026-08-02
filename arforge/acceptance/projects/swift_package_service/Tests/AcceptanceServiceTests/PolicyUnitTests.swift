import AcceptanceService
import Testing

struct PolicyUnitTests {
    @Test
    func normalizesTitle() throws {
        let item = try Repository().create("  project depth  ")
        #expect(item.title == "project depth")
        #expect(item.status == "open")
    }
}
