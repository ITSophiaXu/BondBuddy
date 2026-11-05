"""Read explicit correction fields without depending on one Markdown heading level.

Formatting is flexible; evidence, an exact quote and an explicit replacement remain
mandatory for automatic edits. Narrative recommendations never become replacements.
"""
import re
from .annotate_review import plain

FIELDS = ('复核类别', '问题说明', '原文位置', '原文披露', '核对依据', '处理方式', '替换文本', '缺少材料', '待确认事项')
FIELD = re.compile(r'^\s*(?:[-*+]\s+)?(?:\*\*)?(' + '|'.join(FIELDS) + r')(?:\*\*)?\s*[：:](?:\*\*)?\s*(.*)$')
HEADING = re.compile(r'^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$')
NUMBERED = re.compile(r'^\s*(?:\*\*)?\d+[.、）)]\s*(.+?)(?:\*\*)?$')


def category_label(category):
    """Normalize explicit categories only; never guess one from a finding's prose."""
    value = (category or '').strip()
    aliases = {
        '财务数据一致性': '数据一致性',
        '政策要求与重点提示': '合规',
        '合规与披露': '合规',
        '格式与标点': '格式',
        '勾稽关系': '勾稽',
    }
    return aliases.get(value, value) if value and value != '待确认' else '类别待确认'


def correction_blocks(markdown):
    title, fields, current = '', {}, None
    blocks = []

    def finish():
        # Coverage headings and summaries are not findings.
        if '问题说明' in fields or ('原文披露' in fields and len(fields) > 1):
            blocks.append((plain(title) or '复核待确认事项', {k: '\n'.join(v).strip() for k, v in fields.items()}))

    for line in markdown.lstrip('\ufeff').splitlines():
        heading = HEADING.match(line) or NUMBERED.match(line)
        if heading:
            finish()
            title, fields, current = heading[1], {}, None
            continue
        # Also accept a two-column field/value table, retaining the exact values.
        if line.strip().startswith('|'):
            cells = re.split(r'(?<!\\)\|', line.strip().strip('|'))
            if len(cells) == 2 and plain(cells[0]).rstrip('：:') in FIELDS:
                line = plain(cells[0]).rstrip('：:') + '：' + cells[1].strip().replace('\\|', '|')
        match = FIELD.match(line)
        if match:
            name, value = match.groups()
            # Repeated category/quote blocks without headings are separate findings.
            if name in fields and name in ('复核类别', '问题说明'):
                finish()
                title, fields = '', {}
            current = name
            fields.setdefault(name, []).append(plain(value))
        elif not line.strip():
            current = None
        elif current and (re.match(r'^(?:\s*>|\s{2,}\S)', line) or not any(fields[current])) and not re.match(r'^\s*(?:```|~~~|\|)', line):
            # Explicit quoted/indented continuations or the value of an empty
            # field only. Unrelated narrative must never become replacement text.
            fields[current].append(plain(re.sub(r'^\s*>\s?', '', line)))
    finish()
    return blocks


def findings(markdown):
    result = []
    for title, fields in correction_blocks(markdown):
        missing = fields.get('缺少材料', fields.get('待确认事项', ''))
        if missing in ('无', '无。', '无缺项', '无待确认事项'):
            missing = ''
        evidence = fields.get('核对依据', '')
        original = fields.get('原文披露', '').strip().strip('`“”「」"')
        result.append(dict(id=f'R{len(result)+1:03d}', category=category_label(fields.get('复核类别')),
                           title=re.sub(r'^R\d+\s*[·.、:]\s*', '', title), original=original,
                           replacement=fields.get('替换文本', ''), reason=fields.get('问题说明', title),
                           evidence=evidence, missing=missing,
                           uncertain=fields.get('处理方式') != '直接修改' or bool(missing) or not evidence,
                           paragraph_id=None, decision='suggested', manual_text='', applied=False, limitation=''))
    return result
