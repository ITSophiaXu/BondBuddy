#!/usr/bin/env node
/**
 * BondBuddy 合并前检查（PR gate）
 *
 * 做什么：
 *   自动发现仓库里的全部自动化测试并逐个运行，任何一个失败就返回非零退出码。
 *   测试是按目录发现的，不靠手写清单：新加的 *.test.ts / *.spec.ts / test_*.py 会自动进入检查。
 *
 * 用法：
 *   node scripts/pr-gate/run.mjs run   --group api,worker [--shard 1/2] [--report] [--list]
 *   node scripts/pr-gate/run.mjs merge <各分片结果所在目录> [--expect <分片数>] [--report]
 *
 * 例外只能写在 scripts/pr-gate/exclusions.json 里，每一条都必须写原因：
 *   notInCi       不在合并前检查里运行（需要真实模型、真实环境等）
 *   knownFailing  已知失败：照常运行，失败不拦合并；恢复通过后会提示移出清单
 *   allowSkip     允许出现“跳过”的测试文件；其它文件出现跳过会拦合并
 *
 * 只用 Node 标准库，不需要安装额外依赖。
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilityEnvironment, verifyPreparedCapabilities } from './capabilities.mjs';
import { initializeHostClient, requestHostExecution } from './host-dispatch-client.mjs';
import { HOST_ENV_KEYS } from './host-profiles.mjs';
import { browserInvocation, startBrowserRuntime } from './browser-runtime.mjs';
import { createBrowserDispatch, HISTORICAL_COLLECTORS, mergeBrowserReports, verifyBrowserDispatch } from './browser-dispatch.mjs';
import { historicalRemaining } from './browser-historical-runtime.mjs';
import { captureQaScreenshots } from './browser-qa-collector.mjs';
import { browserHash } from './browser-profiles.mjs';
import { archiveBrowserOutput } from './browser-artifacts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '../..');
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-test', '.git', '.local', '.runtime', '__pycache__']);
const LISTS = ['notInCi', 'knownFailing', 'allowSkip'];
const OUTPUT_CAP = 8 * 1024 * 1024;
export const SUMMARY_SCHEMA = 'pr-gate-summary-v1';

// ---------------------------------------------------------------- 发现测试

function walk(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const found = [];
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) found.push(...walk(root, relative)); }
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}
function topLevel(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `${directory}/${entry.name}`).sort();
}
function subdirectories(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}
/** TypeScript 测试：按源码发现，运行编译后的 dist 文件。 */
function compiled(root, workspace) {
  return walk(root, `${workspace}/src`).filter(file => file.endsWith('.test.ts'))
    .map(id => ({ id, run: id.replace(`${workspace}/src/`, `${workspace}/dist/`).replace(/\.ts$/, '.js') }));
}

/** 每个分组：用哪种方式运行、怎样发现测试文件。id 一律是源码路径，例外清单也按它匹配。 */
export const GROUPS = {
  api: { runner: 'node', discover: root => compiled(root, 'apps/api') },
  worker: { runner: 'node', discover: root => compiled(root, 'apps/worker') },
  packages: { runner: 'node', discover: root => subdirectories(root, 'packages').flatMap(name => compiled(root, `packages/${name}`)) },
  'web-unit': {
    runner: 'node',
    // 这组测试用相对路径读取 src/、tests/ 和仓库根目录，必须和 npm run test:unit 一样从 apps/web 启动。
    cwd: 'apps/web',
    prepare: { command: 'npm', args: ['exec', '--workspace', '@bondbuddy/web', '--', 'tsc', '-p', 'tsconfig.test.json'], label: '编译页面单元测试' },
    discover: root => topLevel(root, 'apps/web/src').filter(file => file.endsWith('.test.ts'))
      .map(id => ({ id, run: id.replace('apps/web/src/', 'apps/web/dist-test/').replace(/\.ts$/, '.js') })),
  },
  scripts: { runner: 'node', discover: root => [...walk(root, 'scripts'), ...walk(root, 'deploy')].filter(file => file.endsWith('.test.mjs')).map(id => ({ id, run: id })) },
  python: { runner: 'python', discover: root => topLevel(root, 'python/tests').filter(file => /\/test_[^/]+\.py$/.test(file)).map(id => ({ id, run: id })) },
  browser: { runner: 'playwright', discover: root => topLevel(root, 'apps/web/tests').filter(file => file.endsWith('.spec.ts')).map(id => ({ id, run: id })) },
};

// ---------------------------------------------------------------- 例外清单

/** `*` 匹配一层目录内的任意字符，`**` 可以跨目录。 */
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index++; } else source += '[^/]*';
    } else source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
