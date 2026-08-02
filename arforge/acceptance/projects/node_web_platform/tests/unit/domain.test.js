const {createService} = require("../../src/service");

test("service has an isolated in-memory store", () => {
  expect(createService()).not.toBe(createService());
});
