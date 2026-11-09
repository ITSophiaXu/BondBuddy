import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, billingApi, billingLedger, integer, channelState, accountAmounts } from './local-prelaunch-billing-helpers';
import { createSyntheticProject, fillSourceInformation, openProject, uploadFromPicker, localSql } from './local-prelaunch-helpers';
import { asUploadFile, createLocalPrelaunchBasicFixtures } from './local-prelaunch-fixtures';
import { legacySnapshot as persistedExecution } from './local-prelaunch-legacy-billing-helpers';

// Collection and type checking never authorize a real execution. The dedicated
// gate is set only after the root has granted this test the shared model window.
test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH !== '1' || process.env.BB_E2E_REAL_MODEL !== '1' ||
  process.env.BB_E2E_AUTHORING_BALANCE_RECOVERY !== '1', 'Requires an explicitly coordinated local authoring recovery/model window.');
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(1800000);

// Keep a private current session separately from audit evidence so an observer
// failure after admission can inspect the same task without another payment/run.
test.afterEach(async ({ page, billing }) => {
  if (!billing?.directory || page.isClosed()) return;
  const file = join(billing.directory, `session-final-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(await page.context().storageState()), { flag: 'wx', mode: 0o600 });
  billing.record('private-final-session-retained', { path: file, credentialsIncludedInAudit: false });
});

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function inputIdentities(owner: string, project: string) {
  return localSql<any[]>(`SELECT COALESCE(json_agg(json_build_object('revision',revision,'input_hash',btrim(input_hash),
    'draft_revision',draft_revision) ORDER BY revision),'[]'::json) FROM bb_input_revisions
    WHERE owner_user_id=${literal(owner)} AND project_id=${literal(project)};`);
}
const yuan = (fen: bigint) => `${fen / 100n}.${String(fen % 100n).padStart(2, '0')}`;

test('current authoring zero balance returns from real cashier to the original input and quote, delivers dual Word and settles once', async ({ page, billing }) => {
  const marker = `balance_${randomUUID().slice(0, 8)}`;
  const fixture = createLocalPrelaunchBasicFixtures({ marker }).normalDocx;
  const project = await createSyntheticProject(page, marker);
  await openProject(page, project.project_id);
  const source = await uploadFromPicker(page, project.project_id, asUploadFile(fixture), true);
  await fillSourceInformation(page, source.material_id);
  const instruction = '【纯合成验收】只对本原稿做最小修订：把原稿报告期2025年度改为2026年1—9月，并保留SYNTHETIC声明和唯一测试标记。保留原稿全部其他内容及格式，不扩写完整募集书，不虚构财务数据或发行条款，交付修订版与清洁版。';
  await page.getByLabel('补充募集书更新说明', { exact: true }).fill(instruction);
  await page.getByLabel('补充募集书更新说明', { exact: true }).blur();
  await expect(page.locator('#conversation-status')).toContainText(/已自动保存|已保存/);
  const before = billing.checkpoint('unfunded-authoring-before-start');
  expect(before.orders).toEqual([]); expect(before.lots).toEqual([]); expect(before.events).toEqual([]);
  expect(before.runs).toEqual([]); expect(before.reservations).toEqual([]); expect(before.modelCalls).toEqual([]);
  accountAmounts(await channelState(page, billing.owner), 0n);

  // Capture what the real start button sends. Do not construct, seed or replace
  // its billing intent, input revision, quote, response or localStorage record.
  const quoting = page.waitForResponse(r => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === `/api/v1/projects/${project.project_id}/credit-quote`);
  const rejecting = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/runs/execute');
  await expect(page.locator('#execute-input')).toBeEnabled();
  const originalReturn = new URL(page.url()).hash;
  await page.locator('#execute-input').click();
  const [quotedResponse, rejected] = await Promise.all([quoting, rejecting]);
  expect(quotedResponse.status(), await quotedResponse.text()).toBe(200);
  expect(rejected.status(), await rejected.text()).toBe(402);
  expect((await rejected.json()).code).toBe('CREDITS_INSUFFICIENT');
  const quoteResponse = await quotedResponse.json(), originalQuote = quoteResponse.quote;
  const original = rejected.request().postDataJSON();
  const points = integer(originalQuote.points);
  expect(points).toBeGreaterThan(0n); expect(points).toBeLessThanOrEqual(1000000n);
  expect(originalQuote).toMatchObject({ auto_charge: true, pricing_mode: 'outcome_cny_v1', quote_status: 'ready',
    project_id: project.project_id, input_revision: original.input_revision, input_hash: original.input_hash });
  expect(original.quote_id).toBe(originalQuote.quote_id);
  expect(original.project_id).toBe(project.project_id);
  expect(original.task_kind).toBe('update');
  expect(integer(quoteResponse.balance.available)).toBe(0n);
  const inputPath = `/api/v1/projects/${project.project_id}/input-revisions/${original.input_revision}`;
  const locked = await billingApi(page, 'GET', inputPath);
  expect(locked.status).toBe(200); expect(locked.body.input_hash).toBe(original.input_hash);
  expect(locked.body.material_versions).toEqual([{ material_id: source.material_id, material_version: source.material_version }]);
  const inputs = inputIdentities(billing.owner, project.project_id);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ revision: original.input_revision, input_hash: original.input_hash });
  await expect(page.locator('#billing-task-notice')).toContainText('原任务尚未开始');
  await expect(page.locator('#execute-input')).not.toHaveText('正在提交…');
  expect(billing.checkpoint('zero-balance-rejection-no-run-reservation-debit-or-model')).toEqual(before);
  billing.record('original-ui-authoring-request-input-and-quote', { original, quote: originalQuote, input: locked.body, inputs,
    source: { id: source.material_id, version: source.material_version, sha256: fixture.sha256 }, originalReturn });

  const recharge = page.locator('#billing-task-notice').getByRole('link', { name: '订阅或充值，继续原任务', exact: true });
  const href = await recharge.getAttribute('href'); expect(href).toBeTruthy();
  const query = new URLSearchParams(href!.split('?')[1]), resumeId = query.get('resume_request');
  expect(resumeId).toMatch(/^[a-f0-9]{64}$/); expect(query.get('return_to')).toBe(originalReturn);
  const pending = await page.evaluate(id => JSON.parse(localStorage.getItem('bondbuddy:billing-task:v2:' + id) ?? 'null'), resumeId);
  expect(pending).toMatchObject({ owner: billing.owner, path: '/runs/execute', state: 'needs_funds',
    requestId: original.execution_request_id, body: original, returnTo: originalReturn, requiredPoints: points.toString() });
  billing.record('durable-original-authoring-intent', { resumeId, pending });
  await page.screenshot({ path: join(billing.directory, '01-authoring-zero-balance.png'), fullPage: true });
  await recharge.click();
  await expect(page).toHaveURL(new RegExp(`resume_request=${resumeId}`));
  await expect(page.locator('#subscription-topup-amount')).toHaveValue(yuan(points));

  const paying = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/commerce/topups');
  await page.getByRole('button', { name: '充值并前往支付', exact: true }).click();
  const paymentResponse = await paying; expect(paymentResponse.status(), await paymentResponse.text()).toBe(201);
  const order = await paymentResponse.json();
  expect(order.amount_fen).toBe(points.toString()); expect(order.points).toBe(points.toString()); expect(order.state).toBe('pending');
  billing.record('real-ui-exact-shortage-payment-order', { order, request: paymentResponse.request().postDataJSON() });
  const pendingPayment = billing.checkpoint('one-pending-order-no-credit-or-task');
  expect(pendingPayment.orders).toHaveLength(1); expect(pendingPayment.events).toEqual([]); expect(pendingPayment.lots).toEqual([]);
  expect(pendingPayment.runs).toEqual([]); expect(pendingPayment.reservations).toEqual([]); expect(pendingPayment.modelCalls).toEqual([]);
  await page.getByRole('link', { name: '打开模拟收银台', exact: true }).click();
  await expect(page.locator('#checkout-title')).toHaveText('等待模拟支付');
  const cashierQuery = new URL(page.url()).searchParams;
  expect(cashierQuery.get('order')).toBe(order.order_id);
  expect(cashierQuery.get('return_to')).toContain(`resume_request=${resumeId}`);
  await page.locator('#delivery').selectOption('query');
  await page.locator('#simulate-paid').click();
  await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');
  accountAmounts(await channelState(page, billing.owner), 0n);
  expect(billing.checkpoint('channel-paid-awaiting-product-confirmation')).toEqual(pendingPayment);
  await page.locator('#refresh-payment').click();
  await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
  accountAmounts(await channelState(page, billing.owner), points);
  const funded = billing.checkpoint('cashier-query-credits-original-order-once-before-return');
  expect(funded.orders).toHaveLength(1); expect(funded.orders[0].state).toBe('paid');
  expect(funded.lots).toHaveLength(1); expect(funded.lots[0]).toMatchObject({ source_key: `recharge:${order.order_id}`,
    original_points: points.toString(), remaining: points.toString(), frozen: '0' });
  expect(funded.events).toHaveLength(1); expect(funded.events[0]).toMatchObject({ kind: 'grant', points: points.toString() });
  expect(funded.runs).toEqual([]); expect(funded.reservations).toEqual([]); expect(funded.modelCalls).toEqual([]);
  await page.screenshot({ path: join(billing.directory, '02-cashier-confirmed-before-return.png'), fullPage: true });

  const resuming = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/runs/execute');
  await page.locator('#return-paid').click();
  const resumed = await resuming; expect(resumed.status(), await resumed.text()).toBe(202);
  expect(resumed.request().postDataJSON()).toEqual(original);
  const accepted = await resumed.json(), runId = accepted.run_id as string;
  expect(accepted).toMatchObject({ project_id: project.project_id, execution_request_id: original.execution_request_id,
    input_revision: original.input_revision, input_hash: original.input_hash });
  await expect(page.locator('#project-heading')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe(originalReturn);
  expect(await page.evaluate(id => localStorage.getItem('bondbuddy:billing-task:v2:' + id), resumeId)).toBeNull();
  expect(inputIdentities(billing.owner, project.project_id)).toEqual(inputs);
  const inputAfterReturn = await billingApi(page, 'GET', inputPath);
  expect(inputAfterReturn.status).toBe(200); expect(inputAfterReturn.body).toEqual(locked.body);
  billing.record('cashier-return-automatically-resumed-identical-authoring-request', { original, resumed: resumed.request().postDataJSON(), accepted });
  const sessionFile = join(billing.directory, 'session-after-admission.json');
  writeFileSync(sessionFile, JSON.stringify(await page.context().storageState()), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(billing.directory, 'accepted-run.json'), JSON.stringify({
    schema: 'current-authoring-cashier-accepted-v1', owner: billing.owner, projectId: project.project_id,
    runId, originalRequest: original, originalQuote, lockedInput: locked.body, inputs,
    fundedLedger: funded, originalReturn, sourceHash: fixture.sha256, sessionFile,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  await expect(page.locator('#prospectus-panel')).toHaveClass(/prospectus-readonly/);
  await expect(page.locator('#choose-prospectus-version')).toBeHidden();
  await expect(page.locator('#prospectus-version-file')).toBeDisabled();
  await expect(page.locator('[data-download-version]').first()).toBeEnabled();
  await page.screenshot({ path: join(billing.directory, '03-resumed-authoring-reference-locked.png'), fullPage: true });

  const duplicate = await billingApi(page, 'POST', '/api/v1/runs/execute', original);
  expect(duplicate.status).toBe(202); expect(duplicate.body.run_id).toBe(runId);
  await page.reload(); await expect(page.locator('#project-heading')).toBeVisible();
  await expect(page.locator('#prospectus-panel')).toHaveClass(/prospectus-readonly/);
  await expect(page.locator('#choose-prospectus-version')).toBeHidden();
  await expect(page.locator('#prospectus-version-file')).toBeDisabled();
  let terminal: any, lastState = '';
  await expect.poll(async () => {
    const result = await billingApi(page, 'GET', `/api/v1/runs/${runId}`); expect(result.status).toBe(200); terminal = result.body;
    const state = `${terminal.state}/${terminal.stage}`;
    if (state !== lastState) { lastState = state; billing.record('real-recovered-authoring-worker-state', terminal); }
    return ['succeeded', 'failed', 'cancelled', 'rejected', 'paused'].includes(terminal.state);
  }, { timeout: 1500000, intervals: [2000, 5000, 10000] }).toBe(true);
  expect(terminal.state, JSON.stringify(terminal)).toBe('succeeded'); expect(terminal.artifact_id).toBeTruthy();
  const charge = await billingApi(page, 'GET', `/api/v1/runs/${runId}/credit-charge`);
  expect(charge.status).toBe(200); expect(charge.body.quote).toEqual(originalQuote);
  expect(charge.body.state).toBe('settled');
  expect(charge.body.progress).toMatchObject({ policy: 'on_delivery', charged_points: points.toString(), released_points: '0' });
  const settled = billing.checkpoint('original-authoring-on-delivery-settled-once');
  expect(settled.orders).toEqual(funded.orders); expect(settled.runs).toHaveLength(1); expect(settled.reservations).toHaveLength(1);
  expect(settled.runs[0]).toMatchObject({ id: runId, execution_request_id: original.execution_request_id, state: 'succeeded' });
  expect(settled.reservations[0]).toMatchObject({ run_id: runId, state: 'settled', billing_policy: 'on_delivery',
    points: points.toString(), charged_points: points.toString() });
  for (const kind of ['reserve', 'settle']) {
    const rows = settled.events.filter((event: any) => event.run_id === runId && event.kind === kind);
    expect(rows).toHaveLength(1); expect(rows[0].points).toBe(points.toString());
  }
  expect(settled.events.filter((event: any) => event.kind === 'grant')).toEqual(funded.events);
  expect(settled.events.filter((event: any) => event.kind === 'release')).toEqual([]);
  expect(settled.allocations.reduce((sum: bigint, allocation: any) => sum + integer(allocation.charged_points), 0n)).toBe(points);
  expect(settled.modelCalls).toHaveLength(1);
  expect(settled.modelCalls[0]).toMatchObject({ run_id: runId, status: 'completed', model_id: 'gpt-6-sol', usage_status: 'measured' });
  accountAmounts(await channelState(page, billing.owner), 0n);
  const durable = persistedExecution(billing.owner, runId);
  expect(durable.identity).toMatchObject({ run_id: runId, execution_request_id: original.execution_request_id,
    input_revision: original.input_revision, input_hash: original.input_hash, reservation_id: settled.reservations[0].id });
  expect(durable.quote).toMatchObject({ quote_id: originalQuote.quote_id, price_version: originalQuote.price_version, points: points.toString() });
  expect(durable.results).toHaveLength(1); expect(durable.results[0].attempt_id).toBe(settled.modelCalls[0].id);
  billing.record('original-input-price-and-measured-provider-result', { charge: charge.body, durable });

  const artifact = await billingApi(page, 'GET', `/api/v1/artifacts/${terminal.artifact_id}`);
  expect(artifact.status).toBe(200); expect(artifact.body.run_id).toBe(runId);
  const delivery = artifact.body.word_delivery;
  expect(delivery.revision_artifact_id).toBe(terminal.artifact_id); expect(delivery.clean_artifact_id).toBeTruthy();
  expect(delivery.clean_artifact_id).not.toBe(delivery.revision_artifact_id);
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  for (const [label, name, artifactId] of [['下载修订版', 'tracked.docx', delivery.revision_artifact_id],
    ['下载清洁版', 'clean.docx', delivery.clean_artifact_id]] as const) {
    const descriptor = await billingApi(page, 'GET', `/api/v1/artifacts/${artifactId}`);
    expect(descriptor.status).toBe(200); expect(descriptor.body.run_id).toBe(runId);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const file = join(billing.directory, name); await (await downloading).saveAs(file);
    const bytes = readFileSync(file), sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.length).toBeGreaterThan(1000); expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(sha256).toBe(descriptor.body.sha256);
    billing.record('actual-recovered-authoring-Word-download', { name, artifactId, runId, bytes: bytes.length, sha256 });
  }
  for (let i = 0; i < 2; i++) {
    await page.reload(); await expect(page.getByRole('button', { name: '下载清洁版', exact: true })).toBeVisible();
    expect(billingLedger(billing.owner)).toEqual(settled); expect(persistedExecution(billing.owner, runId)).toEqual(durable);
  }
  const replays = await Promise.all(Array.from({ length: 3 }, () => billingApi(page, 'POST', '/api/v1/runs/execute', original)));
  for (const replay of replays) { expect(replay.status).toBe(202); expect(replay.body.run_id).toBe(runId); expect(replay.body.artifact_id).toBe(terminal.artifact_id); }
  expect(inputIdentities(billing.owner, project.project_id)).toEqual(inputs);
  expect(persistedExecution(billing.owner, runId)).toEqual(durable);
  expect(billing.checkpoint('refresh-and-concurrent-terminal-replay-preserve-complete-ledger')).toEqual(settled);
});
