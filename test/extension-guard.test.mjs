// Behavioural proof that the extension activates under tmux and drives the
// tmux binary through a process boundary. The fake tmux records its argv, so a
// pass means a real `split-window` invocation with the documented flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkpoint, payload, sessionId } from './fixtures.mjs';
import { viewKey } from '../src/controller.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const driver = join(here, 'fixtures/extension-driver.mjs');

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omo-tmux-dag-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'tmux.log');
  await mkdir(bin, { recursive: true });
  const fake = join(bin, 'tmux');
  await writeFile(fake, await readFile(join(here, 'fixtures/fake-tmux.sh'), 'utf8'));
  await chmod(fake, 0o755);
  await writeFile(log, '');
  const taskStateDir = join(dir, 'task-state');
  await mkdir(join(taskStateDir, 'dag', 'runs'), { recursive: true });
  return { dir, bin, log, taskStateDir };
}

function drive(sandboxDir, environment) {
  const env = {
    ...process.env,
    PATH: `${sandboxDir.bin}:${process.env.PATH}`,
    FAKE_TMUX_LOG: sandboxDir.log,
    OMO_TMUX_DAG_STATE_DIR: join(sandboxDir.dir, 'state'),
    OMO_TMUX_DAG_TASK_STATE_DIR: sandboxDir.taskStateDir,
    DRIVER_SESSION: sessionId,
    DRIVER_CWD: sandboxDir.dir,
    DRIVER_WAIT: '700',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  Object.assign(env, environment);
  const result = spawnSync(process.execPath, [driver], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 0, `driver failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function tmuxCalls(sandboxDir) {
  const text = await readFile(sandboxDir.log, 'utf8');
  return text.split('\n').filter(Boolean).map(line => line.split('\x1f').slice(0, -1));
}

test('extension stays inert outside tmux: no handlers, no tmux calls', async t => {
  const sandboxDir = await sandbox(t);
  const result = drive(sandboxDir, { DRIVER_MODE: 'session' });
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.bus, []);
  assert.deepEqual(await tmuxCalls(sandboxDir), []);
});

test('extension activates under tmux and splits a detached 35% pane for a checkpoint run', async t => {
  const sandboxDir = await sandbox(t);
  await writeFile(join(sandboxDir.taskStateDir, 'dag', 'runs', 'dag_restored.json'), JSON.stringify(checkpoint()));
  const result = drive(sandboxDir, { TMUX: '/tmp/fake.sock,1,0', TMUX_PANE: '%0', DRIVER_MODE: 'session' });
  assert.deepEqual(result.commands, ['dag-pane']);
  assert.deepEqual(result.bus, ['senpi:extension-rpc-event']);

  const calls = await tmuxCalls(sandboxDir);
  const split = calls.find(call => call[0] === 'split-window');
  assert.ok(split, `expected a split-window call, saw ${JSON.stringify(calls)}`);
  assert.deepEqual(split.slice(0, 12), ['split-window', '-h', '-d', '-l', '35%', '-t', '%0', '-c', sandboxDir.dir, '-P', '-F', '#{pane_id}']);
  const command = split[12];
  assert.match(command, /viewer\.mjs/);
  assert.match(command, /--state/);
  const rename = calls.find(call => call[0] === 'select-pane');
  assert.deepEqual(rename, ['select-pane', '-t', '%42', '-T', 'DAG · test-par']);

  const key = viewKey('/tmp/fake.sock,1,0', '%0', sessionId);
  const state = JSON.parse(await readFile(join(sandboxDir.dir, 'state', `${key}.json`), 'utf8'));
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.connected, true);
  assert.deepEqual(state.runs.map(run => run.id), ['dag_restored']);
});

test('an omo.dag.updated snapshot opens the pane and is persisted for the viewer', async t => {
  const sandboxDir = await sandbox(t);
  drive(sandboxDir, {
    TMUX: '/tmp/fake.sock,1,0', TMUX_PANE: '%0', DRIVER_MODE: 'session',
    DRIVER_EVENT: JSON.stringify({ name: 'omo.dag.updated', data: payload() }),
  });
  const calls = await tmuxCalls(sandboxDir);
  assert.ok(calls.some(call => call[0] === 'split-window'), 'the first DAG snapshot must open the pane');
  const key = viewKey('/tmp/fake.sock,1,0', '%0', sessionId);
  const state = JSON.parse(await readFile(join(sandboxDir.dir, 'state', `${key}.json`), 'utf8'));
  assert.deepEqual(state.runs.map(run => run.id), ['dag_demo']);
  assert.deepEqual(state.runs[0].nodes.map(node => node.id), ['analyze', 'server', 'ui', 'integrate', 'verify']);
});
