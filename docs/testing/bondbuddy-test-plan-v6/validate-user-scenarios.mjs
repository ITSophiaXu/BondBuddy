#!/usr/bin/env node
// Validate blank planning metadata only. No product tests, network calls, file
// writes, user-test selection, acceptance results or release decisions occur.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../../..");
const sourceSha = "2805b31eb081aef52f1cdb777b8cbf85aefd44c9";
const originalSha = "a6fa7eb030f7f9bc4c803176b2aacf38d35642b6";
const groups = { N: ["normal", 6], A: ["abnormal", 7], C: ["corner", 10] };
const expectedIds = Object.entries(groups).flatMap(([prefix, [, count]]) =>
  Array.from({ length: count }, (_, i) => "UX-" + prefix + String(i + 1).padStart(2, "0")));
const expectedBB = Array.from({ length: 79 }, (_, i) => "BB-" + String(i + 1).padStart(3, "0"));
const expectedU = ["U-A", "U-B", "U-C", "U-D", "U-E", "U-F", "U-G"];
const gapTypes = ["functional_gap", "design_gap", "usability_defect", "reliability_defect", "billing_defect"];
const errors = [];
const warnings = [];
const metrics = {};
const checkedLinks = new Set();
const checkedSources = new Set();
const check = (condition, message) => { if (!condition) errors.push(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const list = value => Array.isArray(value) ? value : [];

function read(name, json = false) {
  try {
    const content = fs.readFileSync(path.join(packageRoot, name), "utf8").replace(/^\uFEFF/, "");
    return json ? JSON.parse(content) : content;
  } catch (error) {
    errors.push(name + ": " + error.message);
    return null;
  }
}

function inside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function sourcePath(relative, context, directoryAllowed = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative) || path.posix.isAbsolute(relative)) {
    errors.push(context + ": source path must be repository-relative and portable");
    return;
  }
  const absolute = path.resolve(repoRoot, relative);
  check(inside(repoRoot, absolute), context + ": source path escapes repository");
  if (!inside(repoRoot, absolute)) return;
  try {
    const stat = fs.statSync(absolute);
    check(directoryAllowed || stat.isFile(), context + ": expected source file " + relative);
    checkedSources.add(relative);
  } catch { errors.push(context + ": missing source path " + relative); }
}