export function parseExclusions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('例外清单必须是一个 JSON 对象');
  const unknown = Object.keys(raw).filter(key => !LISTS.includes(key) && !key.startsWith('_'));
  if (unknown.length) throw new Error(`例外清单里有不认识的字段：${unknown.join('、')}`);
  const lists = {};
  for (const name of LISTS) {
    const entries = raw[name] ?? [];
    if (!Array.isArray(entries)) throw new Error(`例外清单的 ${name} 必须是数组`);
    lists[name] = entries.map((entry, index) => {
      if (!entry || typeof entry.pattern !== 'string' || !entry.pattern.trim()) throw new Error(`${name}[${index}] 缺少 pattern`);
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error(`${name}[${index}]（${entry.pattern}）必须写 reason`);
      return { pattern: entry.pattern, reason: entry.reason, expression: globToRegExp(entry.pattern) };
    });
  }
  return lists;
}
const matchEntry = (entries, id) => entries.find(entry => entry.expression.test(id));

// ---------------------------------------------------------------- 结果解析

/** node --test 的 TAP 汇总；测试自己打印的同名行不影响结果，取最后一组。 */
export function parseTap(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (!matches.length) return null;
    counts[key] = Number(matches.at(-1)[1]);
  }
  return counts;
}
export function evaluateNode(execution) {
  const tap = parseTap(execution.stdout);
  const counts = tap ? { tests: tap.tests, skipped: tap.skipped + tap.todo } : { tests: 0, skipped: 0 };
  if (execution.timedOut) return { status: 'failed', reason: '超时', ...counts };
  if (execution.code !== 0) return { status: 'failed', reason: tap ? `失败 ${tap.fail} 项，取消 ${tap.cancelled} 项（退出码 ${execution.code ?? execution.signal}）` : `退出码 ${execution.code ?? execution.signal}`, ...counts };
  if (!tap) return { status: 'failed', reason: '没有输出测试汇总', ...counts };
  if (tap.tests < 1) return { status: 'failed', reason: '没有运行任何测试', ...counts };
  if (tap.fail > 0 || tap.cancelled > 0) return { status: 'failed', reason: `失败 ${tap.fail} 项，取消 ${tap.cancelled} 项`, ...counts };
  return { status: 'passed', reason: null, ...counts };
}
/** python -m unittest 的结尾汇总。 */
export function parseUnittest(output) {
  const ran = [...output.matchAll(/^Ran (\d+) tests? in /gm)].at(-1);
  const verdict = [...output.matchAll(/^(OK|FAILED)(?: \(([^)]*)\))?\s*$/gm)].at(-1);
  if (!ran || !verdict) return null;
  const detail = Object.fromEntries((verdict[2] ?? '').split(',').map(part => part.trim()).filter(Boolean)
    .map(part => { const [key, value] = part.split('='); return [key.trim(), Number(value)]; }));
  return { tests: Number(ran[1]), ok: verdict[1] === 'OK', skipped: detail.skipped ?? 0, failures: detail.failures ?? 0, errors: detail.errors ?? 0 };
}
export function evaluatePython(execution) {
  const summary = parseUnittest(`${execution.stdout}\n${execution.stderr}`);
  const counts = summary ? { tests: summary.tests, skipped: summary.skipped } : { tests: 0, skipped: 0 };
  if (execution.timedOut) return { status: 'failed', reason: '超时', ...counts };
  if (execution.code !== 0) return { status: 'failed', reason: summary ? `失败 ${summary.failures} 项，出错 ${summary.errors} 项（退出码 ${execution.code}）` : `退出码 ${execution.code ?? execution.signal}`, ...counts };
  if (!summary) return { status: 'failed', reason: '没有输出测试汇总', ...counts };
  // 整个测试类被跳过时 unittest 报“Ran 0 tests … OK (skipped=1)”：这是跳过，不是失败。
  if (summary.tests < 1 && !(summary.ok && summary.skipped > 0)) return { status: 'failed', reason: '没有运行任何测试', ...counts };
  if (!summary.ok) return { status: 'failed', reason: `失败 ${summary.failures} 项，出错 ${summary.errors} 项`, ...counts };
  return { status: 'passed', reason: null, ...counts };
}
/** Playwright JSON 报告：按测试文件汇总。不稳定（重试后才通过）也算失败。 */
export function evaluatePlaywright(report, items, execution = { code: 0, timedOut: false }) {
  const byFile = new Map(items.map(item => [basename(item.id), { id: item.id, tests: 0, failed: 0, flaky: 0, skipped: 0 }]));
  const visit = (suite, inheritedFile) => {
    const file = basename(suite.file ?? inheritedFile ?? suite.title ?? '');
    const entry = byFile.get(file);
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      if (!entry) continue;
      entry.tests++;
      if (test.status === 'unexpected') entry.failed++;
      else if (test.status === 'flaky') entry.flaky++;
      else if (test.status === 'skipped') entry.skipped++;
    }
    for (const child of suite.suites ?? []) visit(child, suite.file ?? inheritedFile);
  };
  for (const suite of report?.suites ?? []) visit(suite, undefined);
  const globalErrors = report ? (report.errors ?? []).length : 0;
  const results = [...byFile.values()].map(entry => {
    const counts = { tests: entry.tests, skipped: entry.skipped };
    if (!report) return { id: entry.id, status: 'failed', reason: execution.timedOut ? '浏览器测试整体超时，没有生成报告' : '浏览器测试没有生成报告', ...counts };
    if (entry.failed || entry.flaky) return { id: entry.id, status: 'failed', reason: `失败 ${entry.failed} 项，不稳定 ${entry.flaky} 项`, ...counts };
    if (entry.tests < 1) return { id: entry.id, status: 'failed', reason: globalErrors ? '文件加载出错，没有运行任何测试' : '没有运行任何测试', ...counts };
    return { id: entry.id, status: 'passed', reason: null, ...counts };
  });
  const problems = [];
  if (report && globalErrors && !results.some(result => result.status === 'failed')) problems.push(`浏览器测试报告了 ${globalErrors} 个全局错误`);
  if (report && execution.code !== 0 && !results.some(result => result.status === 'failed') && !problems.length) problems.push(`浏览器测试退出码 ${execution.code}，但没有定位到失败的文件`);
  return { results, problems };
}

