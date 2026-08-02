describe("negative paths", () => {
  it("serves the Angular app but rejects an unknown resource", () => {
    cy.visit("/");
    cy.contains("Blank titles are rejected");
    cy.request({url: "/missing-resource", failOnStatusCode: false})
      .its("status")
      .should("eq", 404);
  });
});
