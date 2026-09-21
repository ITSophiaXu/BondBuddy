import json
import sys
from copy import deepcopy
from pathlib import Path
from docx import Document
from docx.enum.text import WD_COLOR_INDEX
from docx.oxml.ns import qn
from docx.text.run import Run
from docx_locations import walk_blocks


def comment_text(finding):
    evidence = '\n'.join(f"{e.get('source', e.get('documentId', ''))} {e.get('locator', '')}：{e.get('quote', '')}" for e in finding.get('evidence', []))
    return (f"{finding['id']} | {finding.get('priority', 'P2')} | {finding.get('status', finding.get('severity', '待人工判断'))}\n"
            f"{finding['title']}\n问题：{finding.get('issue', '')}\n"
            f"证据：{evidence or '待补充'}\n"
            f"计算：{finding.get('calculation') or '不涉及或未返回'}\n"
            f"建议：{finding.get('suggestion', '')}\n规则：{'、'.join(finding.get('ruleIds', []))}\n"
            f"原文位置：{finding.get('locator', '')}\n"
            f"校验提示：{'；'.join(finding.get('validationWarnings', [])) or '无'}")


def split_at(paragraph, offset):
    position = 0
    for run in list(paragraph.runs):
        length = len(run.text)
        if position < offset < position + length:
            if any(child.tag not in (qn('w:rPr'), qn('w:t')) for child in run._r):
                return False
            cut = offset - position
            original = run.text
            right = deepcopy(run._r)
            run._r.addnext(right)
            run.text = original[:cut]
            Run(right, paragraph).text = original[cut:]
            return True
        position += length
    return True


def anchor(document, paragraph, finding):
    quote = finding.get('quote', '')
    full = paragraph.text
    if full.count(quote) != 1:
        return '同段原文出现多次，需人工选择批注位置。'
    if full != ''.join(r.text for r in paragraph.runs):
        return '原文含超链接等复杂结构，未自动拆分批注。'
    start = full.index(quote)
    end = start + len(quote)
    # Verify boundaries before any mutation so a failed anchor preserves the file.
    cursor = 0
    for run in paragraph.runs:
        if any(cursor < point < cursor + len(run.text) for point in (start, end)):
            if any(child.tag not in (qn('w:rPr'), qn('w:t')) for child in run._r):
                return '原文边界包含域或其他复杂对象，需人工批注。'
        cursor += len(run.text)
    split_at(paragraph, end)
    split_at(paragraph, start)
    selected = []
    cursor = 0
    for run in paragraph.runs:
        if run.text and cursor >= start and cursor + len(run.text) <= end:
            selected.append(run)
        cursor += len(run.text)
    if not selected:
        return '未能建立有效的文字批注范围。'
    for run in selected:
        run.font.highlight_color = WD_COLOR_INDEX.YELLOW
    document.add_comment(selected, text=comment_text(finding), author='BondBuddy', initials='BB')
    return None


def main():
    source, findings_path, output, annotation_path = map(Path, sys.argv[1:5])
    document = Document(source)
    findings = json.loads(findings_path.read_text(encoding='utf-8-sig')).get('findings', [])
    locations = dict(walk_blocks(document))
    anchored = []
    unanchored = []
    for finding in findings:
        quote = finding.get('quote', '')
        locator = finding.get('locator', '')
        reason = None
        paragraph = locations.get(locator) if locator else None
        if not quote or finding.get('anchorVerified') is False:
            reason = '未提供经过验证的更新稿原文锚点。'
        elif locator:
            if paragraph is None or quote not in paragraph.text:
                reason = '指定位置与原文不匹配；没有转移批注到其他同名内容。'
        else:
            candidates = [p for p in locations.values() if quote in p.text]
            if len(candidates) == 1:
                paragraph = candidates[0]
            else:
                reason = '原文不存在或有多个候选位置，需人工定位。'
        if reason is None:
            reason = anchor(document, paragraph, finding)
        if reason:
            unanchored.append({'id': finding['id'], 'reason': reason})
        else:
            anchored.append(finding['id'])
    document.save(output)
    annotation_path.write_text(json.dumps({'anchoredIds': anchored, 'unanchoredIds': [f['id'] for f in unanchored], 'unanchored': unanchored}, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
