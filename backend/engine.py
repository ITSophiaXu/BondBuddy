from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import re
import socket
import ssl
import http.client
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urljoin
from decimal import Decimal, InvalidOperation

from .documents import parse_document, targets, text_diff
from .store import uid, now

FINANCIAL = re.compile(r'资产|负债|收入|成本|利润|现金|应收|应付|存货|借款|有息债务|受限|毛利|财务|EBITDA|股本|实收资本|担保余额|偿债|净额|占比|报告期|审计')
CAPITAL = re.compile(r'注册资本|实缴资本')
FULL_FIELDS = re.compile(r'注册资本|实缴资本|法定代表人|评级|授信|征信|逾期|诉讼|截至目前|截至本募集|签署日|经营范围|存续债券|信用报告')
NUMERIC = re.compile(r'\d[\d,.%％]*|【[^】]*】')


def registry_only_target(t):
    # In a mixed paragraph we protect the registry clauses while allowing other financial values.
    if CAPITAL.search(t['text']):
        return not re.search(r'资产|负债|营业收入|实收资本|股本|净利润', t['text'])
    return bool(CAPITAL.search(t.get('context', '')) and not re.search(r'实收资本|股本', t.get('context', '')))


def registry_clauses(text):
    return re.findall(r'(?:注册资本|实缴资本)[^，。；;\n]*', text)


def working_file(p):
    original = next((f for f in p['files'] if f['id'] == p['original_id']), None)
    if not original:
        return None
    file = copy.deepcopy(original)
    if original.get('extension') == '.docx':
        file['format_policy'] = 'preserve_original'
        # Earlier versions staged appended columns. Preserve those proposals in
        # review comments; do not silently change the original Word table grid.
        additions = p.get('extra_columns') or (planned_period_columns(file, p['period']) if p.get('period') else [])
        file['deferred_target_ids'] = [c['id'] for a in additions for c in a['cells']]
        changes = {c['target_id']:c for c in p.get('changes', []) if c['status'] != 'rejected'}
        file['layout_tasks'] = []
        for addition in additions:
            table = next((b for b in file['blocks'] if b['id'] == addition['table_id']), None)
            if not table or not table['rows'] or not table['rows'][0]:
                continue
            text = '【待确认：' + p['period'] + '报告期列安排。原表列数、列宽及样式已保留，请在 Word 中确认新报告期列的安排。】'
            proposals = [
                changes[c['id']]['after']
                for c in addition['cells']
                if c['id'] in changes
                and changes[c['id']].get('origin') != 'scan'
                and (changes[c['id']].get('sources') or changes[c['id']].get('origin') == 'human')
            ]
            if proposals:
                text += '\n原先拟新增列的内容（尚未写入原表）：\n' + '\n'.join(proposals)
            file['layout_tasks'].append({'target_id':table['rows'][0][0]['id'], 'table_id':table['id'], 'text':text})
        return file
    for addition in p.get('extra_columns', []):
        table = next((b for b in file['blocks'] if b['id'] == addition['table_id']), None)
        if table:
            for row, cell in zip(table['rows'], addition['cells']):
                row.append(cell)
            file['segments'].extend(addition['cells'])
    return file


def planned_period_columns(file, period):
    year, month, _ = period.split('-')
    added = []
    for b in file['blocks']:
        if b['type'] != 'table' or len(b['rows']) < 2:
            continue
        h = [c['text'] for c in b['rows'][0]]
        dates = [x for x in h if re.search(r'20\d{2}', x)]
        if len(dates) < 2 or not all(re.search(r'20\d{2}年(?:末|度|12月31日)', x) for x in dates):
            continue
        if max(int(re.search(r'20\d{2}', x).group()) for x in dates) >= int(year):
            continue
        if not FINANCIAL.search(' '.join(c['text'] for row in b['rows'] for c in row)):
            continue
        cells = []
        for ri, row in enumerate(b['rows']):
            period_label = f'{year}年' + ('度' if month == '12' else f'1—{int(month)}月') if any('年度' in x for x in dates) else f'{year}年{int(month)}月末'
            cells.append({'id': f'{b["id"]}:newperiod:{ri}', 'text': '', 'locator': f'新增报告期列 · 第 {ri + 1} 行',
                          'inserted': True, 'field': row[0]['text'] if row else '', 'period_label': period_label})
        added.append({'table_id': b['id'], 'cells': cells})
    return added


