import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DagPane, dagTitle, isDagViewerPane, viewKey } from '../src/controller.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { checkpoint, payload, sessionId } from './fixtures.mjs';
import { normalizeRun } from '../src/model.mjs';

function fakeTmux() {
  const calls = [];
  const panes = new Map([['%0', 'OmO']]);
  let counter = 0;
  return {
    calls, panes,
    async windowOf(pane) {
      calls.push(['windowOf', pane]);
      if (!panes.has(pane)) throw Object.assign(new Error(`can't find pane: ${pane}`), { stderr: `can't find pane: ${pane}` });
      return '@1';
    },
    async split({ parentPane, cwd, command }) {
      calls.push(['split', parentPane, cwd, command]);
      const pane_id = `%${10 + (++counter)}`;
      panes.set(pane_id, 'fresh');
      return pane_id;
    },
    async rename(pane, title) { calls.push(['rename', pane, title]); panes.set(pane, title); },
    async list() {
      calls.push(['list']);
      return [...panes].map(([pane_id, title]) => ({ pane_id, title, windowId: '@1', active: false }));
    },
    async close(pane) {
      calls.push(['close', pane]);
      if (!panes.delete(pane)) throw Object.assign(new Error(`can't find pane: ${pane}`), { stderr: `can't find pane: ${pane}` });
    },
  };
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omo-tmux-dag-controller-'));
  const stateDir = join(root, 'state');
  const cwd = join(root, 'project');
  const taskStateDir = join(cwd, '.omo', 'senpi-task');
  const tmux = fakeTmux();
  const notifications = [];
  const controller = new DagPane({
    sessionId, parentPane: '%0', socket: '/tmp/fake.sock,1,0', stateDir, cwd,
    node: '/usr/bin/node', viewer: join(root, 'src/viewer.mjs'), tmux,
    taskStateDir, notify: message => notifications.push(message), ...options,
  });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, cwd, taskStateDir, tmux, controller, notifications };
}

async function seedCheckpoint({ taskStateDir }, record = checkpoint()) {
  const directory = join(taskStateDir, 'dag', 'runs');
  await writeJson(join(directory, `${record.runId}.json`), record);
  return record;
}

test('start restores the session checkpoint and opens exactly one detached pane', async t => {
  const setupState = await setup(t);
  const record = await seedCheckpoint(setupState);
  await setupState.controller.start();
  const state = await readJson(setupState.controller.stateFile);
  assert.deepEqual(state.runs, [normalizeRun(record)]);
  const splits = setupState.tmux.calls.filter(call => call[0] === 'split');
  assert.equal(splits.length, 1);
  assert.equal(splits[0][1], '%0');
  assert.match(splits[0][3], /viewer\.mjs.*--state/);
  const renames = setupState.tmux.calls.filter(call => call[0] === 'rename');
  assert.equal(renames.length, 1);
  assert.equal(renames[0][2], dagTitle(sessionId));
  assert.ok(setupState.tmux.panes.has(renames[0][1]), 'the renamed pane must be the pane the adapter created');
});

test('a later RPC snapshot reuses the recorded pane instead of splitting again', async t => {
  const setupState = await setup(t);
  await seedCheckpoint(setupState);
  await setupState.controller.start();
  await setupState.controller.receive(payload());
  assert.equal(setupState.tmux.calls.filter(call => call[0] === 'split').length, 1);
  const state = await readJson(setupState.controller.stateFile);
  assert.deepEqual(new Set(state.runs.map(run => run.id)), new Set(['dag_restored', 'dag_demo']));
});

test('a manually closed pane stays closed until /dag-pane forces a reopen', async t => {
  const setupState = await setup(t);
  await seedCheckpoint(setupState);
  await setupState.controller.start();
  const [paneId] = [...setupState.tmux.panes.keys()].filter(pane => pane !== '%0');
  setupState.tmux.panes.delete(paneId);
  await setupState.controller.receive(payload());
  assert.equal(setupState.tmux.calls.filter(call => call[0] === 'split').length, 1);
  await setupState.controller.open();
  assert.equal(setupState.tmux.calls.filter(call => call[0] === 'split').length, 2);
});

test('a stale pane record is replaced when the recorded pane is gone', async t => {
  const setupState = await setup(t);
  await seedCheckpoint(setupState);
  await setupState.controller.start();
  for (const pane of [...setupState.tmux.panes.keys()]) if (pane !== '%0') setupState.tmux.panes.delete(pane);
  await setupState.controller.open();
  const splits = setupState.tmux.calls.filter(call => call[0] === 'split');
  assert.equal(splits.length, 2);
  const state = await readJson(setupState.controller.stateFile);
  assert.equal(state.connected, true);
});

test('view keys stay stable per socket, pane, and session and differ across panes', () => {
  const key = viewKey('/tmp/fake.sock,1,0', '%0', sessionId);
  assert.equal(key, viewKey('/tmp/fake.sock,1,0', '%0', sessionId));
  assert.equal(key.length, 24);
  assert.notEqual(key, viewKey('/tmp/fake.sock,1,0', '%1', sessionId));
  assert.notEqual(key, viewKey('/tmp/fake.sock,1,0', '%0', 'other-session'));
});

test('isDagViewerPane recognizes panes this extension owns', () => {
  assert.equal(isDagViewerPane({ title: dagTitle(sessionId) }), true);
  assert.equal(isDagViewerPane({ title: 'OmO DAG' }), true);
  assert.equal(isDagViewerPane({ title: 'OmO' }), false);
  assert.equal(isDagViewerPane({ title: 'my editor' }), false);
  assert.equal(isDagViewerPane({}), false);
});

test('malformed checkpoint records are reported without hiding valid runs', async t => {
  const setupState = await setup(t);
  const record = await seedCheckpoint(setupState);
  const directory = join(setupState.taskStateDir, 'dag', 'runs');
  await writeFile(join(directory, 'broken.json'), '{');
  await writeJson(join(directory, 'foreign.json'), { ...checkpoint({ runId: 'dag_foreign' }), parentSessionId: 'other' });
  await setupState.controller.start();
  const state = await readJson(setupState.controller.stateFile);
  assert.deepEqual(state.runs, [normalizeRun(record)]);
  assert.equal(setupState.notifications.length, 1);
  assert.match(setupState.notifications[0], /broken\.json/);
});
