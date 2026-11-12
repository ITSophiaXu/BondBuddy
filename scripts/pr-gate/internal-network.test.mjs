import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectInternalNetwork, inspectInternalAttachment, verifyInternalRoutes, verifyInternalNetworkEvidence, cleanupInternalNetwork, createInternalNetwork } from './internal-network.mjs';
import { syntheticInternalNetwork } from './internal-network.test-fixture.mjs';

test('owned internal network rejects external connectivity, wrong identity and foreign members', () => {
  const { identity, metadata, container } = syntheticInternalNetwork();
  assert.equal(inspectInternalNetwork(metadata, identity, [container.Id]).internal, true);
  for (const mutate of [x => x.Internal = false, x => x.Driver = 'host', x => x.EnableIPv6 = true, x => x.Attachable = true,
    x => x.Ingress = true, x => x.Id = 'b'.repeat(64), x => x.Name += '-old', x => x.Scope = 'swarm', x => x.Labels = {},
    x => x.Options['com.docker.network.bridge.enable_ip_masquerade'] = 'true', x => x.Containers['f'.repeat(64)] = {}]) {
    const changed = structuredClone(metadata); mutate(changed); assert.throws(() => inspectInternalNetwork(changed, identity, [container.Id]));
  }
});

test('core uses only its owned internal interface and no external DNS forwarding', () => {
  const { identity, container } = syntheticInternalNetwork();
  assert.equal(inspectInternalAttachment(container, identity).network_id, identity.id);
  for (const mutate of [x => x.HostConfig.NetworkMode = 'host', x => x.HostConfig.Dns = [], x => x.HostConfig.Dns = ['8.8.8.8'],
    x => x.NetworkSettings.Networks.bridge = {}, x => x.NetworkSettings.Networks[identity.name].NetworkID = 'b'.repeat(64),
    x => x.NetworkSettings.Networks[identity.name].GlobalIPv6Address = '2001:db8::1']) {
    const changed = structuredClone(container); mutate(changed); assert.throws(() => inspectInternalAttachment(changed, identity));
  }
});

test('actual route proof requires one local interface with no IPv4 or IPv6 default/gateway route', () => {
  const { container, identity, probe } = syntheticInternalNetwork(), attachment = inspectInternalAttachment(container, identity);
  assert.equal(verifyInternalRoutes(probe, attachment).no_default_route, true);
  for (const mutate of [x => x.ipv4_routes += 'eth0 00000000 01001DAC 0003 0 0 0 00000000 0 0 0\n',
    x => x.ipv4_routes = x.ipv4_routes.replace('00001DAC 00000000', '00001DAC 01001DAC'),
    x => x.ipv6_routes = x.ipv6_routes.replace(' lo\n', ' eth0\n'), x => x.interfaces.eth1 = [{ family: 'IPv4', internal: false, address: '10.0.0.2' }],
    x => x.interfaces.eth0[0].address = '10.0.0.2', x => x.interfaces.eth0.push({ family: 'IPv6', internal: false, address: '2001:db8::1' })]) {
    const changed = structuredClone(probe); mutate(changed); assert.throws(() => verifyInternalRoutes(changed, attachment));
  }
});

test('passing network evidence binds actual initial/final identity, routes and absence', () => {
  const { evidence, container } = syntheticInternalNetwork(), expected = { runId: evidence.run_id, containerId: container.Id };
  assert.equal(verifyInternalNetworkEvidence(evidence, expected), evidence);
  for (const mutate of [x => delete x.final, x => x.final.container_id = 'f'.repeat(64), x => x.prepared.inspection.internal = false,
    x => x.final.inspection.members.push({ id: 'f'.repeat(64) }), x => x.final.attachment.network_id = 'f'.repeat(64),
    x => x.final.routes.ipv4_routes += 'eth0 00000000 01001DAC 0003 0 0 0 00000000 0 0 0\n',
    x => x.cleanup.status = 'failed', x => x.cleanup.absence_confirmed = false, x => x.cleanup.empty.members.push({ id: 'f'.repeat(64) })]) {
    const changed = structuredClone(evidence); mutate(changed); assert.throws(() => verifyInternalNetworkEvidence(changed, expected));
  }
});

test('cleanup does not remove a network with unexpected membership and confirms removal absence', async () => {
  const { identity, metadata } = syntheticInternalNetwork(), calls = [];
  const foreign = async (label, args) => { calls.push(args); return { code: 0, text: JSON.stringify([metadata]) }; };
  await assert.rejects(cleanupInternalNetwork({ network: identity, docker: foreign }), /unexpected member/);
  assert.equal(calls.some(args => args[1] === 'rm'), false);
  const docker = async (label, args) => {
    calls.push(args);
    if (args[1] === 'create') return { code: 0, text: identity.id };
    if (label === 'absent-internal-network') return { code: 1, text: 'Error response from daemon: network ' + identity.id + ' not found' };
    if (args[1] === 'inspect') return { code: 0, text: JSON.stringify([{ ...metadata, Containers: {} }]) };
    return { code: 0, text: identity.id };
  };
  const created = await createInternalNetwork({ runId: identity.run_id, docker });
  assert.ok(calls.find(args => args[1] === 'create').includes('--internal'));
  await cleanupInternalNetwork({ network: created, docker }); assert.equal(created.cleanup.absence_confirmed, true);
});