def ensure_period_columns(p):
    """DOCX keeps its original grid; structural proposals remain review tasks."""
    if p.get('extra_columns'):
        return
    file = working_file(p)
    if not file or file.get('extension') == '.docx':
        return
    p['extra_columns'] = planned_period_columns(file, p['period'])


def candidate_targets(p):
    file = working_file(p)
    if not file:
        return []
    result = []
    for t in targets(file):
        context = t['text'] + ' ' + t.get('context', '')
        if '【' in t['text'] or '】' in t['text']:
            result.append(t)
            continue
        if t.get('toc_entry'):
            continue
        if p['mode'] == 'financial' and registry_only_target(t):
            continue
        if t.get('inserted') or '【' in t['text'] or ((FINANCIAL.search(context) or (p['mode'] == 'full' and FULL_FIELDS.search(context))) and NUMERIC.search(t['text'])):
            result.append(t)
    return result


def placeholder(t, reason='需要核对最新报告期，尚无已验证的来源'):
    old = t['text']
    if '【' in old:
        return old
    if t.get('inserted'):
        label = t.get('field') or '新增报告期'
        return f'【待补充：{t.get("period_label", "目标报告期")} {label}】'
    if len(old) < 80:
        return f'【待核对：{old}】'
    return old + f'【待核对：{reason}】'


def safe_unsourced_after(change):
    target = {
        'text': change.get('before', ''),
        'inserted': ':newperiod:' in change.get('target_id', ''),
        'field': change.get('field', ''),
        'period_label': change.get('period_label', '目标报告期'),
    }
    return placeholder(target, '未找到可核实来源，Agent 建议未应用')


def publication_changes(changes):
    result = copy.deepcopy(changes)
    for c in result:
        if c.get('origin') != 'agent' or c.get('sources') or c.get('status') == 'rejected':
            continue
        proposed = c.get('proposal') or c.get('after', '')
        c['proposal'] = proposed
        c['after'] = safe_unsourced_after(c)
        c['needs_review'] = True
        c['status'] = 'needs_review'
        c['issue'] = '缺少来源，建议未应用'
        note = '未找到可核实来源，Agent 建议未写入当前文档'
        if note not in c.get('reason', ''):
            c['reason'] = (c.get('reason', '').rstrip('；') + '；' + note).lstrip('；')
    return result


def stage_candidates(p):
    ensure_period_columns(p)
    existing = {c['target_id'] for c in p['changes']}
    for t in candidate_targets(p):
        if t['id'] not in existing:
            p['changes'].append({'id': uid('chg'), 'target_id': t['id'], 'before': t['text'], 'after': placeholder(t),
                'reason': '全文扫描发现可能需要更新的位置，等待 Agent 核对报告期和来源；此标记不代表旧值错误。',
                'needs_review': True, 'issue': '未核对', 'sources': [], 'status': 'needs_review', 'origin': 'scan',
                'chapter': t['chapter'], 'created_at': now(), 'version': 1})


def index_brackets(p):
    file = working_file(p)
    if not file:
        return
    existing = {c['target_id'] for c in p['changes']}
    for t in targets(file):
        if ('【' in t['text'] or '】' in t['text']) and t['id'] not in existing:
            p['changes'].append({'id': uid('chg'), 'target_id': t['id'], 'before': t['text'], 'after': t['text'],
                'reason': '原文含有【】，需要人工查看、填写或确认；范围外的字段也保留待办。',
                'needs_review': True, 'issue': '原文待办', 'sources': [], 'status': 'needs_review', 'origin': 'scan',
                'chapter': t['chapter'], 'created_at': now(), 'version': 1})


def normalized(s):
    return re.sub(r'\s+', '', str(s))


