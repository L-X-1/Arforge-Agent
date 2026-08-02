const request = require("supertest");
const {createService} = require("../../src/service");
const {renderReactStatus, renderVueStatus} = require("../../src/ui");

test("Express API and React/Vue server renderers work together", async () => {
  const service = createService();
  await request(service).get("/health").expect(200, {status: "ok"});
  const created = await request(service)
    .post("/items")
    .send({title: "project depth"})
    .expect(201);
  expect(created.body.status).toBe("open");
  expect(renderReactStatus(created.body.status)).toContain("React:open");
  await expect(renderVueStatus(created.body.status)).resolves.toContain("Vue:open");
});
