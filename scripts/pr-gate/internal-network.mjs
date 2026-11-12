import assert from 'node:assert/strict';

export const INTERNAL_NETWORK_SCHEMA = 'pr-gate-internal-network-v1';
const ID = /^[a-f0-9]{64}$/;
const labels = runId => ({ 'com.bondbuddy.pr-gate.run-id': runId, 'com.bondbuddy.pr-gate.network-schema': INTERNAL_NETWORK_SCHEMA });
const options = { 'com.docker.network.bridge.enable_ip_masquerade': 'false', 'com.docker.network.enable_ipv4': 'true' };

export function networkIdentity(runId) {
  assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/);
  return { schema: INTERNAL_NETWORK_SCHEMA, run_id: runId, name: `bb-pr-gate-${runId}-isolated` };
}

export function inspectInternalNetwork(value, expected, containerIds = []) {
  assert.match(expected.id, ID); assert.equal(value?.Id, expected.id); assert.equal(value.Name, expected.name);
  assert.deepEqual(networkIdentity(expected.run_id), { schema: expected.schema, run_id: expected.run_id, name: expected.name });
  assert.equal(value.Driver, 'bridge'); assert.equal(value.Scope, 'local'); assert.equal(value.Internal, true);
  assert.equal(value.Attachable, false); assert.equal(value.Ingress, false); assert.equal(value.EnableIPv6, false);
  assert.deepEqual(value.Labels, labels(expected.run_id)); assert.deepEqual(value.Options, options);
  assert.equal(value.IPAM?.Driver, 'default');
  assert.deepEqual(Object.keys(value.Containers ?? {}).sort(), [...containerIds].sort(), 'Internal network has an unexpected member');
  return { id: value.Id, name: value.Name, run_id: expected.run_id, driver: value.Driver, scope: value.Scope,
    internal: true, attachable: false, ingress: false, ipv6: false, labels: value.Labels, options: value.Options,
    members: Object.entries(value.Containers ?? {}).map(([id, row]) => ({ id, name: row.Name, endpoint_id: row.EndpointID, ipv4: row.IPv4Address, ipv6: row.IPv6Address })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function inspectInternalAttachment(container, network) {
  assert.match(network?.id, ID);
  assert.ok([network.name, network.id].includes(container.HostConfig?.NetworkMode), 'Core must use its exact owned internal network');
  assert.deepEqual(container.HostConfig?.Dns, ['127.0.0.1'], 'External DNS forwarding must be disabled');
  assert.deepEqual(Object.keys(container.NetworkSettings?.Networks ?? {}), [network.name]);
  const attachment = container.NetworkSettings.Networks[network.name];
  assert.equal(attachment.NetworkID, network.id); assert.match(attachment.EndpointID, ID);
  assert.ok(!attachment.GlobalIPv6Address); assert.ok(!attachment.IPv6Gateway);
  assert.match(attachment.IPAddress, /^\d+\.\d+\.\d+\.\d+$/);
  return { network_id: network.id, network_name: network.name, endpoint_id: attachment.EndpointID,
    ipv4: attachment.IPAddress, prefix_length: attachment.IPPrefixLen, dns: ['127.0.0.1'] };
}

// Read the actual namespace routes; never contact the public Internet as a probe.
export const NETWORK_ROUTE_PROBE = `import { readFileSync } from 'node:fs'; import { networkInterfaces } from 'node:os'; console.log(JSON.stringify({ ipv4_routes: readFileSync('/proc/net/route', 'utf8'), ipv6_routes: readFileSync('/proc/net/ipv6_route', 'utf8'), interfaces: networkInterfaces() }));`;
export function verifyInternalRoutes(probe, attachment) {
  const routes = probe.ipv4_routes.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
  assert.ok(routes.length > 0, 'No connected internal route');
  for (const row of routes) {
    assert.ok(row.length >= 8); assert.notEqual(row[1], '00000000', 'Public default IPv4 route is forbidden');
    assert.equal(row[2], '00000000', 'Gateway route is forbidden');
  }
  for (const line of probe.ipv6_routes.trim().split('\n').filter(Boolean)) {
    const row = line.trim().split(/\s+/); assert.equal(row.length, 10);
    assert.ok(row[9] === 'lo' || row[0] !== '0'.repeat(32) || row[1] !== '00', 'Public default IPv6 route is forbidden');
  }
  const addresses = Object.entries(probe.interfaces).flatMap(([name, values]) => values.filter(row => !row.internal).map(row => ({ name, ...row })));
  const ipv4 = addresses.filter(row => row.family === 'IPv4');
  assert.equal(ipv4.length, 1); assert.equal(ipv4[0].address, attachment.ipv4);
  assert.ok(addresses.every(row => row.family === 'IPv4' || /^fe80:/i.test(row.address)), 'Unexpected global network interface');
  assert.ok(routes.every(row => row[0] === ipv4[0].name || row[0] === 'lo'));
  return { status: 'passed', no_default_route: true, no_gateway_route: true, public_probe_requests: 0, ...probe };
}

export async function createInternalNetwork({ runId, docker }) {
  const identity = networkIdentity(runId);
  const result = await docker('create-internal-network', ['network', 'create', '--driver', 'bridge', '--internal', '--attachable=false', '--ipv6=false',
    ...Object.entries(labels(runId)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    ...Object.entries(options).flatMap(([key, value]) => ['--opt', `${key}=${value}`]), identity.name], { capture: true });
  identity.id = result.text.trim(); assert.match(identity.id, ID);
  // Return ownership before inspection, so every later failure still cleans up.
  return { ...identity, status: 'created', cleanup: { status: 'pending' } };
}

export async function auditInternalNetwork({ network, docker, containerId, exec, phase }) {
  const metadata = JSON.parse((await docker(`${phase}-internal-network`, ['network', 'inspect', network.id], { capture: true })).text)[0];
  const inspection = inspectInternalNetwork(metadata, network, containerId ? [containerId] : []);
  if (!containerId) return inspection;
  const container = JSON.parse((await docker(`${phase}-internal-attachment`, ['inspect', containerId], { capture: true, privateCapture: true })).text)[0];
  assert.equal(container.Id, containerId); assert.equal(container.HostConfig.Privileged, false);
  assert.ok(!Object.keys(container.HostConfig.PortBindings ?? {}).length); assert.ok(!container.HostConfig.CapAdd?.length);
  const attachment = inspectInternalAttachment(container, network);
  assert.equal(inspection.members[0].endpoint_id, attachment.endpoint_id);
  assert.equal(inspection.members[0].ipv4, `${attachment.ipv4}/${attachment.prefix_length}`);
  assert.equal(inspection.members[0].name, container.Name.slice(1));
  const probe = JSON.parse((await exec(`${phase}-internal-routes`, ['node', '--input-type=module', '-e', NETWORK_ROUTE_PROBE], {}, { capture: true })).text);
  return { inspection, attachment, routes: verifyInternalRoutes(probe, attachment), container_id: containerId };
}

export async function cleanupInternalNetwork({ network, docker }) {
  const empty = await auditInternalNetwork({ network, docker: (label, args, settings) => docker(label, args, { ...settings, cleanup: true }), phase: 'cleanup' });
  await docker('remove-internal-network', ['network', 'rm', network.id], { cleanup: true });
  const absent = await docker('absent-internal-network', ['network', 'inspect', network.id], { capture: true, allowFailure: true, cleanup: true });
  const message = absent.text + (absent.stderr ?? '');
  assert.ok(absent.code !== 0 && (/no such (network|object)/i.test(message) || new RegExp(`network ${network.id} not found`, 'i').test(message)), 'Cannot confirm owned internal network absence');
  network.cleanup = { status: 'passed', empty, removed_id: network.id, absence_confirmed: true };
}

export function verifyInternalNetworkEvidence(network, { runId, containerId }) {
  assert.deepEqual(networkIdentity(runId), { schema: network?.schema, run_id: network?.run_id, name: network?.name });
  assert.match(network.id, ID); assert.equal(network.status, 'passed');
  for (const phase of ['prepared', 'final']) {
    const record = network[phase]; assert.equal(record.container_id, containerId);
    const inspection = record.inspection;
    assert.equal(inspection.id, network.id); assert.equal(inspection.name, network.name); assert.equal(inspection.run_id, runId);
    assert.equal(inspection.driver, 'bridge'); assert.equal(inspection.scope, 'local'); assert.equal(inspection.internal, true);
    for (const field of ['attachable', 'ingress', 'ipv6']) assert.equal(inspection[field], false);
    assert.deepEqual(inspection.labels, labels(runId)); assert.deepEqual(inspection.options, options);
    assert.equal(inspection.members.length, 1); assert.equal(inspection.members[0].id, containerId);
    assert.equal(record.attachment.network_id, network.id); assert.equal(record.attachment.network_name, network.name);
    assert.deepEqual(record.attachment.dns, ['127.0.0.1']);
    assert.equal(inspection.members[0].endpoint_id, record.attachment.endpoint_id);
    assert.equal(inspection.members[0].ipv4, `${record.attachment.ipv4}/${record.attachment.prefix_length}`);
    assert.equal(record.routes.status, 'passed'); verifyInternalRoutes(record.routes, record.attachment);
  }
  assert.equal(network.cleanup?.status, 'passed'); assert.equal(network.cleanup.removed_id, network.id);
  assert.equal(network.cleanup.absence_confirmed, true); assert.equal(network.cleanup.empty?.id, network.id);
  assert.deepEqual(network.cleanup.empty.members, []);
  return network;
}