def validate_sources(p, refs):
    valid, invalid = [], []
    if not isinstance(refs, list):
        return [], ['来源结构无效']
    for ref in refs[:12]:
        if not isinstance(ref, dict):
            invalid.append('来源结构无效')
            continue
        file = next((f for f in p['files'] if f['id'] == ref.get('source_id') and f['role'] != 'prospectus'), None)
        segment = next((s for s in file['segments'] if s['id'] == ref.get('segment_id')), None) if file else None
        quote = str(ref.get('quote', '')).strip()
        if not segment or not normalized(quote) or normalized(quote) not in normalized(segment['text']):
            invalid.append('引用未能与上传材料原文匹配')
            continue
        valid.append({'source_id': file['id'], 'segment_id': segment['id'], 'quote': quote,
                      'name': file['name'], 'locator': segment['locator'], 'page': segment.get('page'),
                      'url': file.get('url'), 'verified': True, 'ocr': bool(segment.get('ocr'))})
        if segment.get('ocr'):
            invalid.append('引文来自扫描识别，请对照 PDF 原页确认数字与列名')
        for check in file.get('source_checks', []):
            check_segment = check.get('segment_id')
            if check.get('requires_review') and (not check_segment or check_segment == segment['id']):
                invalid.append(check['text'])
    return valid, list(dict.fromkeys(invalid))


def unsupported_numbers(p, before, after, refs, reason):
    """A narrow guard, not semantic accounting validation: flag invented new numbers."""
    pattern = r'(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?[%％]?'
    def numbers(text):
        result = []
        text = re.sub(r'\b(20\d{2})-(\d{1,2})-(\d{1,2})\b', r'\1年\2月\3日', text)
        for match in re.finditer(pattern, text):
            try:
                result.append((match.group(), Decimal(match.group().replace(',', '').rstrip('%％'))))
            except InvalidOperation:
                pass
        return result
    old = {value for _, value in numbers(before)}
    evidence = []
    for ref in refs:
        file = next(f for f in p['files'] if f['id'] == ref['source_id'])
        segment = next(s for s in file['segments'] if s['id'] == ref['segment_id'])
        evidence.extend(numbers(segment['text'] + ' ' + segment.get('source_context', '')))
    supported = {value for _, value in evidence}
    calculation = bool(re.search(r'÷|/|×|计算|换算|公式', reason))
    if calculation:
        raw = list(supported)[:64]
        for a in raw:
            supported.update({a / 10000, a * 10000, a / 100000000, a * 100000000})
            for b in raw:
                if b:
                    supported.update({a / b, a / b * 100, (a - b) / abs(b) * 100})
    missing = []
    for token, value in numbers(after):
        if value in old or value in supported:
            continue
        precision = len(token.rstrip('%％').split('.')[-1]) if '.' in token else 0
        if calculation and precision and any(abs(value - s) <= Decimal(10) ** -precision / 2 for s in supported):
            continue
        missing.append(token)
    return list(dict.fromkeys(missing))


