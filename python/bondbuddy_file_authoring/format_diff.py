"""Non-blocking format diagnostics independent of file availability validation."""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

from .check import STORY, package, resolve_revisions
from .template_manifest import sha
from .word_patch import q, xml

VERSION = 'word-format-report-v1'


def attributes(node):
    # Word save-session IDs are not formatting. IDs, relationships and properties are.
    return tuple(sorted((key, value) for key, value in node.attrib.items()
                        if not key.startswith(q('rsid'))))


def compact_children(children):
    result = []
    for item in children:
        # Real revisions can split an original run and its text leaf. Merge only
        # adjacent equivalent runs/leaves; preserve field and bookmark boundaries.
        if result and item[0] == q('r') and result[-1][0] == q('r') and item[1:3] == result[-1][1:3]:
            previous = result[-1]
            left, right = list(previous[3]), list(item[3])
            lp = left.pop(0) if left and left[0][0] == q('rPr') else None
            rp = right.pop(0) if right and right[0][0] == q('rPr') else None
            if lp == rp:
                result[-1] = (item[0], item[1], item[2], tuple(([lp] if lp else []) + compact_children(left + right)))
                continue
        if result and item[0] in {q('t'), q('delText')} and result[-1][0] == item[0]:
            previous = result[-1]
            # xml:space describes whitespace preservation, which is already in text.
            if not item[3] and not previous[3]:
                result[-1] = (item[0], (), previous[2] + item[2], ())
                continue
        result.append(item)
    return result


def canonical(node):
    props = attributes(node)
    if node.tag in {q('t'), q('delText')}:
        props = tuple((key, value) for key, value in props if key != '{http://www.w3.org/XML/1998/namespace}space')
    children = compact_children([canonical(c) for c in node if isinstance(c.tag, str)])
    return node.tag, props, node.text or '', tuple(children)


def changed_properties(before, after):
    """Name the actual format area without including issuer or body text."""
    groups = [('paragraph_properties', 'pPr'), ('character_properties', 'rPr'),
              ('table_properties', 'tblPr'), ('table_grid', 'tblGrid'),
              ('cell_properties', 'tcPr'), ('row_properties', 'trPr'), ('section_properties', 'sectPr')]
    changed = []
    for label, tag in groups:
        if [canonical(n) for n in before.iter(q(tag))] != [canonical(n) for n in after.iter(q(tag))]:
            changed.append(label)
    return changed or ['content_or_structure']


def replay_signature(root, author):
    root = copy.deepcopy(root)
    for node in root.iter():
        if node.tag in {q('ins'), q('del'), q('moveFrom'), q('moveTo'), q('comment'), q('pPrChange'), q('rPrChange'), q('trPrChange')} and node.get(q('author')) == author:
            # Trusted replay allocates fresh timestamps and revision IDs. They do
            # not affect visual properties or the content of the recorded edit.
            node.attrib.pop(q('date'), None)
            if node.tag != q('comment'):
                node.attrib.pop(q('id'), None)
    return canonical(root)


def strip_added_comment_markers(root, ids):
    for node in list(root.iter()):
        if node.tag not in {q('commentRangeStart'), q('commentRangeEnd'), q('commentReference')} or node.get(q('id')) not in ids:
            continue
        parent = node.getparent()
        parent.remove(node)
        if parent.tag == q('r') and all(child.tag == q('rPr') for child in parent):
            parent.getparent().remove(parent)


