const {defineConfig} = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: "http://127.0.0.1:4173",
    supportFile: false,
    specPattern: "tests/cypress/**/*.cy.js",
  },
  video: false,
});