def apply_model_result(p, result, allowed_ids, start_revision):
    """Do not trust model IDs, citations, assessment completeness or certainty claims."""
    if p['revision'] != start_revision:
        raise ValueError('文档已被修改，本次结果未覆盖当前内容。请重新运行。')
    file = working_file(p)
    by_id = {t['id']: t for t in targets(file)}
    changes = result.get('changes', [])
    assessments = result.get('assessments', [])
    if not isinstance(changes, list) or not isinstance(assessments, list):
        raise ValueError('Agent 输出结构不完整，请重试。')
    handled = set()
    for item in changes:
        tid = item.get('target_id') if isinstance(item, dict) else None
        if tid not in allowed_ids or tid in handled:
            continue
        t = by_id[tid]
        old_change = next((c for c in p['changes'] if c['target_id'] == tid), None)
        if old_change and old_change['status'] in {'accepted', 'rejected'}:
            handled.add(tid)
            continue
        after = item.get('after')
        if p['mode'] == 'financial' and (registry_only_target(t) or (isinstance(after, str) and registry_clauses(t['text']) != registry_clauses(after))):
            p['coverage'][tid] = {'decision': 'out_of_scope', 'reason': '实缴资本、注册资本由工商模块处理。'}
            handled.add(tid)
            continue
        if not isinstance(after, str) or len(after) > 16000:
            continue
        handled.add(tid)
        refs, invalid = validate_sources(p, item.get('sources', []))
        reason = str(item.get('reason', '需要人工核对'))[:2000]
        proposal = ''
        if refs and '【' not in after:
            missing = unsupported_numbers(p, t['text'], after, refs, reason)
            if missing:
                invalid.append('新增数字尚无直接引文或已支持的计算依据：' + '、'.join(missing[:12]))
                for token in sorted(missing, key=len, reverse=True):
                    after = re.sub(r'(?<![\d.,])' + re.escape(token) + r'(?![\d.,])', lambda m: '【待确认：' + m.group() + '】', after)
        if not refs:
            proposal = after
            after = placeholder(t, '未找到可核实来源，Agent 建议未应用')
            invalid.append('未找到可核实来源，Agent 建议未写入当前文档')
        needs = item.get('needs_review') is not False or bool(invalid) or not refs or '【' in after or '】' in after
        if needs and '【' not in after:
            after = f'【待确认：{after}】' if len(after) < 140 else after + '【待确认：请核对本处修改及依据】'
        if after == t['text'] and not needs:
            p['coverage'][tid] = {'decision': 'keep', 'reason': reason}
            p['changes'] = [c for c in p['changes'] if not (c['target_id'] == tid and c['origin'] == 'scan')]
            continue
        c = {'id': old_change['id'] if old_change else uid('chg'), 'target_id': tid, 'before': t['text'], 'after': after,
             'reason': reason + ('；' + '；'.join(dict.fromkeys(invalid)) if invalid else ''), 'needs_review': needs,
             'issue': ('缺少来源，建议未应用' if not refs else str(item.get('issue', ''))[:120] or ('待确认' if needs else '')),
             'sources': refs, 'status': 'needs_review' if needs else 'pending', 'origin': 'agent',
             'chapter': t['chapter'], 'created_at': now(), 'version': (old_change or {}).get('version', 0) + 1}
        if proposal and proposal != after:
            c['proposal'] = proposal
        p['history'].append({'id': uid('event'), 'at': now(), 'action': 'Agent 修改', 'change_id': c['id'],
                             'before': copy.deepcopy(old_change), 'after': copy.deepcopy(c)})
        p['changes'] = [x for x in p['changes'] if x['target_id'] != tid] + [c]
        p['coverage'][tid] = {'decision': 'review' if needs else 'change', 'reason': reason}
    for a in assessments:
        tid = a.get('target_id') if isinstance(a, dict) else None
        decision = a.get('decision') if isinstance(a, dict) else None
        if tid not in allowed_ids or tid in handled or decision not in {'keep', 'out_of_scope', 'review'}:
            continue
        reason = str(a.get('reason', ''))[:2000]
        if not reason:
            continue
        p['coverage'][tid] = {'decision': decision, 'reason': reason}
        if decision in {'keep', 'out_of_scope'}:
            p['changes'] = [c for c in p['changes'] if not (c['target_id'] == tid and c['origin'] == 'scan' and '【' not in c['before'] and '】' not in c['before'])]
        else:
            t = by_id[tid]
            if not any(c['target_id'] == tid for c in p['changes']):
                p['changes'].append({'id': uid('chg'), 'target_id': tid, 'before': t['text'], 'after': placeholder(t, reason),
                    'reason': reason, 'needs_review': True, 'issue': '需要人工判断', 'sources': [], 'status': 'needs_review',
                    'origin': 'agent', 'chapter': t['chapter'], 'created_at': now(), 'version': 1})


