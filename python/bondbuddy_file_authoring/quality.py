"""Fail-closed template checks with flexible prose for authored Word pairs.

This verifies the files independently of model completion and delivery notes. It
does not certify financial facts, legal applicability or visual layout quality.
The host must construct the input from its locked source, never model metadata.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

from .check import REV, STORY, package, resolve_revisions
from .format_diff import audit, canonical, strip_added_comment_markers
from .source_outline import compare_financial_formulas, compare_outlines, heading_role, outline, style_map
from .period_definitions import check_definitions
from .document_size import compare_size
from .template_manifest import sha
from .word_patch import paragraph_text, q, xml

VERSION = 'word-quality-v1'
NUMBER = re.compile(r'[0-9０-９]+(?:[.,，．][0-9０-９]+)*')
PERIOD_TEXT = re.compile(r'(?<!\d)(?:19|20)\d{2}(?:[-/.]\d{1,2}[-/.]\d{1,2}|年(?:\d{1,2}(?:[-—–~至]\d{1,2})?月(?:\d{1,2}日|末)?)?)?(?!\d)')


def normalized(text):
    # Updating a reporting period or a financial value is not loss of prose.
    return re.sub(r'\s+', '', NUMBER.sub('#', text))


def ratio(after, before):
    return round(after / before, 6) if before else 1.0


def shingles(text):
    text = normalized(text)
    return Counter(text[index:index + 8] for index in range(max(0, len(text) - 7)))


def retention(before, after):
    old, new = shingles(before), shingles(after)
    return ratio(sum((old & new).values()), sum(old.values()))


def without_periods(text):
    return re.sub(r'\s+', '', PERIOD_TEXT.sub('', text))


def outline_text(text):
    # Reporting dates may change; chapter numbers and numeric section titles
    # are part of the template and must never collapse to the same fingerprint.
    return re.sub(r'\s+', '', PERIOD_TEXT.sub('#PERIOD#', text))


def effective(parts):
    return {name: resolve_revisions(xml(raw), True) for name, raw in parts.items() if STORY.fullmatch(name)}


def stats(roots):
    paragraphs = [paragraph_text(p) for root in roots.values() for p in root.iter(q('p'))]
    body = roots['word/document.xml']
    return {'characters': sum(len(re.sub(r'\s+', '', text)) for text in paragraphs),
            'nonempty_paragraphs': sum(bool(text.strip()) for text in paragraphs),
            'tables': len(list(body.iter(q('tbl')))), 'rows': len(list(body.iter(q('tr')))),
            'cells': len(list(body.iter(q('tc')))),
            'sections': len(list(body.iter(q('sectPr'))))}


def chapters(parts, root, *, include_heading=True):
    """Group body content by source headings, independently of operation claims."""
    styles, result, key = style_map(parts), {}, ('preamble', 0)
    seen = Counter()
    result[key] = []
    for p in root.iter(q('p')):
        if any(a.tag == q('txbxContent') for a in p.iterancestors()):
            continue
        role = heading_role(p, styles)
        text = paragraph_text(p)
        if role and role['kind'] == 'heading' and not any(a.tag == q('tc') for a in p.iterancestors()):
            title = outline_text(text)
            seen[title] += 1
            key = (title, seen[title])
            result[key] = []
            if not include_heading:
                continue
        result[key].append(text)
    return {key: '\n'.join(texts) for key, texts in result.items()}


def same_part(name, before, after):
    if name.endswith(('.xml', '.rels')):
        return canonical(xml(before)) == canonical(xml(after))
    return before == after


def verify(input_path):
    report = {'version': VERSION, 'status': 'failed', 'issues': [], 'metrics': {},
              'validation_scope': ['word_pair_consistency', 'source_structure', 'source_body_presence', 'source_format_preservation'],
              'content_policy': 'template_structure_flexible_text_v1',
              'factual_accuracy': 'not_verified', 'visual_review': 'not_run',
              'limitations': ['Financial facts and legal conclusions require source-evidence acceptance.',
                              'OOXML page-count metadata is not rendered pagination; no visual acceptance is claimed.']}

    def issue(code, **details):
        report['issues'].append({'code': code, **details})

    try:
        input_path = Path(input_path)
        if input_path.is_symlink() or input_path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError('WORD_QUALITY_INPUT_INVALID')
        data = json.loads(input_path.read_text(encoding='utf-8'))
        root = input_path.parent.resolve()

        def path(value):
            if not isinstance(value, str) or not value:
                raise ValueError('WORD_QUALITY_PATH_INVALID')
            candidate = root / value
            if candidate.is_symlink() or not candidate.resolve().is_relative_to(root):
                raise ValueError('WORD_QUALITY_PATH_INVALID')
            return candidate

        outputs = data['output']
        tracked_path, clean_path = path(outputs['tracked']), path(outputs['clean'])
        tracked, clean = package(tracked_path), package(clean_path)
        report['tracked_sha256'] = sha(tracked_path.read_bytes())
        report['clean_sha256'] = sha(clean_path.read_bytes())
        for name, raw in clean.items():
            if STORY.fullmatch(name) and any(n.tag in REV for n in xml(raw).iter()):
                issue('WORD_CLEAN_HAS_REVISIONS', part=name)
        accepted, cleaned = effective(tracked), effective(clean)
        for name in sorted(accepted.keys() | cleaned.keys()):
            if name not in accepted or name not in cleaned or canonical(accepted[name]) != canonical(cleaned[name]):
                issue('WORD_ACCEPT_MISMATCH', part=name)
        # A text-equal pair with different styles, tables, assets or relationships
        # still renders differently. Check those independent package resources.
        for name in sorted(tracked.keys() | clean.keys()):
            if STORY.fullmatch(name) or name in {'docProps/core.xml', 'docProps/app.xml'}:
                continue
            if name not in tracked or name not in clean or not same_part(name, tracked[name], clean[name]):
                issue('WORD_PAIR_RESOURCE_MISMATCH', part=name)
        result_stats = stats(cleaned)
        report['metrics']['output'] = result_stats
        if not result_stats['characters']:
            issue('WORD_EMPTY_MANUSCRIPT')

        periods = check_definitions(data, cleaned['word/document.xml'])
        report['period_definition_check'] = periods
        report['validation_scope'].append('explicit_current_period_definitions')
        if periods['conflicts']:
            issue('WORD_REPORTING_PERIOD_DEFINITION_CONFLICT', definitions=periods['conflicts'])

        kind = data.get('baseline_kind', 'none')
        source_value = data.get('baseline_path')
        if kind == 'none':
            if any(n.tag in REV for name, raw in tracked.items() if STORY.fullmatch(name) for n in xml(raw).iter()):
                issue('WORD_FALSE_BASELINE')
            report['limitations'].append('No source manuscript exists; source retention cannot be checked.')
        elif kind not in {'uploaded_source', 'project_output', 'reconstructed_pdf'}:
            issue('WORD_QUALITY_BASELINE_KIND_INVALID')
        elif source_value is None:
            issue('WORD_QUALITY_BASELINE_REQUIRED')
        else:
            source_path = path(source_value)
            source = package(source_path)
            source_hash = sha(source_path.read_bytes())
            report['baseline_sha256'] = source_hash
            expected_hash = data.get('baseline_sha256')
            if expected_hash is not None and expected_hash != source_hash:
                issue('WORD_BASELINE_CHANGED')
            if outputs.get('baseline') and path(outputs['baseline']).read_bytes() != source_path.read_bytes():
                issue('WORD_BASELINE_CHANGED')
            before_roots = effective(source)
            source_stats = stats(before_roots)
            report['metrics']['baseline'] = source_stats
            report['metrics']['ratios'] = {key: ratio(result_stats[key], value) for key, value in source_stats.items()}
            for key, threshold in [('nonempty_paragraphs', .85),
                                   ('tables', 1), ('rows', .95), ('cells', .95), ('sections', 1)]:
                if source_stats[key] and result_stats[key] < source_stats[key] * threshold:
                    issue('WORD_SOURCE_CONTENT_REDUCED', metric=key,
                          before=source_stats[key], after=result_stats[key], minimum_ratio=threshold)
            before_text = '\n'.join(paragraph_text(p) for name in sorted(before_roots) for p in before_roots[name].iter(q('p')))
            after_text = '\n'.join(paragraph_text(p) for name in sorted(cleaned) for p in cleaned[name].iter(q('p')))
            if data.get('update_required') is True:
                # A cross-period task cannot complete by copying the old files,
                # writing comments, or relabelling old facts with a new date.
                # This is an incomplete-update detector, not fact verification.
                if before_text == after_text:
                    issue('WORD_REPORTING_UPDATE_INCOMPLETE', reason='no_substantive_text_update')
                elif without_periods(before_text) == without_periods(after_text):
                    issue('WORD_REPORTING_UPDATE_INCOMPLETE', reason='reporting_dates_only')
            coverage = retention(before_text, after_text)
            report['metrics']['prose_retention'] = coverage
            # Text overlap/length are diagnostic only. Cross-issuer and cross-
            # product updates can legitimately replace every word in a section.
            structural = compare_outlines(outline(source), outline(clean), flexible_text=True)
            if structural['status'] != 'unchanged':
                issue('WORD_SOURCE_OUTLINE_CHANGED')
            report['metrics']['outline_status'] = structural['status']
            formulas = compare_financial_formulas(source, clean)
            if formulas['status'] != 'unchanged':
                issue('WORD_SOURCE_FORMULA_CHANGED', formulas=formulas['changes'][:100])
            report['metrics']['formula_status'] = formulas['status']
            old_chapters = chapters(source, before_roots['word/document.xml'], include_heading=False)
            new_chapters = list(chapters(clean, cleaned['word/document.xml'], include_heading=False).values())
            deficient = []
            for index, (key, old_text) in enumerate(old_chapters.items()):
                if not old_text.strip():
                    continue
                # Headings retain their structural slots, not their old wording.
                # Missing/reordered slots are independently rejected above.
                new_text = new_chapters[index] if index < len(new_chapters) else ''
                size = ratio(len(normalized(new_text)), len(normalized(old_text)))
                kept = retention(old_text, new_text)
                if not new_text.strip():
                    deficient.append({'chapter_index': index, 'reason': 'empty_body',
                                      'character_ratio': size, 'prose_retention': kept})
            if deficient:
                issue('WORD_SOURCE_CHAPTER_CONTENT_LOST', chapters=deficient[:100])
            old_tables = list(before_roots['word/document.xml'].iter(q('tbl')))
            new_tables = list(cleaned['word/document.xml'].iter(q('tbl')))
            emptied = [index for index, (old, new) in enumerate(zip(old_tables, new_tables))
                       if any(paragraph_text(p).strip() for p in old.iter(q('p')))
                       and not any(paragraph_text(p).strip() for p in new.iter(q('p')))]
            if emptied:
                issue('WORD_SOURCE_TABLE_CONTENT_LOST', table_indices=emptied[:100])

            author = data.get('revision_author')
            if not isinstance(author, str) or not author:
                issue('WORD_QUALITY_AUTHOR_REQUIRED')
            elif data.get('operations_path'):
                operations_path = path(data['operations_path'])
                diagnostics = audit(source_path, tracked_path, author, input_path, operations_path)
                for finding in diagnostics['issues']:
                    issue('WORD_SOURCE_FORMAT_CHANGED', finding=finding)
                if diagnostics['status'] not in {'passed', 'failed'}:
                    issue('WORD_SOURCE_FORMAT_CHECK_UNAVAILABLE')
            else:
                # Legacy direct authoring has no trusted operation replay. Reject
                # this run's revisions and prove the locked original is restored.
                for name, raw in source.items():
                    if name not in tracked:
                        issue('WORD_BASELINE_ASSET_LOST', part=name)
                        continue
                    if STORY.fullmatch(name):
                        old_root, reverted = xml(raw), resolve_revisions(xml(tracked[name]), False, only_new=author)
                        marker_tags = {q('commentRangeStart'), q('commentRangeEnd'), q('commentReference')}
                        old_ids = {n.get(q('id')) for n in old_root.iter() if n.tag in marker_tags}
                        new_ids = {n.get(q('id')) for n in reverted.iter() if n.tag in marker_tags} - old_ids
                        strip_added_comment_markers(reverted, new_ids)
                        if canonical(old_root) != canonical(reverted):
                            issue('WORD_REJECT_OR_FORMAT_MISMATCH', part=name)
                    elif name == 'word/comments.xml':
                        old_comments = {n.get(q('id')): canonical(n) for n in xml(raw)}
                        new_comments = {n.get(q('id')): canonical(n) for n in xml(tracked[name])}
                        if any(new_comments.get(key) != value for key, value in old_comments.items()):
                            issue('WORD_BASELINE_COMMENT_CHANGED', part=name)
                    elif name in {'docProps/core.xml', 'docProps/app.xml'}:
                        continue
                    elif name.endswith('.rels') or name == '[Content_Types].xml':
                        old_root, new_root = xml(raw), xml(tracked[name])
                        old_items = [canonical(n) for n in old_root]
                        new_items = [canonical(n) for n in new_root]
                        if any(item not in new_items for item in old_items):
                            issue('WORD_SOURCE_FORMAT_CHANGED', part=name)
                        extra = [n for n in new_root if canonical(n) not in old_items]
                        if any(not (n.get('Type', '').endswith('/comments') or n.get('PartName') == '/word/comments.xml') for n in extra):
                            issue('WORD_SOURCE_FORMAT_CHANGED', part=name)
                    elif not same_part(name, raw, tracked[name]):
                        issue('WORD_SOURCE_FORMAT_CHANGED', part=name)
            if kind == 'reconstructed_pdf':
                report['limitations'].append('PDF retention is checked against the reconstructed editable baseline, not original PDF rendering.')
                original_pdf = data.get('original_pdf_path')
                if not original_pdf:
                    issue('WORD_PDF_SOURCE_REQUIRED')
                else:
                    from pypdf import PdfReader
                    original_path = path(original_pdf)
                    if original_path.stat().st_size > 100 * 1024 * 1024:
                        raise ValueError('WORD_PDF_SOURCE_TOO_LARGE')
                    reader = PdfReader(original_path)
                    if reader.is_encrypted or not 0 < len(reader.pages) <= 1000:
                        raise ValueError('WORD_PDF_SOURCE_UNSUPPORTED')
                    page_text = [(page.extract_text() or '').strip() for page in reader.pages]
                    original_text = '\n'.join(page_text)
                    readable_pages = sum(len(normalized(text)) >= 40 for text in page_text)
                    report['original_pdf_sha256'] = sha(original_path.read_bytes())
                    report['metrics']['pdf'] = {'pages': len(page_text), 'readable_pages': readable_pages,
                                                 'characters': len(normalized(original_text))}
                    if len(normalized(original_text)) < 80 or readable_pages < len(page_text) * .9:
                        issue('WORD_PDF_TEXT_VERIFICATION_UNAVAILABLE')
                        report['limitations'].append('Scanned or partially unreadable PDF needs independently verified OCR; model-written reconstruction alone cannot prove retention.')
                    else:
                        for label, candidate in [('baseline', before_text), ('clean', after_text)]:
                            retained = retention(original_text, candidate)
                            length_ratio = ratio(len(normalized(candidate)), len(normalized(original_text)))
                            report['metrics']['pdf'][label] = {'character_ratio': length_ratio, 'prose_retention': retained}
                            # Reconstruction must faithfully capture the PDF;
                            # subsequent authored prose follows the same flexible
                            # policy as a DOCX source.
                            if label == 'baseline' and (retained < .65 or length_ratio < .8):
                                issue('WORD_PDF_SOURCE_CONTENT_LOST', output=label, retained_ratio=retained, character_ratio=length_ratio)
                    report['limitations'].append('Original PDF text was checked independently; original PDF visual layout remains unverified.')

            # This whole-manuscript floor is independent of lexical overlap and
            # per-section wording. A model-provided page count cannot bypass it.
            extent = compare_size(source, clean, already_rejected=bool(report['issues']))
            report['document_size_check'] = extent
            report['validation_scope'].append('whole_document_size')
            for finding in extent['issues']:
                report['issues'].append(finding)

        # Trusted release fixtures may add factual acceptance anchors. Their
        # absence is explicitly not an assertion of financial correctness.
        expected = data.get('expected_text', [])
        if not isinstance(expected, list):
            raise ValueError('WORD_QUALITY_EXPECTATION_INVALID')
        for index, anchor in enumerate(expected):
            if not isinstance(anchor, dict) or not isinstance(anchor.get('text'), str) or not anchor['text']:
                raise ValueError('WORD_QUALITY_EXPECTATION_INVALID')
            part = anchor.get('part', 'word/document.xml')
            text = '\n'.join(paragraph_text(p) for p in cleaned[part].iter(q('p'))) if part in cleaned else ''
            count = text.count(anchor['text'])
            if count != anchor.get('occurrences', 1):
                issue('WORD_EXPECTED_FACT_MISMATCH', expectation_index=index, actual_occurrences=count)
        if expected:
            report['factual_accuracy'] = 'provided_anchors_checked_only'
        report['status'] = 'failed' if report['issues'] else 'passed'
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_QUALITY_CHECK_FAILED'
        issue(code)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    result = verify(args.input)
    print(json.dumps(result, ensure_ascii=False))
    if result['status'] != 'passed':
        print(json.dumps({'error': 'WORD_QUALITY_REJECTED'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
