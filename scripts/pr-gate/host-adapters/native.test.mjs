import assert from 'node:assert/strict';
import test from 'node:test';
import { narrowedSeccomp, verifyNativeIsolation } from './native.mjs';

test('native mount seccomp narrowing preserves other rules and never opens a denied syscall', () => {
  const original = { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [
    { names: ['mount', 'clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 1, op: 'SCMP_CMP_EQ' }] },
    { names: ['unrelated'], action: 'SCMP_ACT_ALLOW' }, { names: ['mount'], action: 'SCMP_ACT_ERRNO' },
  ] };
  const before = structuredClone(original), result = narrowedSeccomp(original);
  assert.deepEqual(original, before); assert.equal(result.defaultAction, original.defaultAction);
  assert.deepEqual(result.syscalls[0], { ...original.syscalls[0], names: ['clone'] });
  assert.deepEqual(result.syscalls[1], { ...original.syscalls[0], names: ['mount'], args: [...original.syscalls[0].args, { index: 3, value: 14, op: 'SCMP_CMP_NE' }] });
  assert.deepEqual(result.syscalls.slice(2), original.syscalls.slice(1));
});

test('native capability refuses root, networking, writable app, daemon mounts and missing isolation', () => {
  const runtime = { imageId: 'sha256:' + 'a'.repeat(64), volume: 'bb-pr-gate-native-synthetic' };
  const value = { Id: 'b'.repeat(64), Image: runtime.imageId, Config: { User: '1000:1000' }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
    CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges', 'seccomp=synthetic'], NanoCpus: 1e9, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, PidsLimit: 256, PortBindings: {} },
    Mounts: [{ Destination: '/app', Type: 'volume', Name: runtime.volume, RW: false }, { Destination: '/evidence', Type: 'bind', RW: true },
      { Destination: '/transfer', Type: 'bind', RW: false }, { Destination: '/run/secrets/bb-copilot-oauth', Type: 'bind', RW: false }] };
  assert.doesNotThrow(() => verifyNativeIsolation(value, runtime, 'native-sandbox'));
  for (const mutation of [v => { v.Config.User = '0:0'; }, v => { v.HostConfig.NetworkMode = 'host'; }, v => { v.HostConfig.Privileged = true; },
    v => { v.HostConfig.ReadonlyRootfs = false; }, v => { v.HostConfig.SecurityOpt = []; }, v => { v.HostConfig.CapAdd.push('SYS_ADMIN'); },
    v => { v.Mounts[0].RW = true; }, v => { v.Mounts.push({ Destination: '/var/run/docker.sock', Type: 'bind', RW: true }); },
    v => { v.HostConfig.PortBindings = { '5432/tcp': [{ HostPort: '5432' }] }; }, v => { v.Image = 'sha256:' + 'c'.repeat(64); }]) {
    const changed = structuredClone(value); mutation(changed); assert.throws(() => verifyNativeIsolation(changed, runtime, 'native-sandbox'));
  }
});
