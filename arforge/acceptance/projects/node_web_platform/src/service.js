const express = require("express");

function createService() {
  const app = express();
  const items = [];
  app.use(express.json());
  app.get("/health", (_request, response) => response.json({status: "ok"}));
  app.get("/items", (_request, response) => response.json(items));
  app.post("/items", (request, response) => {
    const title = String(request.body?.title || "").trim();
    if (!title) {
      return response.status(422).json({error: "title is required"});
    }
    const item = {id: items.length + 1, title, status: "open"};
    items.push(item);
    return response.status(201).json(item);
  });
  return app;
}

module.exports = {createService};
