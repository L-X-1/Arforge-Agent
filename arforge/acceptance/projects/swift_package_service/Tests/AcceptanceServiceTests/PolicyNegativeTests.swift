import AcceptanceService
import Testing

struct PolicyNegativeTests {
    @Test
    func rejectsBlankTitleWithoutMutation() {
        let repository = Repository()
        #expect(throws: PolicyError.self) {
            try repository.create("   ")
        }
        #expect(repository.list().isEmpty)
    }
}
