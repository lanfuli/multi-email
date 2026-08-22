const { startServer } = require("../src/server.mjs");
const { run: runSetup } = require("../src/setup.mjs");

module.exports = { runSetup, startServer };
