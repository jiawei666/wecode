import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { inspectCodexRuntime } from '../src/codex-runtime.js';

test('fingerprints the configured Codex executable and reads its version', async () => {
  const runtime = await inspectCodexRuntime(process.execPath);
  assert.equal(runtime.resolvedCommand, process.execPath);
  assert.match(runtime.version, /node|v\d+/i);
  assert.match(runtime.fingerprint, new RegExp(runtime.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