// ---------------------------------------------------------------- 判定

/**
 * 把逐个文件的结果变成“拦不拦合并”的结论。
 * results: [{ id, status: 'passed'|'failed', reason, tests, skipped }]
 */
export function judge(results, lists, problems = []) {
  const verdict = { blocking: [], tolerated: [], recovered: [], skipsAllowed: [], passed: 0, problems: [...problems] };
  for (const result of results) {
    const known = matchEntry(lists.knownFailing, result.id);
    if (result.status === 'failed') {
      if (known) verdict.tolerated.push({ id: result.id, why: result.reason, listed: known.reason });
      else verdict.blocking.push({ id: result.id, kind: 'failed', why: result.reason });
      continue;
    }
    if (known) { verdict.passed++; verdict.recovered.push({ id: result.id, listed: known.reason }); continue; }
    if (result.skipped > 0) {
      const allowed = matchEntry(lists.allowSkip, result.id);
      if (!allowed) { verdict.blocking.push({ id: result.id, kind: 'skipped', why: `有 ${result.skipped} 项测试被跳过` }); continue; }
      verdict.skipsAllowed.push({ id: result.id, skipped: result.skipped, listed: allowed.reason });
    }
    verdict.passed++;
  }
  verdict.status = verdict.blocking.length || verdict.problems.length ? 'failed' : 'passed';
  return verdict;
}

// ---------------------------------------------------------------- 运行

