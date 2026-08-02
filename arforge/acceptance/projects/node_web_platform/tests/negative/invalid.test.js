const request = require("supertest");
const {createService} = require("../../src/service");

test("invalid payload is rejected without mutating state", async () => {
  const service = createService();
  await request(service).post("/items").send({title: "   "}).expect(422);
  await request(service).get("/items").expect(200, []);
});