def audit(baseline_path, tracked_path, author, input_path=None, operations_path=None):
    """Reject only this author's revisions, then compare original formatting.

    This validates preservation relative to the baseline. It does not determine
    whether an insertion is commercially necessary, nor perform a visual review.
    """
    result = {'version': VERSION, 'status': 'not_run', 'validation_scope': 'source_format_preservation',
              'visual_review': 'not_run', 'content_review': 'not_performed', 'issues': []}
    try:
        before = package(Path(baseline_path))
        after = package(Path(tracked_path))
        result['baseline_sha256'] = sha(Path(baseline_path).read_bytes())
        result['tracked_sha256'] = sha(Path(tracked_path).read_bytes())
        from .source_outline import outline, compare_outlines
        result['source_structure'] = compare_outlines(outline(before), outline(after))
        if result['source_structure']['status'] == 'changed':
            result['issues'].append({'code': 'SOURCE_OUTLINE_CHANGED', 'part': 'word/document.xml',
                                     'review': 'Verify explicit user scope or necessary target disclosure; recorded edits alone do not prove authorization.'})
        if not isinstance(author, str) or not author:
            raise ValueError('WORD_FORMAT_AUTHOR_REQUIRED')
        expected, new_comment_ids = None, set()
        if input_path is not None or operations_path is not None:
            if input_path is None or operations_path is None or not Path(operations_path).is_file():
                raise ValueError('WORD_FORMAT_REPLAY_INPUT_REQUIRED')
            from .fixed_edit import load_editor
            data, source, raw, log, editor = load_editor(input_path, operations_path)
            if sha(raw) != result['baseline_sha256'] or data['revision_author'] != author:
                raise ValueError('WORD_FORMAT_REPLAY_INPUT_MISMATCH')
            expected = editor.tracked_parts()
            from .format_plan import plan_summary
            result['format_adjustments'] = plan_summary(editor.format_plan)
            old_ids = {n.get(q('id')) for n in xml(before['word/document.xml']).iter()
                       if n.tag in {q('commentRangeStart'), q('commentRangeEnd'), q('commentReference')}}
            new_comment_ids = {n.get(q('id')) for n in xml(expected['word/document.xml']).iter()
                               if n.tag in {q('commentRangeStart'), q('commentRangeEnd'), q('commentReference')}} - old_ids
            result['operation_count'] = len(log['operations'])
            result['validation_scope'] = 'source_format_and_recorded_edits'
        for part in sorted(before.keys() | after.keys()):
            if expected is not None and not STORY.fullmatch(part) and part in expected and part in after:
                if part.endswith(('.xml', '.rels')):
                    expected_equal = replay_signature(xml(expected[part]), author) == replay_signature(xml(after[part]), author)
                else:
                    expected_equal = expected[part] == after[part]
                if expected_equal:
                    continue
                # Reverting a recorded resource change to baseline bytes is still
                # drift (for example, dropping a newly added existing-part comment
                # or its relationship). Do not let baseline equality hide it.
                result['issues'].append({'code': 'RECORDED_EDIT_FORMAT_MISMATCH' if part.endswith(('.xml', '.rels'))
                                         else 'RECORDED_EDIT_RESOURCE_MISMATCH', 'part': part})
                continue
            if part not in before or part not in after:
                result['issues'].append({'code': 'PACKAGE_PART_ADDED' if part not in before else 'PACKAGE_PART_LOST', 'part': part})
                continue
            if before[part] == after[part]:
                continue
            if STORY.fullmatch(part):
                old, new = xml(before[part]), xml(after[part])
                resolve_revisions(new, False, only_new=author)
                strip_added_comment_markers(new, new_comment_ids)
                if expected is not None:
                    from .format_plan import restore_absent_property_shells
                    restore_absent_property_shells(new, editor.format_plan, part)
                if canonical(old) != canonical(new):
                    result['issues'].append({'code': 'UNEXPECTED_SOURCE_CHANGE', 'part': part,
                                             'areas': changed_properties(old, new)})
            elif part.endswith(('.xml', '.rels')):
                if canonical(xml(before[part])) != canonical(xml(after[part])):
                    result['issues'].append({'code': 'PACKAGE_PROPERTIES_CHANGED', 'part': part})
            else:
                result['issues'].append({'code': 'PACKAGE_RESOURCE_CHANGED', 'part': part})
        if expected is not None:
            for part in sorted(expected.keys() - after.keys()):
                result['issues'].append({'code': 'RECORDED_EDIT_PART_MISSING', 'part': part})
            for part in sorted(expected.keys() & after.keys()):
                if STORY.fullmatch(part) and replay_signature(xml(expected[part]), author) != replay_signature(xml(after[part]), author):
                    result['issues'].append({'code': 'RECORDED_EDIT_FORMAT_MISMATCH', 'part': part})
        result['status'] = 'failed' if result['issues'] else 'passed'
    except Exception as exc:
        result['status'] = 'unsupported'
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_FORMAT_CHECK_UNAVAILABLE'
        result['issues'].append({'code': code})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--tracked', required=True)
    parser.add_argument('--author', required=True)
    parser.add_argument('--output')
    parser.add_argument('--input')
    parser.add_argument('--operations')
    args = parser.parse_args()
    result = audit(args.baseline, args.tracked, args.author, args.input, args.operations)
    if args.output:
        from .fixed_edit import write_json
        write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False))
    # A diagnostic finding is data, not a failed document-delivery command.
    return 0


if __name__ == '__main__':
    sys.exit(main())
