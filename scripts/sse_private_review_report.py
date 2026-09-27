"""Deterministic documentary review with exact quotations; no attestation writes."""
import json
from sse_private_handling import ADDITIONAL_CHECKS, MANUAL_HANDLERS, EXISTING_ACCEPTANCE


def write_review_report(base, pack, documents, mappings, review_items, version, authored_at):
    assert set(ADDITIONAL_CHECKS) | set(MANUAL_HANDLERS) | set(EXISTING_ACCEPTANCE) == set(mappings)
    assert not (set(ADDITIONAL_CHECKS) & set(MANUAL_HANDLERS))
    lines = ['# #20 31条规则逐项文献核对与处理验收', '',
             f'版本 `{version}` / checker v4；记录时间 {authored_at}；核对者：Codex（文献分析与工程实现）。', '',
             '**本轮结论：31/31逐条核对既有原文、效力观察、范围、例外；原剩余20条已落实14组受限检查与6组人工审核处理。不是31条全自动合规通过。**', '',
             '法规证据基准固定为2026-09-26；2026-09-27是分析/代码交付日，不冒充进行了新的全网现行核验。各公告记录的现行状态仅截至归档观察日；不同适用日应选择另经核对的版本。', '',
             '本文件给出可审查的具体结论；正式来源专业签认、缺失配套法规、真实项目事实审核、发布和成果验收均不由本文件自动完成。没有写入真人身份/签名或任何批准台账。全部候选保持disabled/research_only。', '',
             '## 统一适用及执行原则', '',
             '- 目标上交所普通私募；8.1的私募差异优先于公开发行一般表述。其他市场、专项、优化审核、豁免不默认套用。',
             '- 法规日、财务截止日、签署日、历史事件日分开；本轮处理只回放2026-09-26。',
             '- `pass`只代表一个结构化小项；按完整材料清单逐字段、期间、板块、品种、章节发生位置遍历，部分通过不代表整份通过。',
             '- 无依据/冲突/OCR存疑保留needs_evidence或needs_judgement，按UPD-GAP-01继续有依据的全文工作稿；不新增用户必填表单。',
             '- checker的verified输入由可信适配器核对归属、版本/hash、锚点及真实审核产生；不接受浏览器自报verified。',
             '- 模拟、状态、差分和确定性复算是内部方法；引用正式原则不意味着交易所规定了本产品算法。', '',
             '## 验收分类', '',
             '25条受限检查＋6条人工处理=31条有处理。`handledRuleIds`列31条，`manualRuleIds`及`uncoveredRuleIds`仍列6条无自动专业判定的规则；既有25条也保留各自未覆盖内容，正式CoverageManifest继续31条uncovered。', '',
             '工程验收使用合成反例，文件为 `sse-private-additional-checks.test.ts` / `sse-private-manual-checks.test.ts` 及既有三份检查测试。真人规则专业签认与四组真实Word结果另在[关闭清单](CLOSURE-CHECKLIST.md)G1–G5核对。', '',
             '| 规则 | 文献结论类别 | 工程处理 |', '| --- | --- | --- |']
    rows = []
    for rule in pack['rules']:
        key = rule['rule_id'].removeprefix('sse-private-')
        detail = ADDITIONAL_CHECKS.get(key) or MANUAL_HANDLERS.get(key)
        source_type = detail[1] if detail else '正式要求＋受限内部检查'
        mode = 'manual-evidence-handler-v4' if key in MANUAL_HANDLERS else 'bounded-research-check-v4'
        lines.append(f'| [{rule["title"]}](#{key}) | {source_type} | {mode} |')
        rows.append((key,rule,detail,source_type,mode))
    for key,rule,detail,source_type,mode in rows:
        chapters, pairs, limit = mappings[key]
        conclusion = detail[2] if detail else review_items[key][0]
        acceptance = detail[3] if detail else EXISTING_ACCEPTANCE[key]
        lines += ['', f'<a id="{key}"></a>', f'## {rule["title"]}', '',
                  f'`{rule["rule_id"]}` · {mode} · 章节：'+ ' / '.join(chapters), '',
                  '**文献结论（已核对）**：'+source_type+'。'+conclusion, '',
                  '**适用与例外/未覆盖**：'+limit, '',
                  '**处理与验收**：'+acceptance, '',
                  '**输入/适配**：'+(detail[0] if detail else '既有SsePrivateCheckInput字段，见EXECUTABLE-CHECKS.md')+'；按本期已锁定材料及完整集合逐项执行。', '',
                  '**效力及原文依据**：']
        for did,loc in pairs:
            doc = documents[did]
            quote = doc['records'][loc]['text']
            lines += ['', f'- [{doc["title"]} / {loc}](../../verification/2026-09-26/sources/{did}.md#{loc.lower()})；发布 {doc["published_on"]}，生效 {doc["effective_from"] or "未单列（不能自行补生效日）"}，失效 {doc["effective_to"] or "归档未记录，不推断永久有效"}。',
                      '  '+doc['effectivity_observation']+' 替代关系：'+str(doc.get('replaces') or '未登记替代，不推定无后续修订')+'。过渡观察：'+doc.get('transition_review','未单列，具体项目另核'), '',
                      '> '+quote.replace('\n','\n> '), '']
        if not pairs:
            lines += ['', '本范围未登记可用于确认专项效力的官方证据对。用户原件仍可研究，不能写“当前专项规则已验收”；本条实施的是普通包能力隔离和人工交接。', '']
        lines += ['**剩余验收**：上述未覆盖依据与专业判断须有实际审核结论；绑定来源hash/版本并走#19实际发布。真实材料及成果逐章验收、Word/WPS在产出后验证。文献/工程记录不能代签。', '']
    (base/'drafts/sse-private/RULE-REVIEW-20260927.md').write_text('\n'.join(lines).rstrip()+'\n','utf8')
    evidence = {'version':version,'baseline_as_of':'2026-09-26','authored_at':authored_at,
                'review_type':'documentary_analysis_not_professional_attestation',
                'counts':{'reviewed':31,'bounded_checks':25,'manual_handlers':6,'new_bounded_checks':14},
                'rules':[{'rule_id':r['rule_id'],'handling':m,'input':d[0] if d else 'existing-v2-v3-input',
                          'conclusion':d[2] if d else review_items[k][0],
                          'acceptance':d[3] if d else EXISTING_ACCEPTANCE[k],
                          'professional_approval':None,
                          'source_refs':[{'document_id':did,'locator':loc,'sha256':documents[did]['notice_sha256'] if loc=='NOTICE' else documents[did]['sha256']} for did,loc in mappings[k][1]]}
                         for k,r,d,_,m in rows]}
    (base/'drafts/sse-private/rule-review-20260927.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n','utf8')
