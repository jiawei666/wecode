import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundArguments } from '../src/daemon.js';

test('removes lifecycle commands before starting the background bridge', () => {
  assert.deepEqual(
    backgroundArguments(['/usr/bin/node', '/workspace/wecode/src/index.ts', 'restart', '--background', '--trace-warnings']),
    ['/workspace/wecode/src/index.ts', '--trace-warnings', '--background'],
  );
});