function execute(command, args, { cwd, env, timeoutMs, inherit = false }) {
  return new Promise(done => {
    const started = Date.now();
    const windows = process.platform === 'win32';
    let child, finished = false, timedOut = false, stdout = '', stderr = '';
    const finish = (code, signal, extra = '') => {
      if (finished) return; finished = true; clearTimeout(timer);
      done({ code, signal, timedOut, stdout, stderr: stderr + extra, durationMs: Date.now() - started });
    };
    const keepTail = (current, chunk) => { const next = current + chunk; return next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next; };
    const timer = setTimeout(() => {
      timedOut = true;
      // 连同它启动的子进程一起结束，避免超时的测试继续占用数据库连接。
      try { if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* 进程已结束 */ } }
    }, timeoutMs);
    try {
      child = spawn(command, args, { cwd, env, detached: !windows, shell: windows && (command === 'npm' || command === 'npx'), stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    } catch (error) { finish(null, null, `\n无法启动 ${command}：${error.message}`); return; }
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout = keepTail(stdout, chunk); });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr = keepTail(stderr, chunk); });
    child.on('error', error => finish(null, null, `\n无法启动 ${command}：${error.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  // 本脚本自身可能在 node --test 里被调用；去掉这个变量，子进程才会输出正常的 TAP 汇总。
  delete env.NODE_TEST_CONTEXT;
  for (const key of HOST_ENV_KEYS) delete env[key];
  return env;
}
const tail = (text, lines) => text.split(/\r?\n/).slice(-lines).join('\n');
const seconds = milliseconds => `${(milliseconds / 1000).toFixed(1)}s`;

async function runSequential(root, group, runner, items, context, workingDirectory = '.') {
  const results = [];
  const cwd = join(root, workingDirectory);
  const python = process.env.BONDBUDDY_TEST_PYTHON || process.env.BB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const pythonPath = [join(root, 'python'), join(root, 'python/tests'), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  for (const [index, item] of items.entries()) {
    const label = `[${group} ${index + 1}/${items.length}] ${item.id}`;
    if (Date.now() > context.deadline) {
      results.push({ id: item.id, status: 'failed', reason: '本分片的总时间预算已用完，没有运行（请增加分片数）', tests: 0, skipped: 0, durationMs: 0 });
      console.log(`未运行 ${label}`); continue;
    }
    let execution, evaluated, capability;
    try { capability = capabilityEnvironment(item.id, childEnvironment(), context.capabilities); }
    catch (error) {
      results.push({ id: item.id, status: 'failed', reason: `能力准备无效：${error.message}`, tests: 0, skipped: 0, durationMs: 0 });
      continue;
    }
    if (context.host?.entries.has(item.id)) {
      try {
        const response = await requestHostExecution(context.host, item.id, context.deadline);
        execution = response.execution;
        evaluated = runner === 'node' ? evaluateNode(execution) : evaluatePython(execution);
        if (response.infrastructure_error) { evaluated.status = 'failed'; evaluated.reason = `能力准备无效：${response.infrastructure_error}`; }
        Object.assign(context.host.records.at(-1), { status: evaluated.status, tests: evaluated.tests, skipped: evaluated.skipped });
      } catch (error) {
        execution = { code: null, signal: null, timedOut: false, stdout: '', stderr: error.message, durationMs: 0 };
        evaluated = { status: 'failed', reason: `能力调度失败：${error.message}`, tests: 0, skipped: 0 };
      }
    } else if (runner === 'node') {
      if (!existsSync(join(root, item.run))) {
        results.push({ id: item.id, status: 'failed', reason: `找不到编译产物 ${item.run}（是否先执行了 npm run build）`, tests: 0, skipped: 0, durationMs: 0 });
        console.log(`失败   ${label}：找不到 ${item.run}`); continue;
      }
      execution = await execute(process.execPath, ['--test', '--test-reporter=tap', join(root, item.run)], { cwd, env: capability.env, timeoutMs: context.fileTimeoutMs });
      evaluated = evaluateNode(execution);
    } else {
      execution = await execute(python, ['-m', 'unittest', '-v', basename(item.run, '.py')], { cwd, env: { ...capability.env, PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }, timeoutMs: context.fileTimeoutMs });
      evaluated = evaluatePython(execution);
    }
    results.push({ id: item.id, ...evaluated, durationMs: execution.durationMs });
    if (capability.record) context.capabilityRuns.push({ ...capability.record, status: evaluated.status, tests: evaluated.tests, skipped: evaluated.skipped });
    const note = evaluated.status === 'passed' ? (evaluated.skipped ? `通过（跳过 ${evaluated.skipped} 项）` : '通过') : `失败：${evaluated.reason}`;
    console.log(`${evaluated.status === 'passed' ? '通过  ' : '失败  '} ${label} ${seconds(execution.durationMs)}${evaluated.status === 'passed' && !evaluated.skipped ? '' : ` — ${note}`}`);
    if (evaluated.status === 'failed' || evaluated.skipped) {
      const output = `${execution.stdout}\n${execution.stderr}`;
      const logFile = join(context.out, 'logs', `${item.id.replaceAll('/', '__')}.log`);
      mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(logFile, output);
      if (evaluated.status === 'failed') console.log(tail(output, 40).split('\n').map(line => `    | ${line}`).join('\n'));
    }
  }
  return { results, problems: [] };
}
async function runBrowser(root, items, context) {
  const reportFile = join(context.out, 'playwright-report.json');
  // Unmanaged developer invocations retain the existing command and judge.
  if (!process.env.PR_GATE_BROWSER_PLAN) {
    let execution, runtimeError;
    try { const invocation = browserInvocation(items, reportFile, childEnvironment());
      execution = await execute(invocation.command, invocation.args, { cwd: join(root, 'apps/web'), env: invocation.env, timeoutMs: Math.max(context.deadline - Date.now(), 60_000), inherit: true });
    } catch (error) { runtimeError = error.message; execution ??= { code: null, timedOut: false }; }
    let report = null; try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { /* missing reports fail below */ }
    const result = evaluatePlaywright(report, items, execution); if (runtimeError) result.problems.push('Browser runtime preparation/cleanup failed: ' + runtimeError);
    for (const row of result.results) row.durationMs = 0; return result;
  }

  const dispatch = createBrowserDispatch(items.map(({ id }) => ({ id }))); verifyBrowserDispatch(dispatch, items.map(({ id }) => ({ id })));
  const calls = [], reports = [], executions = [], problems = [];
  let runtime, runtimeError;
  try {
    runtime = await startBrowserRuntime(root, items, childEnvironment(), context.deadline);
    context.browserRuntime = { ...runtime.evidence, dispatch, invocations: calls };
    for (const group of dispatch) {
      const remaining = historicalRemaining(context.deadline), partFile = join(context.out, `playwright-report-${group.id}.json`);
      const env = { ...runtime.env, BB_E2E_BASE_URL: group.origin };
      for (const value of Object.values(HISTORICAL_COLLECTORS)) delete env[value.flag];
      if (group.flag) env[group.flag] = '1';
      const standard = browserInvocation(group.items, partFile, env);
      const privateCollector = group.id === 'qa' ? runtime.evidence.historical_apps.find(app => app.id === 'qa')?.collector : null;
      if (group.id === 'qa') assert.ok(privateCollector, 'QA private collector was not prepared');
      const invocation = privateCollector ? { command: privateCollector.command, args: privateCollector.args, env: standard.env } : standard;
      const call = { id: group.id, files: group.items.map(row => row.id), command: invocation.command, args: invocation.args, cwd: privateCollector?.cwd ?? join(root, 'apps/web'),
        environment: { BB_E2E_BASE_URL: env.BB_E2E_BASE_URL, ...(group.flag ? { [group.flag]: '1' } : {}) },
        report_file: partFile, timeout_ms: remaining, started_at: new Date().toISOString() };
      calls.push(call);
      const execution = await execute(invocation.command, invocation.args, { cwd: call.cwd, env: invocation.env, timeoutMs: remaining, inherit: true });
      executions.push(execution); Object.assign(call, { finished_at: new Date().toISOString(), exit_code: execution.code, timed_out: execution.timedOut });
      let report = null;
      try { const bytes = readFileSync(partFile); call.report_raw_sha256 = browserHash(bytes); report = JSON.parse(bytes); call.report_sha256 = browserHash(report); }
      catch (error) { problems.push(`${group.id} report missing or invalid: ${error.message}`); }
      reports.push({ id: group.id, report });
      // Save both evidence channels independently: a truncated direct PNG must
      // not prevent preservation of the native failure output (or vice versa).
      try { call.output_archive = archiveBrowserOutput({ destination: join(context.out, `playwright-output-${group.id}`), report, evidenceRoot: runtime.plan.output_root }); }
      catch (error) { call.output_archive_error = error.message; problems.push(`${group.id} output archive failed: ${error.message}`); }
      if (group.id === 'qa') try { call.qa_screenshots = captureQaScreenshots(runtime.plan); }
      catch (error) { call.qa_screenshots_error = error.message; problems.push(`qa direct screenshot archive failed: ${error.message}`); }
    }
  } catch (error) { runtimeError = error.message; if (error.browserRuntimeEvidence) context.browserRuntime = { ...error.browserRuntimeEvidence, dispatch, invocations: calls }; }
  finally {
    if (runtime) try { const final = await runtime.cleanup(); context.browserRuntime = { ...final, dispatch, invocations: calls,
      ...(calls.length === 1 ? { invocation: calls[0] } : {}), deadline: new Date(context.deadline).toISOString() }; }
    catch (error) { if (error.browserRuntimeEvidence) context.browserRuntime = { ...error.browserRuntimeEvidence, dispatch, invocations: calls }; runtimeError = [runtimeError, error.message].filter(Boolean).join('; '); }
  }
  let evaluated;
  try {
    const report = mergeBrowserReports(reports, dispatch, runtime?.plan); writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    if (context.browserRuntime) context.browserRuntime.report = { file: reportFile, sha256: browserHash(readFileSync(reportFile)), dispatch: report.config.pr_gate_dispatch };
    evaluated = evaluatePlaywright(report, items, { code: executions.length === dispatch.length && executions.every(row => row.code === 0 && !row.timedOut) ? 0 : 1,
      timedOut: executions.some(row => row.timedOut) });
  } catch (error) {
    // Preserve each actual failed/partial report; unstarted files remain failed.
    problems.push('Complete browser report aggregation failed: ' + error.message);
    evaluated = { results: [], problems: [] };
    for (const [index, group] of dispatch.entries()) {
      const selected = group.items.map(row => items.find(item => item.id === row.id));
      const part = evaluatePlaywright(reports.find(row => row.id === group.id)?.report ?? null, selected, executions[index] ?? { code: null, timedOut: false });
      evaluated.results.push(...part.results); evaluated.problems.push(...part.problems);
    }
  }
  evaluated.problems.push(...problems);
  if (runtimeError) evaluated.problems.push('Browser runtime preparation/cleanup failed: ' + runtimeError);
  for (const result of evaluated.results) result.durationMs = 0;
  return evaluated;
}

// ---------------------------------------------------------------- 汇总输出

function markdownSummary(summary) {
  const lines = [`### 合并前检查：${summary.job} — ${summary.status === 'passed' ? '通过' : '未通过'}${summary.report ? '（仅报告，不拦合并）' : ''}`, '',
    `运行 ${summary.counts.selected} 个测试文件：通过 ${summary.counts.passed}，拦合并 ${summary.counts.blocking}，已知失败 ${summary.counts.tolerated}，不在检查里 ${summary.counts.notInCi}。`, ''];
  const section = (title, rows, render) => { if (rows.length) lines.push(`**${title}**`, '', ...rows.map(render), ''); };
  section('配置问题（必须先处理）', summary.problems, problem => `- ${problem}`);
  section('拦住合并的测试', summary.blocking, row => `- \`${row.id}\` — ${row.why}`);
  section('已知失败（未拦合并）', summary.tolerated, row => `- \`${row.id}\` — ${row.why}`);
  section('已恢复通过，可以移出 knownFailing', summary.recovered, row => `- \`${row.id}\``);
  section('最慢的测试文件', summary.slowest, row => `- \`${row.id}\` ${seconds(row.durationMs)}`);
  return lines.join('\n');
}
function publish(summary, out, name) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `summary-${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = markdownSummary(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  console.log(`\n${markdown.replace(/[*`#]/g, '')}`);
}

// ---------------------------------------------------------------- 命令

function parseArguments(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { options._.push(argument); continue; }
    const key = argument.slice(2);
    if (['report', 'list'].includes(key)) options[key] = true;
    else { if (index + 1 >= argv.length) throw new Error(`--${key} 缺少取值`); options[key] = argv[++index]; }
  }
  return options;
}
function loadExclusions(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`读不了例外清单 ${file}：${error.message}`); }
  return parseExclusions(raw);
}

