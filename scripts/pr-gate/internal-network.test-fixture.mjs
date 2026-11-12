// Synthetic input for pure verifier tests; never Docker/runtime evidence.
import { networkIdentity, inspectInternalNetwork, inspectInternalAttachment, verifyInternalRoutes } from './internal-network.mjs';

export function syntheticInternalNetwork(runId = 'synthetic-network-1234', containerId = 'c'.repeat(64)) {
  const identity = { ...networkIdentity(runId), id: 'a'.repeat(64) }, endpoint = 'e'.repeat(64);
  const metadata = { Id: identity.id, Name: identity.name, Driver: 'bridge', Scope: 'local', Internal: true, Attachable: false, Ingress: false, EnableIPv6: false,
    Labels: { 'com.bondbuddy.pr-gate.run-id': runId, 'com.bondbuddy.pr-gate.network-schema': identity.schema },
    Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false', 'com.docker.network.enable_ipv4': 'true' }, IPAM: { Driver: 'default' },
    Containers: { [containerId]: { Name: `bb-pr-gate-${runId}`, EndpointID: endpoint, IPv4Address: '172.29.0.2/16', IPv6Address: '' } } };
  const container = { Id: containerId, Name: `/bb-pr-gate-${runId}`, HostConfig: { NetworkMode: identity.id, Dns: ['127.0.0.1'], Privileged: false, CapAdd: [], PortBindings: {} },
    NetworkSettings: { Networks: { [identity.name]: { NetworkID: identity.id, EndpointID: endpoint, IPAddress: '172.29.0.2', IPPrefixLen: 16, GlobalIPv6Address: '', IPv6Gateway: '' } } } };
  const probe = { ipv4_routes: 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00001DAC 00000000 0001 0 0 0 0000FFFF 0 0 0\n',
    ipv6_routes: '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200 lo\n',
    interfaces: { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], eth0: [{ address: '172.29.0.2', family: 'IPv4', internal: false }] } };
  const attachment = inspectInternalAttachment(container, identity);
  const observed = { container_id: containerId, inspection: inspectInternalNetwork(metadata, identity, [containerId]), attachment, routes: verifyInternalRoutes(probe, attachment) };
  const evidence = { ...identity, status: 'passed', prepared: structuredClone(observed), final: structuredClone(observed), cleanup: { status: 'passed',
    empty: inspectInternalNetwork({ ...metadata, Containers: {} }, identity), removed_id: identity.id, absence_confirmed: true } };
  return { identity, metadata, container, probe, evidence };
}
