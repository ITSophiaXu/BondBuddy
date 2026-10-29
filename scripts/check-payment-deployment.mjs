// Consume `docker compose config --format json` on stdin. Never print the source
// configuration: Compose resolves private credentials into the same document.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const billingServices = ['api', 'worker', 'worker-review', 'worker-parse', 'ops'];
const merchantHost = 'api.mch.weixin.qq.com';
const proxyUrl = 'http://egress:3128';

export function checkPaymentDeployment(config) {
  const checks = [];
  const record = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  const services = config?.services ?? {};
  const env = name => services[name]?.environment ?? {};
  const switchValue = env('api').BB_SUBSCRIPTION_BILLING_ENABLED;
  record('subscription_switch_shared', ['0', '1'].includes(String(switchValue)) && billingServices.every(
    name => String(env(name).BB_SUBSCRIPTION_BILLING_ENABLED) === String(switchValue),
  ));

  const api = services.api ?? {};
  const apiNetworks = Array.isArray(api.networks) ? api.networks : Object.keys(api.networks ?? {});
  record('api_private_network', config?.networks?.backend?.internal === true
    && apiNetworks.length === 1 && apiNetworks[0] === 'backend');
  record('api_egress_dependency', api.depends_on?.egress?.condition === 'service_started');

  const apiEnv = env('api');
  record('api_environment_proxy', String(apiEnv.NODE_USE_ENV_PROXY) === '1'
    && apiEnv.HTTPS_PROXY === proxyUrl && apiEnv.https_proxy === proxyUrl);
  const noProxy = String(apiEnv.NO_PROXY ?? '');
  const bypasses = noProxy.split(',').map(value => value.trim()).filter(Boolean);
  const internalHosts = new Set([...Object.keys(services), 'localhost', '127.0.0.1', '::1', '[::1]']);
  const isPrivateIpv4 = host => {
    const bytes = host.split('.').map(Number);
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) && bytes.every(value => value >= 0 && value <= 255)
      && (bytes[0] === 10 || bytes[0] === 127 || (bytes[0] === 192 && bytes[1] === 168)
        || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31));
  };
  record('api_internal_proxy_bypass', noProxy === apiEnv.no_proxy
    && ['postgres', 'api', 'localhost', '127.0.0.1'].every(host => bypasses.includes(host))
    && bypasses.every(host => internalHosts.has(host) || isPrivateIpv4(host)));

  const allowedHosts = String(env('egress').BB_EGRESS_ALLOW ?? '').split(/[,\s]+/).filter(Boolean);
  const exactHostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/i;
  record('egress_exact_hostnames', allowedHosts.length > 0 && allowedHosts.every(host => exactHostname.test(host)));
  const wechatSwitch = String(apiEnv.BB_WECHAT_PAY_ENABLED);
  record('wechat_switch_explicit', ['0', '1'].includes(wechatSwitch));
  record('wechat_host_when_enabled', wechatSwitch !== '1' || allowedHosts.includes(merchantHost));
  return { passed: checks.every(check => check.passed), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkPaymentDeployment(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    // Do not expose JSON parser messages: they may contain credential fragments.
    process.stdout.write('{"passed":false,"error":"COMPOSE_CONFIG_JSON_INVALID"}\n');
    process.exitCode = 1;
  }
}