function validateLinks(markdown) {
  for (const match of markdown.matchAll(/\]\(([^)\r\n]+)\)/g)) {
    const href = match[1].trim().replace(/^<(.*)>$/, "$1").replace(/\s+"[^"]*"$/, "");
    checkedLinks.add(href);
    if (/^https?:\/\//i.test(href)) {
      const parsed = href.match(/^https:\/\/github\.com\/ITSophiaXu\/BondBuddy\/(blob|tree)\/([^/]+)(?:\/([^?#]*))?(?:[?#].*)?$/);
      check(!!parsed, "Scenario source link must be a pinned BondBuddy blob/tree URL: " + href);
      if (!parsed) continue;
      check(parsed[2] === sourceSha, "Scenario source link must use the new full reference SHA: " + href);
      if (parsed[3]) {
        try { sourcePath(decodeURIComponent(parsed[3]), "Scenario source link", parsed[1] === "tree"); }
        catch { errors.push("Scenario source link has malformed URL encoding"); }
      }
    } else if (!href.startsWith("#")) {
      check(!/^[A-Za-z][A-Za-z0-9+.-]*:|^[\\/]/.test(href), "Scenario link must be package-relative: " + href);
      try {
        const absolute = path.resolve(packageRoot, decodeURIComponent(href.split(/[?#]/, 1)[0]));
        check(inside(packageRoot, absolute), "Scenario link escapes its package: " + href);
        check(fs.existsSync(absolute) && fs.statSync(absolute).isFile(), "Missing package link: " + href);
      } catch { errors.push("Invalid package link: " + href); }
    }
  }
}

const markdown = read("user-scenarios.md");
const template = read("user-scenario-result-template.json", true);
const plan = read("test-plan.md");
const baseline = read("release-baseline-template.json", true);

if (markdown && template && plan && baseline) {
  const bbIds = [...plan.matchAll(/^\| (BB-\d{3}) P[0-3] /gm)].map(match => match[1]);
  const uIds = list(baseline.test_execution?.user_testing_admission?.packages).map(item => item.package_id);
  check(same(bbIds, expectedBB), "Original engineering plan must contain exactly BB-001..BB-079 once");
  check(same(uIds, expectedU), "Original baseline must contain U-A..U-G once");
  const knownBB = new Set(bbIds);
  const knownU = new Set(uIds);
  metrics.original_bb_cases = bbIds.length;
  metrics.original_u_packages = uIds.length;

  check(template.artifact_type === "user_scenario_result_template" && template.schema_version === 1, "Unexpected scenario template schema");
  check(template.source_reference_sha === sourceSha && template.original_plan_source_reference_sha === originalSha, "Scenario source references drifted");
  check(template.scenario_file === "user-scenarios.md" && template.engineering_plan_file === "test-plan.md", "Scenario file mappings drifted");
  check(template.status === "not_run" && template.product_tests_executed === false && template.user_testing_ready === false, "Template must not claim execution or readiness");
  check(same(template.allowed_statuses, ["not_run", "pass", "fail", "blocked", "skipped", "N/A"]), "Unexpected allowed execution statuses");
  const selection = template.selection || {};
  check(selection.frozen === false, "Scenario selection must remain unfrozen");
  for (const key of ["gate", "tested_url", "actual_web_sha", "actual_api_sha", "configuration_receipt", "owner"])
    check(selection[key] === null, "Initial selection must leave " + key + " unset");
  for (const key of ["worker_images", "feature_market_scope", "effective_price_versions", "fixture_manifests", "selected_scenario_subcases"])
    check(Array.isArray(selection[key]) && selection[key].length === 0, "Initial selection must leave " + key + " empty");

  const headings = [...markdown.matchAll(/^### (UX-[NAC]\d{2}) (.+)$/gm)];
  const mdIds = headings.map(match => match[1]);
  const catalog = list(template.scenario_catalog);
  check(same(mdIds, expectedIds), "Markdown must contain 23 unique ordered scenario IDs (N01..06, A01..07, C01..10)");
  check(same(catalog.map(item => item.scenario_id), expectedIds), "JSON catalog must match all 23 unique ordered scenario IDs");
  check(new Set(catalog.map(item => item.scenario_id)).size === 23, "Scenario IDs must be unique");
  metrics.scenario_count = catalog.length;
  metrics.category_counts = {};

  for (const [prefix, [category, count]] of Object.entries(groups)) {
    metrics.category_counts[category] = catalog.filter(item => item.category === category).length;
    check(metrics.category_counts[category] === count, "Incorrect " + category + " category count");
  }
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const id = heading[1];
    const context = id + ": ";
    const scenario = catalog.find(item => item.scenario_id === id);
    const block = markdown.slice(heading.index, headings[i + 1]?.index ?? markdown.length).split(/^## /m)[0];
    if (!scenario) { errors.push(context + "missing JSON record"); continue; }
    check(scenario.title === heading[2].trim(), context + "title differs between Markdown and JSON");
    check(scenario.category === groups[id[3]]?.[0], context + "category does not match ID");
    for (const label of ["**用户任务：**", "**前置：**", "**用户动作与恢复：**", "**Pass criteria / 设计缺口：**", "**分工：**", "**关联：**", "**选择：**", "**设计状态：**"])
      check(block.includes(label), context + "missing " + label);
    const actions = block.split("**用户动作与恢复：**")[1]?.split("**Pass criteria / 设计缺口：**")[0] || "";
    const steps = [...actions.matchAll(/^(\d+)\.\s+(.+)$/gm)];
    check(steps.length > 0 && steps.every((step, index) => Number(step[1]) === index + 1), context + "numbered actions must be sequential and nonempty");
    const criteria = block.split("**Pass criteria / 设计缺口：**")[1]?.split("**分工：**")[0] || "";
    check(/^-[ \t]+\S/m.test(criteria), context + "missing pass criteria or gap criteria");
    const ownership = block.match(/\*\*分工：\*\*([^\r\n]+)/)?.[1] || "";
    check(typeof scenario.executor === "string" && scenario.executor.includes("Agent") && scenario.executor.includes("Human"), context + "Agent/Human ownership must be explicit");
    check(ownership.startsWith(scenario.executor + "。"), context + "ownership differs between Markdown and JSON");
    const mappings = block.match(/\*\*关联：\*\*(.*?)。\*\*选择：\*\*/)?.[1] || "";
    const markdownBB = [...mappings.matchAll(/BB-\d{3}/g)].map(match => match[0]);
    const markdownU = [...mappings.matchAll(/U-[A-G]\b/g)].map(match => match[0]);
    check(same(markdownBB, scenario.bb_test_ids), context + "BB mappings differ between Markdown and JSON");
    check(same(markdownU, scenario.u_packages), context + "U package mappings differ between Markdown and JSON");
    for (const [key, known] of [["bb_test_ids", knownBB], ["u_packages", knownU]]) {
      const ids = list(scenario[key]);
      check(ids.length > 0 && new Set(ids).size === ids.length, context + key + " must be nonempty and unique");
      for (const mapped of ids) check(known.has(mapped), context + "unknown mapping " + mapped);
    }
    const rule = block.match(/\*\*选择：\*\*(.*?)。\*\*设计状态：\*\*/)?.[1];
    check(rule === scenario.selection_rule, context + "selection/scope rule differs between Markdown and JSON");
    check(block.match(/\*\*设计状态：\*\*`([^`]+)`/)?.[1] === scenario.design_status, context + "design status differs between Markdown and JSON");
    for (const key of ["status", "agent_result", "human_result"])
      check(scenario[key] === "not_run", context + key + " must remain not_run");
    check(scenario.selected === false && scenario.selection_reason === null && scenario.result_record === null, context + "scenario must be unselected with no invented execution record");
  }

  const pause = catalog.find(item => item.scenario_id === "UX-A03") || {};
  check(pause.requirement_status === "user_confirmed" && pause.design_status === "confirmed_requirement_with_gaps", "UX-A03 must remain a confirmed requirement with gaps");
  check(pause.implementation_status === "missing_in_source_review" && pause.billing_policy_status === "pending_design", "UX-A03 missing capability and charging design must remain explicit");
  const pauseIndex = headings.findIndex(match => match[1] === "UX-A03");
  const pauseBlock = pauseIndex >= 0 ? markdown.slice(headings[pauseIndex].index, headings[pauseIndex + 1]?.index) : "";
  for (const marker of ["用户已确认", "原任务", "functional_gap", "design_gap", "不能用", "规则未定义不能判计费pass", "不将已确认目标随意N/A"])
    check(pauseBlock.includes(marker), "UX-A03 must retain goal/gap safeguard: " + marker);
  check(!/pending_user_clarification|requirement_pending|待用户确认/.test(pauseBlock + JSON.stringify(pause)), "UX-A03 must not revert to an unconfirmed or excluded requirement");

  const record = template.result_record_template || {};
  check(record.status === "not_run" && record.guidance_allowed === false && record.result_record == null, "Result template must be blank and goal-first");
  for (const key of ["step_results", "agent_assertions", "reused_evidence_with_scope", "defects"])
    check(Array.isArray(record[key]) && record[key].length === 0, "Result template must leave " + key + " empty");
  check(record.step_record_template?.status === "not_run" && record.step_record_template?.actual_device_shutdown === false, "Step evidence must not pretend runtime execution or real shutdown");
  check(record.human_observation?.status === "not_run" && record.human_observation?.completed_without_help === null && record.human_observation?.assistance_count === null, "Human result must remain untested with assistance observations unset");
  const gapTemplate = template.gap_record_template || {};
  check(gapTemplate.verification_status === "not_run" && gapTemplate.type === null && gapTemplate.evidence_method === null && gapTemplate.workaround_counts_as_goal_pass === false, "Gap template must not turn a workaround/source review into acceptance");
  check(Array.isArray(gapTemplate.evidence) && gapTemplate.evidence.length === 0, "Gap template must contain no invented evidence");

  const gaps = list(template.known_source_review_gaps);
  check(same(gaps.map(gap => gap.gap_id), ["FG-001", "FG-002", "DG-001"]), "Expected two known functional gaps and one design gap");
  for (const gap of gaps) {
    check(gap.scenario_id === "UX-A03" && gapTypes.includes(gap.type), gap.gap_id + ": invalid scenario or gap type");
    check(gap.source_reference_sha === sourceSha && gap.verification_status === "not_run", gap.gap_id + ": source review must not claim runtime verification");
    check(["source_review_not_runtime_test", "user_confirmation_and_source_review"].includes(gap.evidence_method), gap.gap_id + ": evidence method must remain explicit source review");
    check(gap.owner === null && gap.severity === null && gap.blocks_U === null, gap.gap_id + ": do not invent triage/admission decisions");
    for (const relative of list(gap.source_paths)) sourcePath(relative, gap.gap_id);
  }
  check(gaps.filter(gap => gap.type === "functional_gap").length === 2 && gaps.filter(gap => gap.type === "design_gap").length === 1, "Known gap taxonomy/count drifted");
  const questions = list(template.product_design_questions);
  const decision = questions.find(item => item.decision_id === "DG-001");
  check(questions.length === 1 && decision?.scenario_id === "UX-A03" && decision?.status === "design_missing" && decision?.user_goal_confirmed === true && decision?.billing_policy === null, "Pause billing/design question must remain unresolved for a confirmed goal");
  check(same(decision?.design_required, ["effective_pause_boundary", "versioned_input_and_prior_work", "completed_or_unknown_calls", "reservation_and_final_charge"]), "Pause design boundaries must remain explicit");
  check(template.admission_decision?.status === "not_run" && template.admission_decision?.ready === false && template.admission_decision?.owner === null && template.admission_decision?.evidence_report === null, "No automatic user-testing admission decision is permitted");
  for (const type of gapTypes) check(markdown.includes(type), "Exploratory gap taxonomy missing " + type);
  check(markdown.includes("只给业务目标和资料") && markdown.includes("发生偏离脚本时跟随真实意图"), "Human exploration must remain goal-first and allow discovery");
  const serialized = JSON.stringify(template);
  check(!/\b[A-Za-z]:[\\/]|file:\/\/|\/Users\/|\/home\/|\\\\[^\\\s]+\\/i.test(markdown + serialized), "Scenario package must not include personal machine paths");
  validateLinks(markdown);
  metrics.checked_links = checkedLinks.size;
  metrics.checked_source_paths = checkedSources.size;
  metrics.known_source_review_gaps = { functional_gap: 2, design_gap: 1 };
  warnings.push({ code: "U_SELECTION_NOT_FROZEN", message: "Actual runtime, scope, fixtures, prices and selected subcases remain unset; metadata pass is not user-testing readiness." });
  warnings.push({ code: "CONFIRMED_GOAL_HAS_SOURCE_REVIEW_GAPS", scenario_id: "UX-A03", message: "Confirmed pause/amend/original-task continuation has two source-identified functional gaps and one unresolved design gap; no runtime test or billing pass is claimed." });
}

process.stdout.write(JSON.stringify({ validator: "user_scenario_planning_metadata", status: errors.length ? "fail" : "pass", product_tests_executed: false, user_testing_ready: false, metrics, warnings, errors }, null, 2) + "\n");
if (errors.length) process.exitCode = 1;
