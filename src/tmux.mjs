import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const PANE_LIST_FORMAT = ['#{pane_id}', '#{pane_title}', '#{window_id}', '#{pane_active}'].join('\t');

export const PANE_SIZE = '35%';

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function shellCommand(args, platform = process.platform) {
  if (platform === 'win32') return `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`;
  return args.map(quote).join(' ');
}

export function isTtyEnv(env = process.env) {
  return Boolean(env.TMUX && env.TMUX_PANE);
}

export function splitArgs({ parentPane, cwd, command, size = PANE_SIZE }) {
  const args = ['split-window', '-h', '-d', '-l', size, '-t', parentPane];
  if (cwd) args.push('-c', cwd);
  args.push('-P', '-F', '#{pane_id}');
  if (command) args.push(command);
  return args;
}

export function windowArgs(pane) {
  return ['display-message', '-p', '-t', pane, '#{window_id}'];
}

export function listArgs(window) {
  return ['list-panes', ...(window ? ['-t', window] : []), '-F', PANE_LIST_FORMAT];
}

export function renameArgs(pane, title) {
  return ['select-pane', '-t', pane, '-T', title];
}

export function closeArgs(pane) {
  return ['kill-pane', '-t', pane];
}

export function parsePanes(stdout) {
  return String(stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [pane_id, title, windowId, active] = line.split('\t');
    return { pane_id, title: title ?? '', windowId: windowId ?? '', active: active === '1' };
  }).filter(pane => pane.pane_id);
}

export function isMissingPaneError(error) {
  return /can't find pane|no such pane|pane not found|invalid pane/i.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
}

function tmuxBin(env) {
  return env.TMUX_BIN_PATH || 'tmux';
}

export function createTmux(env = process.env) {
  const run = async args => {
    const { stdout } = await execute(tmuxBin(env), args, { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  };
  return {
    async split({ parentPane, cwd, command }) {
      const paneId = (await run(splitArgs({ parentPane, cwd, command }))).trim();
      if (!paneId) throw new Error('tmux split-window did not report a pane id');
      return paneId;
    },
    async list(window) {
      return parsePanes(await run(listArgs(window)));
    },
    async windowOf(pane) {
      // tmux exits 0 with empty output for `display-message -t <dead pane>`; an
      // empty window id is the only signal that the pane is gone.
      const window = (await run(windowArgs(pane))).trim();
      if (!window) throw Object.assign(new Error(`can't find pane: ${pane}`), { stderr: `can't find pane: ${pane}` });
      return window;
    },
    async rename(pane, title) {
      await run(renameArgs(pane, title));
    },
    async close(pane) {
      await run(closeArgs(pane));
    },
  };
}

export async function closePane(pane, env = process.env) {
  await execute(tmuxBin(env), closeArgs(pane), { env, timeout: 10000, maxBuffer: 1024 * 1024 });
}
