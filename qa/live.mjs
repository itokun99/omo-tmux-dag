// Real-surface QA: drives the extension against a real tmux server in a
// throwaway session and records captures under qa/artifacts/<timestamp>/.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpoint, payload } from '../test/fixtures.mjs';
import { viewKey } from '../src/controller.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = 'qa-tmux-dag-session';
const session = 'omo-tmux-dag-qa';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = join(root, 'qa', 'artifacts', stamp);
const scratch = join(artifacts, 'tmp');
const stateDir = join(scratch, 'state');
const taskStateDir = join(scratch, 'task-state');
const results = [];
let hostPane;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function tmux(args) {
  const { stdout } = await execute('tmux', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function paneList() {
  const stdout = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}\t#{pane_title}\t#{pane_active}\t#{pane_width}x#{pane_height}']);
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pane_id, title, active] = line.split('\t');
    return { pane_id, title, active: active === '1', raw: line };
  });
}

async function capture(paneId, file) {
  const ansi = await tmux(['capture-pane', '-e', '-p', '-t', paneId]);
  await writeFile(join(artifacts, file), ansi);
  return ansi;
}

async function waitFor(label, predicate, { timeout = 8000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastRaw = '';
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last && last.ok !== false && last !== false) return last;
      if (last === false) lastRaw = await paneList().then(panes => panes.map(pane => pane.raw).join(' | ')).catch(() => 'unavailable');
    } catch (error) {
      last = { error: error.message };
      lastRaw = `threw: ${error.message}`;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`timed out waiting for ${label} (last panes: ${lastRaw}; last: ${JSON.stringify(last)})`);
}

function drive(extra = {}, wait = 900) {
  const env = {
    ...process.env,
    PATH: process.env.PATH,
    OMO_TMUX_DAG_STATE_DIR: stateDir,
    OMO_TMUX_DAG_TASK_STATE_DIR: taskStateDir,
    DRIVER_SESSION: sessionId,
    DRIVER_CWD: root,
    DRIVER_MODE: 'session',
    DRIVER_WAIT: String(wait),
    TMUX: process.env.TMUX,
    TMUX_PANE: hostPane,
    ...extra,
  };
  return execute(process.execPath, [join(root, 'test/fixtures/extension-driver.mjs')], { env, maxBuffer: 8 * 1024 * 1024 })
    .then(({ stdout, stderr }) => {
      const line = stdout.trim().split('\n').at(-1);
      const result = JSON.parse(line);
      if (result.notifications?.length) console.log(`  driver notifications: ${JSON.stringify(result.notifications)}`);
      if (stderr.trim()) console.log(`  driver stderr: ${stderr.trim().slice(0, 800)}`);
      return result;
    });
}

async function sendKeys(pane, ...keys) {
  await tmux(['send-keys', '-t', pane, ...keys]);
}

