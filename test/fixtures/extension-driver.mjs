// Drives extension.mjs with a fake `pi` outside a real OmO host, so the
// extension's guard, event wiring, and tmux side effects can be asserted at a
// process boundary. Environment contract:
//   DRIVER_MODE=session|none   run the session_start handler or nothing
//   DRIVER_SESSION             session id handed to the handler
//   DRIVER_EVENT               JSON event delivered on senpi:extension-rpc-event
//   DRIVER_COMMAND             command name to invoke after wiring (e.g. dag-pane)
//   DRIVER_WAIT                milliseconds to let queued controller jobs settle
import extension from '../../extension.mjs';

const handlers = new Map();
const commands = new Map();
const busHandlers = new Map();
const notifications = [];

const pi = {
  cwd: process.env.DRIVER_CWD ?? process.cwd(),
  on: (name, handler) => { handlers.set(name, handler); },
  registerCommand: (name, options) => { commands.set(name, options); },
  events: { on: (name, handler) => { busHandlers.set(name, handler); } },
};

extension(pi);

const ctx = {
  sessionManager: {
    getSessionId: () => process.env.DRIVER_SESSION ?? '',
    getSessionFile: () => process.env.DRIVER_SESSION_FILE ?? '',
  },
  ui: {
    notify: (message, level) => { notifications.push({ message, level }); },
  },
};

if (process.env.DRIVER_MODE === 'session' && handlers.has('session_start')) {
  await handlers.get('session_start')({}, ctx);
}
if (process.env.DRIVER_EVENT) {
  const handler = busHandlers.get('senpi:extension-rpc-event');
  if (handler) handler(JSON.parse(process.env.DRIVER_EVENT));
}
if (process.env.DRIVER_COMMAND) {
  const command = commands.get(process.env.DRIVER_COMMAND);
  await command?.handler('', ctx);
}
await new Promise(resolve => setTimeout(resolve, Number(process.env.DRIVER_WAIT ?? 500)));
if (process.env.DRIVER_SHUTDOWN === '1' && handlers.has('session_shutdown')) {
  await handlers.get('session_shutdown')({}, ctx);
}

console.log(JSON.stringify({
  handlers: [...handlers.keys()],
  commands: [...commands.keys()],
  bus: [...busHandlers.keys()],
  notifications,
}));