def review_change(p, cid, action, text=None, version=None):
    c = next((c for c in p['changes'] if c['id'] == cid), None)
    if not c:
        raise KeyError('修改记录不存在')
    if version is not None and c['version'] != version:
        raise ValueError('这处修改已经变化，请刷新后再操作。')
    before = copy.deepcopy(c)
    if action == 'accept':
        if c['needs_review'] or '【' in c['after'] or '】' in c['after']:
            raise ValueError('请先填写或核对【】内的内容，再保存确认。')
        c['status'] = 'accepted'
    elif action == 'reject':
        c['status'] = 'rejected'
        if '【' in c['before'] or '】' in c['before']:
            c.update(after=c['before'], needs_review=True, status='needs_review', sources=[], origin='human', issue='原文待办',
                     reason='已拒绝 Agent 建议并保留原文；原文中的【】仍需处理。')
    elif action == 'edit':
        if not isinstance(text, str) or len(text) > 16000:
            raise ValueError('修改内容无效或过长。')
        c['after'] = text
        c['needs_review'] = '【' in text or '】' in text
        c['status'] = 'needs_review' if c['needs_review'] else 'accepted'
        c['origin'] = 'human'
        c['reason'] = '用户直接修改并保存；原 Agent 依据保留在历史记录中。'
        c['sources'] = []
        c['issue'] = '人工待办' if c['needs_review'] else ''
    elif action == 'reopen':
        c['status'] = 'needs_review' if c['needs_review'] else 'pending'
    else:
        raise ValueError('不支持的审核操作。')
    c['version'] += 1
    p['revision'] += 1
    p['history'].append({'id': uid('event'), 'at': now(), 'action': action, 'change_id': cid, 'before': before, 'after': copy.deepcopy(c)})
    return c


def project_view(p, full_history=False):
    data = copy.deepcopy(p)
    file = working_file(p)
    data['document'] = file
    if file:
        data['targets'] = targets(file)
    else:
        data['targets'] = []
    for f in data['files']:
        f.pop('stored_path', None)
        f.pop('original_source_path', None)
        f.pop('segments', None)
        f.pop('blocks', None)
    if data['document']:
        data['document'].pop('stored_path', None)
        data['document'].pop('original_source_path', None)
        data['document'].pop('segments', None)
    deferred_ids = set(file.get('deferred_target_ids', [])) if file else set()
    data['deferred_changes'] = [c for c in data['changes'] if c['target_id'] in deferred_ids]
    data['changes'] = publication_changes([c for c in data['changes'] if c['target_id'] not in deferred_ids])
    for c in data['changes']:
        c['diff'] = text_diff(c['before'], c['after'])
        original_todo = '【' in c['before'] or '】' in c['before']
        c['review_stage'] = ('awaiting_agent' if c.get('origin') == 'scan' and not original_todo and c['status'] == 'needs_review'
                             else 'original_todo' if c.get('origin') == 'scan' and original_todo and c['status'] == 'needs_review'
                             else 'missing_source' if c.get('origin') == 'agent' and not c.get('sources') and c['status'] == 'needs_review'
                             else c['status'])
    if not full_history:
        data['history'] = [{'id': h['id'], 'at': h['at'], 'action': h['action'], 'change_id': h.get('change_id')} for h in data['history'][-50:]]
    unresolved = [c for c in data['changes'] if c['status'] == 'needs_review' and c['review_stage'] != 'awaiting_agent']
    visible_changes = data['changes']
    data['stats'] = {'changes': sum(c['status'] != 'rejected' and c.get('origin') != 'scan' and c['before'] != c['after']
                                            and bool(c.get('sources') or c.get('origin') == 'human') for c in visible_changes),
                     'scan_candidates': sum(c.get('origin') == 'scan' and c['status'] != 'rejected' for c in visible_changes), 'needs_review': len(unresolved),
                     'layout_tasks':len(file.get('layout_tasks', [])) if file else 0,
                     'awaiting_agent': sum(c['review_stage'] == 'awaiting_agent' for c in data['changes']),
                     'missing_source': sum(c['review_stage'] == 'missing_source' for c in data['changes']),
                     'original_todos': sum(c['review_stage'] == 'original_todo' for c in data['changes']),
                     'accepted': sum(c['status'] == 'accepted' for c in visible_changes), 'pending': sum(c['status'] == 'pending' for c in visible_changes),
                     'sources': len(p['files']) - bool(p['original_id']), 'scanned': len(p['coverage']), 'total': len(data['targets'])}
    return data