async function main() {
  await mkdir(join(taskStateDir, 'dag', 'runs'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(taskStateDir, 'dag', 'runs', 'dag_qa_checkpoint.json'), JSON.stringify(checkpoint({
    runId: 'dag_qa_checkpoint', parentSessionId: sessionId, rootSessionId: sessionId, status: 'running',
    nodes: [{ id: 'build', state: 'completed', attempt: 1, taskId: 'st_qa1' },
      { id: 'test', state: 'running', attempt: 1, taskId: 'st_qa2' },
      { id: 'ship', state: 'pending', attempt: 0 }],
    edges: [{ from: 'build', to: 'test' }, { from: 'test', to: 'ship' }],
  })));

  await tmux(['kill-session', '-t', session]).catch(() => {});
  await tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '50']);
  const initial = await paneList();
  hostPane = initial[0].pane_id;
  check('scratch tmux session starts with one host pane', initial.length === 1, hostPane);

  const first = await drive({ DRIVER_EVENT: JSON.stringify({ name: 'omo.dag.updated', data: { ...payload(), parent_session_id: sessionId } }) });
  check('extension registered the dag-pane command under tmux', first.commands.includes('dag-pane'), first.commands.join(','));

  const opened = await waitFor('a second pane titled DAG · <session>', async () => {
    const panes = await paneList();
    const viewer = panes.find(pane => pane.title.startsWith('DAG · '));
    return viewer ? { ok: true, panes, viewer } : false;
  });
  await writeFile(join(artifacts, 'panes-open.json'), JSON.stringify(opened.panes, null, 2) + '\n');
  check('a DAG pane opened automatically', Boolean(opened.viewer), opened.viewer?.raw ?? '');
  check('DAG pane title carries the session prefix', opened.viewer.title === `DAG · ${sessionId.slice(0, 8)}`, opened.viewer.title);
  check('focus stays in the conversation pane', opened.panes.find(pane => pane.pane_id === hostPane)?.active === true, opened.panes.map(pane => pane.raw).join(' | '));
  check('DAG pane takes about 35% of the 200-column window', /x50$/.test(opened.viewer.raw) && opened.viewer.raw.includes('70x50'), opened.viewer.raw);

  const viewerPane = opened.viewer.pane_id;
  const stateFile = join(stateDir, `${viewKey(process.env.TMUX, hostPane, sessionId)}.json`);
  const frame = await waitFor('viewer to render node labels', async () => {
    const ansi = await capture(viewerPane, 'viewer-open.ansi');
    return ansi.includes('build') && ansi.includes('ship') ? { ok: true, ansi } : false;
  });
  check('viewer renders the restored checkpoint graph', frame.ok, `${frame.ansi.length} bytes captured`);

  await drive({ DRIVER_EVENT: JSON.stringify({ name: 'omo.dag.updated', data: { ...payload(), parent_session_id: sessionId } }) });
  const afterSecond = await paneList();
  check('a second snapshot reuses the pane instead of splitting again', afterSecond.length === 2, afterSecond.map(pane => pane.raw).join(' | '));

  await sendKeys(viewerPane, 't');
  const tasks = await waitFor('tasks view', async () => {
    const ansi = await capture(viewerPane, 'viewer-tasks.ansi');
    return ansi.includes('Tasks') || ansi.includes('Task') ? { ok: true, ansi } : false;
  });
  check('t switches the viewer to the tasks view', tasks.ok);
  await sendKeys(viewerPane, 't');
  await sendKeys(viewerPane, 'Tab');
  await sendKeys(viewerPane, 'Space');
  const folded = await waitFor('fold preference to be persisted', async () => {
    try {
      const parsed = JSON.parse(await readFile(`${stateFile}.view.json`, 'utf8'));
      const entries = Object.entries(parsed.expanded ?? {});
      return entries.length ? { ok: true, entries } : false;
    } catch { return false; }
  });
  await capture(viewerPane, 'viewer-selected.ansi');
  check('Tab/Space fold a node and persist the view preference', folded.ok, JSON.stringify(folded.entries));

  await sendKeys(viewerPane, 'q');
  const closed = await waitFor('viewer pane to close on q', async () => {
    const panes = await paneList();
    return panes.length === 1 ? { ok: true, panes } : false;
  });
  await writeFile(join(artifacts, 'panes-after-q.json'), JSON.stringify(closed.panes, null, 2) + '\n');
  check('q closes the viewer and its pane', closed.panes.length === 1, closed.panes.map(pane => pane.raw).join(' | '));

  await drive({ DRIVER_EVENT: JSON.stringify({ name: 'omo.dag.updated', data: { ...payload(), parent_session_id: sessionId } }) });
  const afterManualClose = await paneList();
  await writeFile(join(artifacts, 'panes-manual-close.json'), JSON.stringify(afterManualClose, null, 2) + '\n');
  check('a later snapshot does not reopen a pane the user closed', afterManualClose.length === 1, afterManualClose.map(pane => pane.raw).join(' | '));

  await drive({ DRIVER_COMMAND: 'dag-pane', DRIVER_SHUTDOWN: '1' });
  const reopened = await waitFor('/dag-pane to reopen the pane', async () => {
    const panes = await paneList();
    const viewer = panes.find(pane => pane.title.startsWith('DAG · '));
    return viewer && panes.length === 2 ? { ok: true, panes, viewer } : false;
  });
  await waitFor('reopened viewer to draw', async () => {
    const ansi = await capture(reopened.viewer.pane_id, 'viewer-reopen.ansi');
    return ansi.includes('DAG') || ansi.includes('build') ? { ok: true, ansi } : false;
  });
  check('/dag-pane reopens the pane', true, reopened.viewer.raw);

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(join(artifacts, 'viewer-state.json'), JSON.stringify(state, null, 2) + '\n');
  check('viewer state names the session and marks the extension disconnected after shutdown',
    state.sessionId === sessionId && state.connected === false && state.runs.length >= 2,
    `runs=${state.runs.length} connected=${state.connected}`);
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  check('qa run completed without throwing', false, error.message);
} finally {
  const panesBefore = await paneList().catch(() => []);
  for (const pane of panesBefore) if (pane.pane_id !== hostPane) await tmux(['kill-pane', '-t', pane.pane_id]).catch(() => {});
  await tmux(['kill-session', '-t', session]).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  const leftovers = await paneList().catch(() => []);
  const receipt = `session ${session} killed; ${panesBefore.length - 1} viewer pane(s) killed; scratch ${scratch} removed; leftover panes: ${leftovers.length}`;
  await writeFile(join(artifacts, 'cleanup.txt'), receipt + '\n');
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    sessionId, session, artifacts, results,
    passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length,
    cleanup: receipt,
  }, null, 2) + '\n');
  console.log(`\n${receipt}\nartifacts: ${artifacts}`);
}

const failed = results.filter(result => !result.ok);
if (failure || failed.length) {
  console.error(`\n${failed.length} check(s) failed${failure ? ` and the run threw: ${failure.message}` : ''}`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${results.length} checks passed`);
}
