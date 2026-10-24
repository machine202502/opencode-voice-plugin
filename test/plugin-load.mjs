// Imports the real plugin entrypoints without starting the HTTP server.
import tui from "../tui.js";
import server from "../index.js";

if (tui?.id !== "opencode.voice.tui") throw new Error("tui: unexpected id");
if (typeof tui.tui !== "function") throw new Error("tui: missing V1 createTui()");
if (typeof tui.setup !== "function") throw new Error("tui: missing V2 setup()");
if (server?.id !== "opencode.voice") throw new Error("server: unexpected id");
if (typeof server.setup !== "function") throw new Error("server: missing setup()");
if (typeof server.server !== "function") throw new Error("server: missing V1 server()");

console.log("plugin entrypoints: OK");
