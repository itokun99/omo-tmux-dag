// Shared fixtures for the omo-tmux-dag test suite.
export const sessionId = 'test-parent-session';

// Exact field names emitted by OmO's RPC snapshot projection (snake_case).
export function payload() {
  return { parent_session_id: sessionId, runs: [{ run_id: 'dag_demo', name: 'Integration check · example DAG', status: 'running',
    created_at: '2026-09-05T07:00:00Z', updated_at: '2026-09-05T07:00:01Z',
    nodes: [
      { id: 'analyze', label: 'Analyze', state: 'completed', depends_on: [], attempt: 1 },
      { id: 'server', label: 'Server', state: 'running', depends_on: ['analyze'], attempt: 1 },
      { id: 'ui', label: 'UI', state: 'running', depends_on: ['analyze'], attempt: 1 },
      { id: 'integrate', label: 'Integrate', state: 'pending', depends_on: ['server', 'ui'], attempt: 0 },
      { id: 'verify', label: 'Verify', state: 'pending', depends_on: ['integrate'], attempt: 0 },
    ], edges: [{ from: 'analyze', to: 'server' }, { from: 'analyze', to: 'ui' },
      { from: 'server', to: 'integrate' }, { from: 'ui', to: 'integrate' }, { from: 'integrate', to: 'verify' }] }] };
}

// CamelCase checkpoint fields and array nodes match the persisted OmO run record.
export function checkpoint(overrides = {}) {
  return { schemaVersion: 1, checkpointSeq: 30, runId: 'dag_restored', parentSessionId: sessionId,
    rootSessionId: sessionId, status: 'completed', createdAt: '2026-09-06T01:28:18.600Z',
    updatedAt: '2026-09-06T01:55:44.466Z',
    nodes: Array.from({ length: 4 }, (_, i) => ({ id: `node-${i}`, state: 'completed', attempt: 1, taskId: `st_saved${i}` })),
    edges: [{ from: 'node-0', to: 'node-3' }, { from: 'node-1', to: 'node-3' }, { from: 'node-2', to: 'node-3' }],
    ...overrides };
}
