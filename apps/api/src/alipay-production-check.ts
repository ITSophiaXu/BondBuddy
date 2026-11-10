import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paymentProvidersFromEnv, type PaymentProviderConfigDependencies } from './payment-provider-config.js';

/** Local validation only: no gateway requests, orders, database access or secret output. */
export function checkAlipayProduction(env: NodeJS.ProcessEnv, dependencies: PaymentProviderConfigDependencies = {}) {
  const checks: { name: string; passed: boolean }[] = [];
  const record = (name: string, passed: boolean) => checks.push({ name, passed });
  record('alipay_enabled', env.BB_ALIPAY_PAY_ENABLED === '1');
  const production = (env.BB_ALIPAY_ENVIRONMENT ?? 'production') === 'production';
  record('production_environment', production);
  record('subscription_billing_enabled', env.BB_SUBSCRIPTION_BILLING_ENABLED === '1');
  record('web_product', ['page', 'wap'].includes(env.BB_ALIPAY_WEB_PRODUCT ?? ''));
  let urlsValid = false;
  try {
    const origin = new URL(env.BB_ALLOWED_ORIGIN ?? '');
    const notify = new URL(env.BB_ALIPAY_NOTIFY_URL ?? '');
    const back = new URL(env.BB_ALIPAY_RETURN_URL ?? '');
    urlsValid = [origin, notify, back].every(url => url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash)
      && origin.pathname === '/' && notify.origin === origin.origin && back.origin === origin.origin
      && notify.pathname === '/api/v1/payments/alipay/callback' && back.pathname === '/payment/alipay/return.html';
  } catch { /* Report only the check name, never the malformed configuration. */ }
  record('public_payment_urls', urlsValid);
  // A production check must never load sandbox credentials, even when misconfigured.
  const configuration = production ? paymentProvidersFromEnv(env, dependencies) : undefined;
  record('provider_configuration', configuration?.status === 'ready' && configuration.providers.some(provider => provider.name === 'alipay'));
  return {
    configuration_valid: checks.every(check => check.passed),
    checks,
    // Local configuration cannot prove merchant authorization or a real payment.
    external_verification_required: ['application_approval', 'merchant_contract', 'public_callback', 'payment_crediting', 'refund'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkAlipayProduction(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.configuration_valid ? 0 : 1;
  } catch {
    process.stdout.write('{"configuration_valid":false,"error":"ALIPAY_CONFIGURATION_CHECK_FAILED"}\n');
    process.exitCode = 1;
  }
}
