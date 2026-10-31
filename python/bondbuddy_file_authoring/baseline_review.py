"""Check the actual editing source and both Word editions without gating downloads.

Also callable inside the existing CLI execution to repair a draft before finishing.
Checks are mechanical invariants, never a professional/content approval.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path

from .check import REV, STORY, package, parse_xml, sha, stories


def audit_pair(baseline, tracked, clean, author, input_path=None, operations_path=None):
    report = {"version": "word-baseline-review-v1", "status": "not_run",
              "validation_scope": "original_source_and_word_pair", "issues": [],
              "content_review": "not_performed", "visual_review": "not_run"}
    try:
        if not isinstance(author, str) or not author or len(author) > 128:
            raise ValueError("WORD_FORMAT_AUTHOR_REQUIRED")
        original, revised, accepted = [package(Path(p)) for p in (baseline, tracked, clean)]
        report["sha256"] = {name: sha(Path(path).read_bytes())
                            for name, path in (("baseline", baseline), ("tracked", tracked), ("clean", clean))}
        checks = report["checks"] = {}
        old_stories, new_stories = stories(original, True), stories(accepted)
        checks["reject_current_restores_original"] = stories(revised, False, author) == old_stories
        checks["accept_all_matches_clean"] = stories(revised, True) == new_stories
        checks["clean_has_no_revisions"] = not any(
            n.tag in REV for name, raw in accepted.items() if STORY.fullmatch(name)
            for n in parse_xml(raw).iter())
        checks["original_assets_preserved"] = all(
            revised.get(name) == raw and accepted.get(name) == raw
            for name, raw in original.items() if name.startswith(("word/media/", "word/embeddings/", "word/fonts/")))
        codes = {"reject_current_restores_original": "WORD_REJECT_MISMATCH",
                 "accept_all_matches_clean": "WORD_ACCEPT_MISMATCH",
                 "clean_has_no_revisions": "WORD_CLEAN_HAS_REVISIONS",
                 "original_assets_preserved": "WORD_BASELINE_ASSET_LOST"}
        report["issues"] = [{"code": codes[key]} for key, passed in checks.items() if not passed]
        # Counts include every story/paragraph, including cells. They describe exact
        # text reuse, not whether changed facts were correct or changes necessary.
        report["text_inventory"] = []
        for part in sorted(old_stories.keys() | new_stories.keys()):
            old = Counter(p for p in old_stories.get(part, ([], [], []))[0] if p.strip())
            new = Counter(p for p in new_stories.get(part, ([], [], []))[0] if p.strip())
            reused = old & new
            report["text_inventory"].append({"part": part, "source_paragraphs": sum(old.values()),
                "clean_paragraphs": sum(new.values()), "exact_text_reused": sum(reused.values()),
                "source_text_not_reused": sum((old - new).values()),
                "new_or_changed_text": sum((new - old).values())})
        failed = bool(report["issues"])
        if input_path is not None or operations_path is not None:
            from .format_diff import audit
            report["format_review"] = audit(baseline, tracked, author, input_path, operations_path)
            report["issues"].extend(report["format_review"].get("issues", []))
        format_status = report.get("format_review", {}).get("status", "passed")
        report["status"] = "failed" if failed else format_status
    except Exception as exc:
        report["status"] = "unsupported"
        message = str(exc)
        code = message if isinstance(exc, ValueError) and message.startswith("WORD_") and message.replace("_", "").isalnum() else "WORD_BASELINE_CHECK_UNAVAILABLE"
        report["issues"].append({"code": code})
    return report


def review_workspace(input_path):
    """Use read-only input.json's source, never a model-authored baseline copy."""
    input_path = Path(input_path).resolve()
    root = input_path.parent
    data = json.loads(input_path.read_text(encoding="utf-8"))
    source = data.get("baseline_path")
    if not source or data.get("baseline_kind") in ("none", "reconstructed_pdf"):
        return {"version": "word-baseline-review-v1", "status": "unsupported",
                "issues": [{"code": "WORD_ORIGINAL_DOCX_UNAVAILABLE"}],
                "content_review": "not_performed", "visual_review": "not_run"}
    source = root / source
    expected = data.get("baseline_sha256") or next(
        (m["sha256"] for m in data.get("materials", []) if m.get("path") == data["baseline_path"]), None)
    if expected is None or sha(source.read_bytes()) != expected:
        raise ValueError("WORD_BASELINE_CHANGED")
    controlled = data.get("format_tools", {}).get("version") == "controlled-docx-v1"
    operations = root / "output/operations.json" if controlled else None
    if controlled:
        from .fixed_edit import finalize
        output = root / "scratch/baseline-review"
        finalize(input_path, operations, output, skip_report=True)
        tracked, clean = output / "tracked.docx", output / "clean.docx"
    else:
        tracked, clean = [root / data["output"][name] for name in ("tracked", "clean")]
    return audit_pair(source, tracked, clean, data["revision_author"],
                      input_path if controlled else None, operations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--tracked", type=Path)
    parser.add_argument("--clean", type=Path)
    parser.add_argument("--author")
    parser.add_argument("--operations", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.baseline:
        if not args.tracked or not args.clean or not args.author:
            parser.error("--baseline requires --tracked, --clean and --author")
        report = audit_pair(args.baseline, args.tracked, args.clean, args.author, args.input, args.operations)
    elif args.input:
        report = review_workspace(args.input)
    else:
        parser.error("--input or --baseline is required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "issues": report["issues"]}, ensure_ascii=False))
    return 0  # Findings are report data and cannot disable already generated downloads.


if __name__ == "__main__":
    raise SystemExit(main())
