#!/usr/bin/env node
// Static validation of the committed blank planning artifacts. No product tests,
// network requests, file writes, execution reports or readiness decisions occur.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../../..");
const referenceSha = "a6fa7eb030f7f9bc4c803176b2aacf38d35642b6";
const expectedIds = Array.from({ length: 79 }, (_, index) => "BB-" + String(index + 1).padStart(3, "0"));
const expectedGoals = ["G1", "G2", "G3", "G4", "G5"];
const expectedPackages = ["U-A", "U-B", "U-C", "U-D", "U-E", "U-F", "U-G"];
const expectedHuman = ["U-H-flow", "U-H-content", "U-H-client"];
const errors = [];
const warnings = [];
const metrics = {};
const knownIds = new Set(expectedIds);
const checkedSourceFiles = new Set();
const checkedLinks = new Set();
const check = (condition, message) => { if (!condition) errors.push(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const list = value => Array.isArray(value) ? value : [];
const labels = {
  "Agent独立": "agent_independent",
  "必须Human": "human_required",
  "Agent预检＋Human验收": "agent_then_human"
};

function read(name, json = false) {
  try {
    const text = fs.readFileSync(path.join(packageRoot, name), "utf8").replace(/^\uFEFF/, "");
    return json ? JSON.parse(text) : text;
  } catch (error) {
    errors.push(name + ": " + error.message);
    return null;
  }
}

function insideRepo(absolute) {
  const relative = path.relative(repoRoot, absolute);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function repoFile(relative, context, allowDirectory = false) {
  if (typeof relative !== "string" || !relative || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative) ||
      path.posix.isAbsolute(relative) || relative.includes("\\")) {
    errors.push(context + ": expected a portable repository-relative POSIX path");
    return;
  }
  const absolute = path.resolve(repoRoot, relative);
  if (!insideRepo(absolute)) {
    errors.push(context + ": path escapes the repository");
    return;
  }
  try {
    const stat = fs.statSync(absolute);
    check(allowDirectory || stat.isFile(), context + ": expected a file: " + relative);
    checkedSourceFiles.add(relative);
  } catch {
    errors.push(context + ": missing repository path: " + relative);
  }
}

function sourceUrl(url, context) {
  const source = url.match(/^https:\/\/github\.com\/ITSophiaXu\/BondBuddy\/(blob|tree)\/([^/]+)(?:\/([^?#]*))?(?:[?#].*)?$/) ||
    url.match(/^https:\/\/raw\.githubusercontent\.com\/ITSophiaXu\/BondBuddy\/()([^/]+)\/([^?#]+)(?:[?#].*)?$/);
  if (!source) return false;
  check(source[2] === referenceSha, context + ": source evidence must use the frozen full SHA, not a branch/tag/short SHA");
  let relative;
  try { relative = decodeURIComponent(source[3] || ""); }
  catch { errors.push(context + ": malformed URL encoding"); return true; }
  if (relative) repoFile(relative, context, source[1] === "tree");
  return true;
}

function markdownLinks(markdown, name) {
  for (const match of markdown.matchAll(/\]\(([^)\r\n]+)\)/g)) {
    let href = match[1].trim();
    if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
    href = href.replace(/\s+"[^"]*"$/, "");
    checkedLinks.add(href);
    if (/^[A-Za-z]:[\\/]|^file:\/\//i.test(href)) {
      errors.push(name + ": personal/local file link is not portable");
    } else if (/^https?:\/\//.test(href)) {
      sourceUrl(href, name);
    } else if (href && !href.startsWith("#") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
      let relative;
      try { relative = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
      catch { errors.push(name + ": malformed relative link"); continue; }
      const absolute = path.resolve(packageRoot, relative);
      check(insideRepo(absolute), name + ": relative link escapes the repository");
      check(fs.existsSync(absolute), name + ": missing relative link " + relative);
    }
  }
}

function walk(value, visit, location = "$") {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, location + "[" + index + "]"));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, location + "." + key);
      walk(item, visit, location + "." + key);
    }
  }
}

function checkIds(ids, context) {
  check(Array.isArray(ids), context + ": expected an array");
  for (const id of list(ids)) check(knownIds.has(id), context + ": unknown case " + id);
  check(new Set(list(ids)).size === list(ids).length, context + ": duplicate case IDs");
}

function blankItems(items, context) {
  for (const [index, item] of list(items).entries()) {
    check(item.status === "not_run", context + "[" + index + "]: unexpected execution status");
    if (Object.hasOwn(item, "evidence")) check(list(item.evidence).length === 0, context + ": initial evidence must be empty");
    if (Object.hasOwn(item, "controlled_evidence")) check(list(item.controlled_evidence).length === 0, context + ": initial controlled evidence must be empty");
  }
}

const plan = read("test-plan.md");
const registry = read("regression-registry.json", true);
const baseline = read("release-baseline-template.json", true);
const execution = read("execution-report-template.json", true);

if (plan && registry && baseline && execution) {
  // Portable paths and honest initial state. Historical CI receipts may still
  // contain COMPLETED/SUCCESS; they are not candidate execution results.
  for (const [name, document] of Object.entries({
    "regression-registry.json": registry,
    "release-baseline-template.json": baseline,
    "execution-report-template.json": execution
  })) {
    walk(document, (key, value, location) => {
      if (typeof value === "string") {
        check(!/\b[A-Za-z]:[\\/]|file:\/\//i.test(value), name + location + ": personal filesystem path");
        if (/^https:\/\//.test(value)) sourceUrl(value, name + location);
      }
      if (["ready", "actual_ready", "eligible", "public_release_eligible", "public_release_approved", "required_results_reviewed",
        "executed_this_session", "product_tests_executed_this_session", "product_tests_executed",
        "invitation_messages_sent", "inventory_complete", "regression_inventory_complete"].includes(key)) {
        check(value === false, name + location + ": the committed initial artifact must not claim readiness, execution or approval");
      }
      if (key === "eligible_by_gate" && value && typeof value === "object")
        for (const [gate, eligible] of Object.entries(value)) check(eligible === false, name + location + "." + gate + ": must be false");
    });
  }
  check(!/\b[A-Za-z]:[\\/]|file:\/\//i.test(plan), "test-plan.md: personal filesystem path");
  markdownLinks(plan, "test-plan.md");

  const rows = plan.split(/\r?\n/).filter(line => /^\| BB-\d{3} P[0-3] /.test(line));
  const ids = rows.map(row => row.match(/^\| (BB-\d{3}) /)[1]);
  check(same(ids, expectedIds), "Plan case rows must be exactly BB-001..BB-079 once, in order");
  metrics.case_count = ids.length;
  const caseGoals = {};
  const ownership = { agent_independent: [], human_required: [], agent_then_human: [] };
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map(cell => cell.trim());
    check(cells.length === 4 && cells.every(Boolean), "Plan case row has missing fields: " + cells[0]);
    const details = cells[0].match(/^(BB-\d{3}) P[0-3] (G[1-5](?:\/G[1-5])*)$/);
    check(!!details, "Invalid case priority/goals: " + cells[0]);
    if (!details) continue;
    const [id, goalText] = [details[1], details[2]];
    caseGoals[id] = goalText.split("/");
    const category = labels[(cells[3] || "").split(" / ")[0]];
    check(!!category, "Missing explicit Agent/Human owner: " + id);
    if (category) ownership[category].push(id);
  }
  const expectedCounts = { agent_independent: 65, human_required: 3, agent_then_human: 11 };
  const testExecution = baseline.test_execution || {};
  check(same(testExecution.all_planned_test_ids, expectedIds), "Baseline planned IDs do not match the 79-case coverage pool");
  for (const [category, caseIds] of Object.entries(ownership)) {
    const declared = testExecution.execution_ownership?.[category];
    check(caseIds.length === expectedCounts[category], "Unexpected ownership count: " + category);
    check(declared?.count === caseIds.length && same(declared?.test_ids, caseIds), "Baseline ownership mismatch: " + category);
  }
  metrics.execution_ownership = Object.fromEntries(Object.entries(ownership).map(([category, caseIds]) => [category, caseIds.length]));
  check(same(baseline.business_test_goals?.definitions?.map(goal => goal.id), expectedGoals), "Business goals must be exactly G1..G5");
  for (const id of expectedIds)
    check(same(caseGoals[id], baseline.business_test_goals?.case_goal_map?.[id]), "Baseline goal mapping mismatch: " + id);
  const coverage = list(testExecution.business_goal_coverage);
  check(same(coverage.map(item => item.goal_id), expectedGoals), "Baseline goal coverage must contain G1..G5");
  for (const item of coverage) {
    check(same(item.test_ids, expectedIds.filter(id => caseGoals[id]?.includes(item.goal_id))), "Goal coverage mismatch: " + item.goal_id);
    check(item.status === "not_run", "Unexpected business goal execution claim: " + item.goal_id);
  }
  for (const [gate, selected] of Object.entries(testExecution.required_test_ids_by_gate || {})) {
    checkIds(selected, "Baseline coverage pool " + gate);
    if (gate === "engineering")
      check(!list(selected).some(id => ["BB-035", "BB-036", "BB-037", "BB-038", "BB-039"].includes(id)), "R-only case in engineering pool");
  }
  check(list(testExecution.required_test_ids).length === 0, "Committed baseline must leave actual required selection unfrozen");
  check(same(testExecution.reused_engineering_test_ids, testExecution.required_test_ids_by_gate?.engineering), "R engineering evidence reuse does not match its pool");
  for (const id of [...ownership.human_required, ...ownership.agent_then_human])
    check(list(testExecution.additional_execution_test_ids_by_gate?.real_acceptance).includes(id), "Missing R/Human increment: " + id);
  for (const pack of list(testExecution.shared_execution_packages)) checkIds(pack.test_ids, "Shared package " + pack.package_id);
  blankItems(testExecution.shared_execution_packages, "Shared execution packages");
  check(testExecution.trigger_rules?.performance?.proposed_thresholds_are_gates === false, "Unapproved latency thresholds must not be release gates");

  const entries = list(registry.entries);
  metrics.regression_entry_count = entries.length;
  check(entries.length === 39, "Registry must retain all 39 initial entries");
  check(new Set(entries.map(entry => entry.bug_id)).size === entries.length, "Duplicate registry bug IDs");
  for (const entry of entries) {
    checkIds(entry.test_ids, "Registry " + entry.bug_id);
    check(list(entry.goal_ids).includes("G4"), "Permanent regression lacks G4: " + entry.bug_id);
    check(entry.candidate_result === "not_run", "Registry unexpectedly claims a candidate result: " + entry.bug_id);
    check(entry.product_test_executed_this_session === false, "Registry unexpectedly claims product execution: " + entry.bug_id);
    for (const id of list(entry.test_ids))
      check(same(entry.case_goal_map?.[id], caseGoals[id]), "Registry goal mapping mismatch: " + entry.bug_id + "/" + id);
    check(Array.isArray(entry.suite_candidates) && entry.suite_candidates.length > 0, "Missing suite candidates: " + entry.bug_id);
    for (const file of list(entry.suite_candidates)) repoFile(file, "Registry suite " + entry.bug_id);
  }
  for (const document of [baseline, registry, execution]) {
    if (Object.hasOwn(document, "source_reference_sha"))
      check(document.source_reference_sha === referenceSha, "Historical source reference must retain the audited full SHA");
  }
  check(baseline.candidate?.git_sha === referenceSha, "Baseline candidate design reference must retain a6fa7eb, not imply a fresh runtime verification");
  check(baseline.billing?.candidate_expected_document_points === 4500, "Fixed document design price must be 4500");
  for (const migration of list(baseline.candidate?.required_migrations))
    repoFile("db/migrations/" + migration, "Required migration");
  for (const [gate, goalStatuses] of Object.entries(baseline.release_decision?.business_goal_status_by_gate || {})) {
    check(same(Object.keys(goalStatuses), expectedGoals), "Release goal keys mismatch for " + gate);
    for (const [goal, status] of Object.entries(goalStatuses)) check(status === "not_run", "Unexpected release goal result: " + gate + "/" + goal);
  }
  check(list(baseline.release_decision?.approvers).length === 0 && baseline.release_decision?.approved_at === null, "Blank baseline must not contain release approval");
  const counts = testExecution.counts || {};
  check(counts.passed === 0 && counts.failed === 0 && counts.blocked === 0 && counts.skipped === 0 && counts.not_run === 79, "Baseline initial counts must remain 79 not_run");

  const admission = testExecution.user_testing_admission || {};
  check(admission.status === "not_run" && admission.ready === false, "U must remain not_run and not ready");
  check(admission.does_not_require_complete_engineering_or_real_acceptance_gate === true, "U must remain independent of complete E/R");
  check(list(baseline.scope?.allowed_release_gates).includes("user_testing"), "Missing independent U gate");
  check(same(list(admission.packages).map(pack => pack.package_id), expectedPackages), "U must contain exactly U-A..U-G");
  check(same(list(admission.human_preflight).map(item => item.subcase_id), expectedHuman), "U must retain three Human preflight records");
  blankItems(admission.packages, "U baseline packages");
  blankItems(admission.human_preflight, "U baseline Human preflight");
  for (const pack of list(admission.packages)) {
    checkIds(pack.test_ids, "U baseline " + pack.package_id);
    check(Array.isArray(pack.required_subcases) && pack.required_subcases.length > 0, "Missing necessary U subcases: " + pack.package_id);
  }
  for (const item of list(admission.human_preflight)) checkIds(item.test_ids, "U Human " + item.subcase_id);
  metrics.user_testing_packages = list(admission.packages).length;
  metrics.user_testing_human_preflight = list(admission.human_preflight).length;

  check(execution.artifact_type === "execution_report_template", "Unexpected execution template type");
  check(execution.status === "not_run", "Execution report template must remain not_run");
  check(execution.selection?.frozen === false && execution.selection?.gate === null, "Committed report must not freeze actual U selection");
  check(list(execution.selection?.required_subcase_ids).length === 0, "Actual required U selection must be empty until frozen");
  check(same(list(execution.packages).map(pack => pack.package_id), expectedPackages), "Execution template must retain U-A..U-G");
  check(same(list(execution.human_preflight).map(item => item.subcase_id), expectedHuman), "Execution template must retain three U Human records");
  blankItems(execution.packages, "Execution report packages");
  blankItems(execution.human_preflight, "Execution report Human preflight");
  const reportSubcaseIds = [];
  for (const pack of list(execution.packages)) {
    const source = list(admission.packages).find(item => item.package_id === pack.package_id);
    check(same(pack.test_ids, source?.test_ids), "Execution package coverage mismatch: " + pack.package_id);
    check(same(list(pack.required_subcases).map(item => item.criterion), source?.required_subcases), "Execution package necessary subcases mismatch: " + pack.package_id);
    for (const item of list(pack.required_subcases)) {
      reportSubcaseIds.push(item.subcase_id);
      check(item.subcase_id.startsWith(pack.package_id + "-"), "Invalid report subcase ID: " + item.subcase_id);
      check(item.status === "not_run" && item.selected === false && item.selection_status === "unselected" && item.required === null,
        "Subcase must be initially unselected/not_run: " + item.subcase_id);
      for (const field of ["owner", "source", "config", "fixture", "run", "artifacts", "accounting", "controlled_evidence"])
        check(Object.hasOwn(item, field), "Missing result field " + field + ": " + item.subcase_id);
    }
    check(list(pack.additional_selected_subcases).length === 0, "Blank report must not preselect conditional additions");
  }
  check(new Set(reportSubcaseIds).size === reportSubcaseIds.length, "Duplicate report U subcase IDs");
  for (const item of list(execution.human_preflight)) {
    checkIds(item.test_ids, "Execution Human " + item.subcase_id);
    check(item.human_result === "not_run" && item.agent_precheck_status === "not_run", "Unexpected Human approval or Agent precheck");
    check(item.owner === null && item.reviewer_name === null && item.review_date === null, "Blank Human record must not name an approval");
  }
  for (const gate of ["user_testing", "engineering", "real_acceptance"]) {
    const goals = execution.business_goal_status_by_gate?.[gate] || {};
    check(same(Object.keys(goals), expectedGoals), "Execution report needs G1..G5 separately for " + gate);
    for (const [goal, item] of Object.entries(goals)) check(item.status === "not_run", "Unexpected execution goal result: " + gate + "/" + goal);
  }
  check(execution.decision?.status === "not_run" && execution.decision?.ready === false &&
    execution.decision?.actual_ready === false && execution.decision?.made_by === null &&
    execution.decision?.made_at === null, "Report must not infer or record an initial admission decision");
  check(list(execution.defects).length === 0 && list(execution.feedback_records).length === 0, "Blank template must not contain actual defects or user feedback");
  walk(execution, (key, value, location) => {
    if (["status", "human_result", "agent_precheck_status", "retest_status"].includes(key))
      check(value === "not_run", "Execution template unexpected result " + location);
  });
  warnings.push({
    code: "U_SELECTION_NOT_FROZEN",
    message: "Actual runtime, feature/market scope, owners and required U subcases are not frozen. Metadata pass does not permit an invitation or imply U readiness."
  });

  // The commands below are parsed only. Compiled/dist test references map to
  // checked source files; no npm, test runner, CLI or network operation is run.
  const commandSources = [...plan.matchAll(/(?:apps|packages)\/[A-Za-z0-9_./-]+\.test\.js/g)]
    .map(match => match[0].replace("/dist/", "/src/").replace(/\.js$/, ".ts"));
  for (const source of new Set(commandSources)) repoFile(source, "Reusable command source");
  const browserSpecs = new Set([...plan.matchAll(/\b[A-Za-z0-9_-]+\.spec\.ts\b/g)].map(match => match[0]));
  for (const spec of browserSpecs) repoFile("apps/web/tests/" + spec, "Browser command source");
  const pythonSources = [...plan.matchAll(/(?:python|apps|packages)\/[A-Za-z0-9_./-]+\.py\b/g)].map(match => match[0]);
  for (const source of new Set(pythonSources)) repoFile(source, "Python command/source");
  if (plan.includes("python/tests")) repoFile("python/tests", "Python discover directory", true);
  metrics.checked_command_source_files = new Set(commandSources).size;
  metrics.checked_browser_specs = browserSpecs.size;
  metrics.report_subcase_count = reportSubcaseIds.length;
}

process.stdout.write(JSON.stringify({
  purpose: "Static artifact consistency only; no product tests or readiness decision",
  reference_source_sha: referenceSha,
  metrics,
  checked_source_files: checkedSourceFiles.size,
  checked_markdown_links: checkedLinks.size,
  metadata_validation_result: errors.length ? "fail" : "pass",
  product_tests_executed: false,
  user_testing_ready: false,
  user_testing_selection_frozen: execution?.selection?.frozen === true,
  errors,
  warnings
}, null, 2) + "\n");
process.exitCode = errors.length ? 1 : 0;