class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'noscript'}:
            self.skip += 1
        if tag in {'p', 'div', 'br', 'tr', 'h1', 'h2', 'li'}:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in {'script', 'style', 'noscript'}:
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def fetch_public_url(url):
    """Pin the validated public IP for each HTTPS connection, including redirects."""
    for _ in range(4):
        u = urlsplit(url)
        if u.scheme != 'https' or not u.hostname or u.username or u.password or u.port not in {None, 443}:
            raise ValueError('仅支持公开 HTTPS 网页，不支持登录信息、自定义端口或内网地址。')
        addresses = socket.getaddrinfo(u.hostname, 443, type=socket.SOCK_STREAM)
        ips = [a[4][0] for a in addresses]
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise ValueError('不可读取内网或本机地址。')
        conn = http.client.HTTPSConnection(u.hostname, 443, timeout=15)
        sock = socket.create_connection((ips[0], 443), timeout=15)
        conn.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
        try:
            conn.request('GET', (u.path or '/') + ('?' + u.query if u.query else ''), headers={'User-Agent': 'BondDraft-Cowork/1.0', 'Accept': 'text/html,text/plain'})
            response = conn.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                url = urljoin(url, response.getheader('Location', ''))
                continue
            if response.status != 200:
                raise ValueError(f'网页返回 {response.status}，请上传资料或换用公开来源。')
            ctype = response.getheader('Content-Type', '')
            if not any(t in ctype for t in ['text/html', 'text/plain', 'application/xhtml']):
                raise ValueError('链接不是可读取网页，请下载后作为材料上传。')
            raw = response.read(3_000_001)
            if len(raw) > 3_000_000:
                raise ValueError('网页内容过大。')
            encoding = re.search(r'charset=([\w-]+)', ctype)
            text = raw.decode(encoding.group(1) if encoding else 'utf-8', errors='replace')
            parser = HtmlText()
            parser.feed(text)
            text = '\n'.join(x.strip() for x in ''.join(parser.parts).splitlines() if x.strip())
            if not text:
                raise ValueError('该网页没有可读取正文，请上传导出的资料。')
            return text, url
        finally:
            conn.close()
    raise ValueError('网页重定向次数过多。')


def prepare_file(raw, name, role, category, url=None):
    if role not in {'prospectus', 'source'}:
        raise ValueError('文件角色无效。')
    if category not in {'financial', 'notes', 'audit', 'credit', 'registry', 'rating', 'other', 'web', 'prospectus'}:
        raise ValueError('材料类型无效。')
    safe_name = name.replace('\\', '/').split('/')[-1][:180]
    if not safe_name or safe_name.startswith('.'):
        raise ValueError('文件名无效。')
    fid = uid('file')
    parsed = parse_document(raw, safe_name, fid)
    if not parsed['segments']:
        raise ValueError('文件中没有可读取文字，请上传文字版或完成 OCR 的文件。')
    return {'id': fid, 'name': safe_name, 'role': role, 'category': category, 'size': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(), 'uploaded_at': now(), 'url': url, **parsed}


def commit_file(store, p, raw, file):
    if len(p['files']) >= 60:
        raise ValueError('单个项目最多 60 份材料。')
    role = file['role']
    if role == 'prospectus' and p['original_id']:
        raise ValueError('当前项目已有募集书底稿。请新建项目以保留审核记录。')
    path = store.root / 'files' / p['id'] / (file['id'] + Path(file['name']).suffix.lower())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    f = {**file, 'stored_path': str(path)}
    p['files'].append(f)
    if role == 'prospectus':
        p['original_id'] = f['id']
        index_brackets(p)
    store._storage_cache = None
    store.log(p, '上传材料', name=f['name'])
    return f


def add_file(store, p, raw, name, role, category, url=None):
    return commit_file(store, p, raw, prepare_file(raw, name, role, category, url))