async function commandRun(options) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const exclusionsFile = resolve(options.exclusions ?? join(root, 'scripts/pr-gate/exclusions.json'));
  const lists = loadExclusions(exclusionsFile);
  const groups = String(options.group ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (!groups.length) throw new Error(`请用 --group 指定分组：${Object.keys(GROUPS).join('、')}`);
  for (const name of groups) if (!GROUPS[name]) throw new Error(`不认识的分组 ${name}；可用：${Object.keys(GROUPS).join('、')}`);
  const shard = /^(\d+)\/(\d+)$/.exec(options.shard ?? '1/1');
  if (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])) throw new Error('--shard 的格式是 1/2 这样的“第几片/共几片”');
  const [shardIndex, shardTotal] = [Number(shard[1]), Number(shard[2])];
  const name = options.name ?? `${groups.join('+')}-${shardIndex}of${shardTotal}`;
  const expectedJobs = options.jobs === undefined ? null : Number(options.jobs);
  if (expectedJobs !== null && (!Number.isInteger(expectedJobs) || expectedJobs < 1)) throw new Error('--jobs 必须是正整数（本次检查一共有几个分片）');
  const out = resolve(options.out ?? join(root, '.local/pr-gate'));
  const fileTimeoutMs = Number(options['file-timeout-minutes'] ?? 5) * 60_000;
  const deadline = Date.now() + Number(options['budget-minutes'] ?? 70) * 60_000;
  if (!(fileTimeoutMs > 0) || !Number.isFinite(deadline)) throw new Error('超时参数必须是正数');

  const discovered = Object.fromEntries(Object.entries(GROUPS).map(([group, definition]) => [group, definition.discover(root)]));
  const everyId = Object.values(discovered).flat().map(item => item.id);
  const problems = [];
  // 清单里的条目必须对得上真实存在的测试文件，否则清单会悄悄过期。
  for (const list of LISTS) for (const entry of lists[list]) {
    if (!everyId.some(id => entry.expression.test(id))) problems.push(`例外清单 ${list} 里的 \`${entry.pattern}\` 没有匹配到任何测试文件，请删除或改正`);
  }
  const plan = groups.map(group => {
    if (!discovered[group].length) problems.push(`分组 ${group} 没有发现任何测试文件`);
    const active = discovered[group].filter(item => !matchEntry(lists.notInCi, item.id));
    // 不在检查里的文件不参与分片；只在第 1 片计数，合并各分片时才不会重复统计。
    return { group, runner: GROUPS[group].runner, prepare: GROUPS[group].prepare, cwd: GROUPS[group].cwd, notInCi: shardIndex === 1 ? discovered[group].length - active.length : 0,
      selected: active.filter((_, index) => index % shardTotal === shardIndex - 1) };
  });

  if (options.list) {
    for (const part of plan) {
      console.log(`# ${part.group}：发现 ${discovered[part.group].length} 个，不在检查里 ${part.notInCi} 个，本分片运行 ${part.selected.length} 个`);
      for (const item of part.selected) console.log(item.id);
    }
    for (const problem of problems) console.error(`配置问题：${problem}`);
    return problems.length ? 1 : 0;
  }

  mkdirSync(out, { recursive: true });
  const results = [];
  const capabilities = process.env.PR_GATE_CAPABILITIES_FILE ? verifyPreparedCapabilities(JSON.parse(readFileSync(process.env.PR_GATE_CAPABILITIES_FILE, 'utf8')), { commit: process.env.GITHUB_SHA, tree: process.env.PR_GATE_TREE }) : null;
  const host = initializeHostClient({ root, candidate: { commit: process.env.GITHUB_SHA, tree: process.env.PR_GATE_TREE }, shard: name, parts: plan, fileTimeoutMs });
  const context = { out, fileTimeoutMs, deadline, capabilities, capabilityRuns: [], host };
  for (const part of plan) {
    if (!part.selected.length) continue;
    console.log(`\n===== ${part.group}：运行 ${part.selected.length} 个测试文件 =====`);
    if (part.prepare) {
      const prepared = await execute(part.prepare.command, part.prepare.args, { cwd: root, env: childEnvironment(), timeoutMs: 10 * 60_000, inherit: true });
      if (prepared.code !== 0) {
        problems.push(`${part.prepare.label}失败（退出码 ${prepared.code ?? '无'}）`);
        for (const item of part.selected) results.push({ id: item.id, status: 'failed', reason: `${part.prepare.label}失败`, tests: 0, skipped: 0, durationMs: 0 });
        continue;
      }
    }
    const outcome = part.runner === 'playwright' ? await runBrowser(root, part.selected, context) : await runSequential(root, part.group, part.runner, part.selected, context, part.cwd);
    results.push(...outcome.results); problems.push(...outcome.problems);
  }

  const verdict = judge(results, lists, problems);
  const summary = {
    schema: SUMMARY_SCHEMA, job: name, groups, shard: `${shardIndex}/${shardTotal}`, expectedJobs, report: Boolean(options.report),
    commit: process.env.GITHUB_SHA ?? null, finishedAt: new Date().toISOString(), status: verdict.status,
    capabilities: context.capabilityRuns,
    host_dispatch: host?.records ?? [],
    ...(context.browserRuntime ? { browser_runtime: context.browserRuntime } : {}),
    counts: { selected: results.length, passed: verdict.passed, blocking: verdict.blocking.length, tolerated: verdict.tolerated.length, notInCi: plan.reduce((total, part) => total + part.notInCi, 0) },
    problems: verdict.problems, blocking: verdict.blocking, tolerated: verdict.tolerated, recovered: verdict.recovered, skipsAllowed: verdict.skipsAllowed,
    slowest: [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10).filter(row => row.durationMs >= 5000).map(row => ({ id: row.id, durationMs: row.durationMs })),
    // 首次启用时可直接采用：把当前拦住合并的文件登记进例外清单。
    suggestion: { knownFailing: verdict.blocking.filter(row => row.kind === 'failed').map(row => row.id), allowSkip: verdict.blocking.filter(row => row.kind === 'skipped').map(row => row.id) },
  };
  publish(summary, out, name);
  if (summary.status === 'failed' && options.report) console.log('\n仅报告模式：以上问题不改变退出码。');
  return summary.status === 'passed' || options.report ? 0 : 1;
}

