// Loads the V2 TUI plugin with a mock context and checks that the keymap layer
// and every slash command are registered without touching a real microphone.
import { createTuiV2 } from "../lib/tui-v2.js";

const events = [];

const context = {
  location: { directory: process.cwd() },
  ui: {
    toast: {
      show: (props) => events.push(["toast", props.message, props.variant]),
    },
    dialog: {
      alert: async () => undefined,
      select: async () => undefined,
      prompt: async () => undefined,
    },
    router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
  },
  client: {
    session: {
      prompt: async (props) => events.push(["prompt", props.sessionID, props.text]),
    },
  },
  keymap: {
    layer: (factory) => {
      const layer = factory();
      events.push(["layer", layer.mode, layer.priority, layer.commands.length, layer.bindings]);
      for (const command of layer.commands) {
        events.push([
          "command",
          command.id,
          command.bind,
          command.slash?.name,
          command.palette,
          typeof command.run,
        ]);
      }
      return () => events.push(["layer.dispose"]);
    },
  },
};

const dispose = createTuiV2(context);
if (typeof dispose !== "function") throw new Error("setup must return a dispose function");
dispose();

console.log(JSON.stringify(events, null, 2));
const commands = events.filter(([kind]) => kind === "command");
if (commands.length < 7) throw new Error(`expected 7 commands, got ${commands.length}`);
if (commands.some(([, , , , , run]) => run !== "function")) throw new Error("a command has no run()");
console.log("tui-v2: OK");
