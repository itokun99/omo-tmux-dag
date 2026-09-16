import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeArgs, createTmux, isMissingPaneError, isTtyEnv, listArgs, parsePanes, renameArgs, shellCommand, splitArgs, windowArgs } from '../src/tmux.mjs';

async function stubTmux(t, script) {
  const dir = await mkdtemp(join(tmpdir(), 'omo-tmux-dag-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'tmux');
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  return createTmux({ ...process.env, TMUX_BIN_PATH: binary });
}

test('windowOf rejects a pane tmux can no longer resolve', async t => {
  // tmux exits 0 with empty output for `display-message -t <dead pane>`, so the
  // adapter must treat empty output as a missing pane or stale records resurrect.
  const tmux = await stubTmux(t, '#!/usr/bin/env bash\nprintf "\\n"\n');
  await assert.rejects(() => tmux.windowOf('%9'), error => isMissingPaneError(error));
});

test('windowOf reports a live pane window id', async t => {
  const tmux = await stubTmux(t, '#!/usr/bin/env bash\nprintf "@3\\n"\n');
  assert.equal(await tmux.windowOf('%9'), '@3');
});

test('splitArgs builds a detached 35% split that reports the new pane id', () => {
  assert.deepEqual(splitArgs({ parentPane: '%0', cwd: '/tmp/x', command: 'node viewer.mjs' }),
    ['split-window', '-h', '-d', '-l', '35%', '-t', '%0', '-c', '/tmp/x', '-P', '-F', '#{pane_id}', 'node viewer.mjs']);
});

test('splitArgs omits the trailing command when none is supplied', () => {
  assert.deepEqual(splitArgs({ parentPane: '%3', cwd: '/tmp/x' }),
    ['split-window', '-h', '-d', '-l', '35%', '-t', '%3', '-c', '/tmp/x', '-P', '-F', '#{pane_id}']);
});

test('windowArgs, listArgs, renameArgs, closeArgs target a pane id', () => {
  assert.deepEqual(windowArgs('%3'), ['display-message', '-p', '-t', '%3', '#{window_id}']);
  assert.deepEqual(listArgs('@1'), ['list-panes', '-t', '@1', '-F', '#{pane_id}\t#{pane_title}\t#{window_id}\t#{pane_active}']);
  assert.deepEqual(renameArgs('%4', 'DAG · abcdef12'), ['select-pane', '-t', '%4', '-T', 'DAG · abcdef12']);
  assert.deepEqual(closeArgs('%4'), ['kill-pane', '-t', '%4']);
});

test('parsePanes reads tab-separated list-panes output and ignores noise', () => {
  const stdout = '%0\tOmO\t@1\t1\n%4\tDAG · abcdef12\t@1\t0\n\n';
  assert.deepEqual(parsePanes(stdout), [
    { pane_id: '%0', title: 'OmO', windowId: '@1', active: true },
    { pane_id: '%4', title: 'DAG · abcdef12', windowId: '@1', active: false },
  ]);
  assert.deepEqual(parsePanes(''), []);
});

test('isMissingPaneError separates a gone pane from real tmux failures', () => {
  assert.equal(isMissingPaneError(new Error("can't find pane: %9")), true);
  assert.equal(isMissingPaneError(Object.assign(new Error('Command failed'), { stderr: "can't find pane: %9" })), true);
  assert.equal(isMissingPaneError(new Error('no server running on /tmp/x')), false);
  assert.equal(isMissingPaneError(new Error('create window failed')), false);
});

test('shellCommand quotes pane commands so tmux re-parses them intact', () => {
  assert.equal(shellCommand(['node', '/x with space/v.mjs', '--state', '/tmp/o.json']),
    "'node' '/x with space/v.mjs' '--state' '/tmp/o.json'");
  assert.equal(shellCommand(['a', "b'c"]), "'a' 'b'\\''c'");
});

test('isTtyEnv requires both TMUX and TMUX_PANE', () => {
  assert.equal(isTtyEnv({ TMUX: '/tmp/sock,1,0', TMUX_PANE: '%0' }), true);
  assert.equal(isTtyEnv({ TMUX: '/tmp/sock,1,0' }), false);
  assert.equal(isTtyEnv({ TMUX_PANE: '%0' }), false);
  assert.equal(isTtyEnv({}), false);
});
