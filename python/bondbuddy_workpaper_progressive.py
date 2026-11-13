"""Validate small chapter plans and project independent, full-source item plans.

This module does not extract, summarize, or modify source evidence. The existing
workpaper validator remains the authority for each accepted item's contents.
Only facts explicitly assigned to another item in the same model plan can become
additional exclusions; missing group coverage is never silently manufactured.
"""
import base64
import copy
import hashlib
import re
import sys

from bondbuddy_workpaper_batch import expanded_facts, load, require, save, validate
from bondbuddy_workpaper_source import VERSION

RESULT_VERSION = 'workpaper-progressive-group-result-v1'
MAX_GROUP_ITEMS = 8
GLOBAL_ERRORS = frozenset({
    'WORKPAPER_PLAN_SOURCE_CHANGED', 'WORKPAPER_IMAGE_CONTENT_UNVERIFIED',
    'WORKPAPER_IMAGE_HASH_MISMATCH',
})


def fallback():
    return dict(version=RESULT_VERSION, status='fallback', items=[])


def prepare(snapshot, batch, plan):
    """Return validated item plans or a request for independent singleton plans.

    TypeBox validates the model JSON before this host-side operation. Snapshot
    and batch are immutable host inputs. Source/image safety errors propagate;
    a group-wide omission requires singleton planning from the same full source.
    """
    require(snapshot['version'] == VERSION, 'WORKPAPER_PLAN_SOURCE_CHANGED')
    require(plan['source_sha256'] == snapshot['source']['sha256'], 'WORKPAPER_PLAN_SOURCE_CHANGED')
    spans = {s['id']: s for s in snapshot['source']['spans']}
    nonempty = {sid for sid, span in spans.items() if span['text'].strip()}
    expected = {entry['id']: entry for entry in batch['entries']}
    actual = [item['item_id'] for item in plan['items']]
    # Verify picture safety before allowing a recoverable structural fallback.
    # Normal worker snapshots contain private object keys instead of inline data;
    # those bytes are independently hash-checked by the worker before invocation.
    for image in snapshot['images']:
        if image.get('data') is not None:
            try:
                raw = base64.b64decode(image['data'], validate=True)
            except (ValueError, TypeError):
                raise ValueError('WORKPAPER_IMAGE_HASH_MISMATCH') from None
            require(hashlib.sha256(raw).hexdigest() == image['sha256'], 'WORKPAPER_IMAGE_HASH_MISMATCH')
    for review in plan['image_reviews']:
        require(not review['item_ids'] or review['verified'] is True, 'WORKPAPER_IMAGE_CONTENT_UNVERIFIED')
    if (plan['version'] != 'workpaper-shared-plan-v1'
            or not 1 <= len(expected) <= MAX_GROUP_ITEMS
            or len(expected) != len(batch['entries'])
            or len(actual) != len(set(actual)) or set(actual) != set(expected)):
        return fallback()
    if (len(plan['reviewed_span_ids']) != len(set(plan['reviewed_span_ids']))
            or set(plan['reviewed_span_ids']) != nonempty):
        return fallback()
    excluded = set()
    for group in plan['excluded']:
        ids = set(group['span_ids'])
        if (len(group['reason'].strip()) < 5 or not ids <= nonempty
                or excluded.intersection(ids) or len(ids) != len(group['span_ids'])):
            return fallback()
        excluded.update(ids)

    facts = {item['item_id']: expanded_facts(snapshot, item) for item in plan['items']}
    used = set().union(*facts.values())
    if not nonempty <= used | excluded:
        return fallback()
    image_ids = {image['id'] for image in snapshot['images']}
    if (len(plan['image_reviews']) != len(image_ids)
            or {review['image_id'] for review in plan['image_reviews']} != image_ids
            or any(not set(review['item_ids']) <= set(expected)
                   or len(review['description'].strip()) < 5 for review in plan['image_reviews'])):
        return fallback()

    # The original validator disallows one generic explanation copied to multiple
    # items. Preserve that cross-item constraint after splitting the plan.
    reasons = {}
    for item in plan['items']:
        if item['decision']['status'] != 'generate':
            reasons.setdefault(item['decision']['reason'], []).append(item['item_id'])
    duplicates = {item_id for group in reasons.values() if len(group) > 1 for item_id in group}
    projected = []
    for item in plan['items']:
        item_id = item['item_id']
        single = copy.deepcopy(plan)
        single['items'] = [copy.deepcopy(item)]
        # Retain original exclusions verbatim, including an erroneous conflict.
        # validate() must reject that item's conflict, never silently erase it.
        other_facts = used - facts[item_id] - excluded
        additional = [sid for sid in plan['reviewed_span_ids'] if sid in other_facts]
        if additional:
            if len(single['excluded']) >= 10000:
                return fallback()
            single['excluded'].append(dict(
                span_ids=additional,
                reason='本段已在同组其他底稿的事实清单中映射，当前底稿未选用；保留原始映射供内部核对。',
            ))
        for review in single['image_reviews']:
            review['item_ids'] = [item_id] if item_id in review['item_ids'] else []
        single_batch = {**batch, 'entries': [expected[item_id]]}
        try:
            require(item_id not in duplicates, 'WORKPAPER_DUPLICATE_EXPLANATION')
            validate(snapshot, single_batch, single)
        except ValueError as error:
            code = str(error)
            if code in GLOBAL_ERRORS:
                raise
            # Unknown exceptions are infrastructure failures. They are not safe
            # evidence that a specific file failed its content validation.
            if not re.fullmatch(r'WORKPAPER_[A-Z_]+', code):
                raise
            projected.append(dict(item_id=item_id, error=code))
        else:
            projected.append(dict(item_id=item_id, plan=single))
    return dict(version=RESULT_VERSION, status='items', items=projected)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 6 and sys.argv[1] == 'prepare', 'WORKPAPER_PROGRESSIVE_OPERATION_INVALID')
        save(sys.argv[5], prepare(load(sys.argv[2]), load(sys.argv[3]), load(sys.argv[4])))
    except ValueError as error:
        if re.fullmatch(r'WORKPAPER_[A-Z_]+', str(error)):
            print('BB_WORKPAPER_ERROR=' + str(error), file=sys.stderr)
            raise SystemExit(2) from None
        raise