function findSummaries(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findSummaries(path));
    else if (/^summary-.*\.json$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}
/** 最后一步：确认每个分片都交了结果并且都通过；同时生成一份可直接采用的例外清单建议。 */
function commandMerge(options) {
  if (!options._[0]) throw new Error('请给出各分片结果所在的目录');
  const directory = resolve(options._[0]);
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const out = resolve(options.out ?? directory);
  mkdirSync(out, { recursive: true });
  // 目录不存在说明没有任何分片交出结果，按“未通过”处理，而不是报错退出。
  const summaries = (existsSync(directory) ? findSummaries(directory) : []).map(path => JSON.parse(readFileSync(path, 'utf8'))).filter(summary => summary.schema === SUMMARY_SCHEMA);
  const problems = [];
  const names = summaries.map(summary => summary.job);
  if (new Set(names).size !== names.length) problems.push('有重名的分片结果');
  // 应有的分片数：优先用 --expect；否则用各分片自己记录的总数（来自工作流的矩阵行数）。
  let expected = null;
  if (options.expect !== undefined) {
    expected = Number(options.expect);
    if (!Number.isInteger(expected) || expected < 1) throw new Error('--expect 必须是正整数');
  } else {
    const recorded = new Set(summaries.map(summary => summary.expectedJobs));
    if (recorded.size === 1 && Number.isInteger([...recorded][0])) expected = [...recorded][0];
    else problems.push(summaries.length ? '各分片没有记录一致的分片总数，无法确认是否有分片缺失' : '没有收到任何分片的结果（很可能在安装或构建阶段就失败了）');
  }
  if (expected !== null && summaries.length !== expected) problems.push(`应有 ${expected} 个分片的结果，实际收到 ${summaries.length} 个（缺少的分片很可能在安装或构建阶段就失败了）`);
  const commits = new Set(summaries.map(summary => summary.commit).filter(Boolean));
  if (commits.size > 1) problems.push('各分片的结果不是同一个提交');
  const failed = summaries.filter(summary => summary.status !== 'passed');
  const status = problems.length || failed.length ? 'failed' : 'passed';
  const total = key => summaries.reduce((sum, summary) => sum + summary.counts[key], 0);

  const suggestion = { knownFailing: [...new Set(summaries.flatMap(summary => summary.suggestion.knownFailing))].sort(), allowSkip: [...new Set(summaries.flatMap(summary => summary.suggestion.allowSkip))].sort() };
  const lines = [`## 合并前检查：${status === 'passed' ? '通过' : '未通过'}${options.report ? '（仅报告）' : ''}`, '',
    `共 ${summaries.length}/${expected ?? '?'} 个分片，运行 ${total('selected')} 个测试文件：通过 ${total('passed')}，拦合并 ${total('blocking')}，已知失败 ${total('tolerated')}，不在检查里 ${total('notInCi')}。`, ''];
  for (const problem of problems) lines.push(`- ${problem}`);
  for (const summary of failed) lines.push(`- 分片 \`${summary.job}\` 未通过：拦合并 ${summary.counts.blocking} 个，配置问题 ${summary.problems.length} 个`);
  const recovered = [...new Set(summaries.flatMap(summary => summary.recovered.map(row => row.id)))].sort();
  if (recovered.length) lines.push('', '**已恢复通过，可以移出 knownFailing：**', ...recovered.map(id => `- \`${id}\``));

  if (suggestion.knownFailing.length || suggestion.allowSkip.length) {
    const exclusionsFile = resolve(options.exclusions ?? join(root, 'scripts/pr-gate/exclusions.json'));
    let current = {};
    try { current = JSON.parse(readFileSync(exclusionsFile, 'utf8')); } catch { /* 没有现成清单时从空清单开始 */ }
    const stamp = `${new Date().toISOString().slice(0, 10)}${commits.size === 1 ? ` ${[...commits][0].slice(0, 12)}` : ''}`;
    const proposed = { ...current };
    for (const list of ['knownFailing', 'allowSkip']) {
      const existing = new Set((current[list] ?? []).map(entry => entry.pattern));
      proposed[list] = [...(current[list] ?? []), ...suggestion[list].filter(id => !existing.has(id)).map(id => ({ pattern: id,
        reason: list === 'knownFailing' ? `首次全量运行未通过，待修复或确认（${stamp}）` : `首次全量运行有跳过项，待确认是否应当运行（${stamp}）` }))];
    }
    for (const list of LISTS) proposed[list] ??= [];
    writeFileSync(join(out, 'exclusions.suggested.json'), `${JSON.stringify(proposed, null, 2)}\n`);
    lines.push('', `**建议登记进例外清单：** 失败 ${suggestion.knownFailing.length} 个，有跳过 ${suggestion.allowSkip.length} 个。`,
      '完整建议见本次运行附件里的 `exclusions.suggested.json`。逐条确认后替换 `scripts/pr-gate/exclusions.json`；能修的优先修，不要整份照搬后就不再处理。');
  }
  const markdown = lines.join('\n');
  writeFileSync(join(out, 'pr-gate-result.json'), `${JSON.stringify({ schema: 'pr-gate-result-v1', status, report: Boolean(options.report), expected, received: summaries.length, problems, failed: failed.map(summary => summary.job), suggestion }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown.replace(/[*`#]/g, ''));
  return status === 'passed' || options.report ? 0 : 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  if (command === 'run') return commandRun(options);
  if (command === 'merge') return commandMerge(options);
  throw new Error('用法：node scripts/pr-gate/run.mjs run --group <分组> [--shard 1/2] [--report] [--list]\n      node scripts/pr-gate/run.mjs merge <结果目录> [--expect <分片数>] [--report]');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`合并前检查无法运行：${error.message}`); process.exitCode = 2; });
}
