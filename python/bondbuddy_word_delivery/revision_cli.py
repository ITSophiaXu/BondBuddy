"""Bounded Word tool for a CLI-led, explicitly accepted M3 revision.

The CLI chooses the changes and invokes this tool. The host invokes the same pure
renderer only to verify that submitted packages contain exactly those changes.
It never selects findings, generates text, or performs another model call.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

# In a run workspace the required writer packages are pinned alongside this tool.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bondbuddy_word_delivery.unified import render

VERSION = "review-revision-cli-v1"
MAX_JSON = 32 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def fail(code="WORD_REVISION_SCOPE_MISMATCH"):
    raise ValueError(code)


def check(condition, code="WORD_REVISION_SCOPE_MISMATCH"):
    if not condition:
        fail(code)


def exact(value, names):
    check(isinstance(value, dict) and set(value) == set(names))


def strings(value, maximum=2000):
    return (isinstance(value, list) and len(value) <= maximum
            and all(isinstance(item, str) and 0 < len(item) <= 12000 for item in value)
            and len(set(value)) == len(value))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def json_object(pairs):
    result = {}
    for key, value in pairs:
        check(key not in result, "WORD_REVISION_JSON_INVALID")
        result[key] = value
    return result


def regular(path, maximum=MAX_FILE):
    check(not path.is_symlink() and path.is_file(), "WORD_OUTPUT_UNSAFE")
    stat = path.stat()
    check(stat.st_nlink == 1 and 0 < stat.st_size <= maximum, "WORD_OUTPUT_UNSAFE")
    return path.read_bytes()


def read_json(path):
    return json.loads(regular(path, MAX_JSON).decode("utf-8"), object_pairs_hook=json_object)


def scoped(root, relative, base=None):
    check(isinstance(relative, str) and not Path(relative).is_absolute(), "WORD_OUTPUT_UNSAFE")
    path = root / relative
    check(path.resolve().is_relative_to(base or root), "WORD_OUTPUT_UNSAFE")
    check(not any(part == ".." for part in Path(relative).parts), "WORD_OUTPUT_UNSAFE")
    return path


def request_for(data, proposal):
    """Validate only permissions/provenance and derive handling from actual edits."""
    check(data["version"] == VERSION)
    pin = data["revision"]
    records = {record["record_id"]: record for record in data["records"]}
    selected = {finding["finding_id"]: finding for finding in pin["selected_findings"]}
    check(len(selected) == len(pin["selected_findings"]))
    executable = set(data["executable_finding_ids"])
    check(executable.issubset(selected))
    allowed = {record_id for fid in executable for record_id in selected[fid]["repairability"]["allowed_record_ids"]}
    check(allowed.issubset(records))
    evidence = {}
    for fid, finding in selected.items():
        evidence[fid] = {f'{ref["material_id"]}/{ref["record_id"]}' for ref in finding["evidence_refs"]}
        evidence[fid].update(f'rule:{ref["pack_id"]}@{ref["pack_sha256"]}/{ref["rule_id"]}@{ref["rule_version"]}'
                             for ref in finding.get("rule_refs", []))

    exact(proposal, ("version", "input_hash", "reviewed", "edits", "additions", "handling", "summary"))
    check(proposal["version"] == VERSION and proposal["input_hash"] == data["input_hash"])
    check(strings(proposal["reviewed"]) and set(proposal["reviewed"]) == allowed)
    check(strings(proposal["summary"], 200))
    check(isinstance(proposal["edits"], list) and len(proposal["edits"]) <= 2000)
    check(isinstance(proposal["additions"], list) and len(proposal["additions"]) <= 2000)
    changes = {fid: [] for fid in selected}
    refs_used = {fid: [] for fid in selected}

    def linked(finding_ids, record_id, refs):
        check(strings(finding_ids) and finding_ids and set(finding_ids).issubset(executable))
        check(record_id in allowed and strings(refs) and refs)
        check(all(record_id in selected[fid]["repairability"]["allowed_record_ids"] for fid in finding_ids))
        check(all(set(refs) & evidence[fid] for fid in finding_ids))
        check(set(refs).issubset(set().union(*(evidence[fid] for fid in finding_ids))))
        for fid in finding_ids:
            changes[fid].append(record_id)
            refs_used[fid].extend(ref for ref in refs if ref in evidence[fid])

    edits, additions, seen = [], [], set()
    source_id = pin["source_material"]["material_id"]
    for edit in proposal["edits"]:
        exact(edit, ("record_id", "after", "evidence", "finding_ids"))
        record_id = edit["record_id"]
        check(isinstance(record_id, str) and record_id not in seen and record_id in records)
        seen.add(record_id)
        check(isinstance(edit["after"], str) and 0 < len(edit["after"]) <= 50000
              and edit["after"] != records[record_id]["literal_quote"])
        linked(edit["finding_ids"], record_id, edit["evidence"])
        edits.append({"record_id": f"{source_id}/{record_id}", "after": edit["after"], "evidence": edit["evidence"], "pending": []})
    for addition in proposal["additions"]:
        exact(addition, ("after_record_id", "blocks", "finding_ids"))
        check(isinstance(addition["blocks"], list) and 0 < len(addition["blocks"]) <= 200)
        blocks = []
        for block in addition["blocks"]:
            exact(block, ("kind", "text", "rows", "evidence"))
            linked(addition["finding_ids"], addition["after_record_id"], block["evidence"])
            check(block["kind"] in ("heading", "paragraph", "table") and isinstance(block["text"], str) and len(block["text"]) <= 50000)
            rows = block["rows"]
            check(isinstance(rows, list) and len(rows) <= 2000)
            if block["kind"] == "table":
                check(rows and isinstance(rows[0], list) and 0 < len(rows[0]) <= 100)
                check(all(isinstance(row, list) and len(row) == len(rows[0])
                          and all(isinstance(cell, str) and len(cell) <= 50000 for cell in row) for row in rows))
            else:
                check(not rows and block["text"].strip())
            blocks.append({**block, "pending": []})
        additions.append({"after_record_id": f'{source_id}/{addition["after_record_id"]}', "blocks": blocks})

    check(isinstance(proposal["handling"], list) and len(proposal["handling"]) == len(selected))
    items, handled = [], set()
    for item in proposal["handling"]:
        exact(item, ("finding_id", "status", "reason", "evidence"))
        fid = item["finding_id"]
        check(isinstance(fid, str) and fid in selected and fid not in handled)
        handled.add(fid)
        check(item["status"] in ("modified", "not_modified", "needs_evidence"))
        check(isinstance(item["reason"], str) and 0 < len(item["reason"].strip()) <= 12000)
        check(strings(item["evidence"]) and set(item["evidence"]).issubset(evidence[fid]))
        check((item["status"] == "modified") == bool(changes[fid]), "WORD_REVISION_HANDLING_MISMATCH")
        check(fid in executable or item["status"] == "needs_evidence")
        items.append({"finding_id": fid, "report_id": pin["source_report"]["report_id"], "status": item["status"], "reason": item["reason"],
                      "locations": [{"record_id": rid, "locator": records[rid]["locator"]} for rid in dict.fromkeys(changes[fid])],
                      "evidence_refs": list(dict.fromkeys(refs_used[fid] + item["evidence"])), "review_passed": False})
    for item in pin["excluded_findings"]:
        items.append({"finding_id": item["finding_id"], "report_id": pin["source_report"]["report_id"], "status": "not_modified",
                      "reason": item["reason"], "locations": [], "evidence_refs": [], "review_passed": False})
    handling = {"version": "review-revision-handling-v1", "source_report": pin["source_report"], "accepted_plan": pin["accepted_plan"],
                "source_material": pin["source_material"], "items": items, "limitations": data["limitations"], "review_passed": False}
    plan_hash = sha(encoded({"edits": edits, "blocks": [], "additions": additions}))
    return {"version": "unified-word-request-v1", "date": data["date"], "source_sha256": pin["source_material"]["sha256"],
            "media_type": data["source"]["media_type"], "records": [{"id": f'{source_id}/{r["record_id"]}', "text": r["literal_quote"], "locator": r["locator"]} for r in data["records"]],
            "edits": edits, "blocks": [], "additions": additions, "plan_hash": plan_hash,
            "revision_handling": handling, "revision_allowed_record_ids": [f"{source_id}/{rid}" for rid in sorted(allowed)]}


def generate(workspace, proposal_path):
    root = Path(workspace).resolve()
    data = read_json(root / "input.json")
    proposal_path = scoped(root, proposal_path, root / "scratch")
    proposal = read_json(proposal_path)
    request = request_for(data, proposal)
    source = scoped(root, data["source"]["path"], root / "materials")
    check(sha(regular(source)) == request["source_sha256"], "WORD_SOURCE_HASH_MISMATCH")
    output = root / "output"
    check(output.is_dir() and not output.is_symlink(), "WORD_OUTPUT_UNSAFE")
    names = ("tracked.docx", "clean.docx", "baseline.docx", "handling.json", "summary.json", "proposal.json")
    for name in names:
        path = output / name
        if path.exists() or path.is_symlink():
            regular(path)
            path.unlink()
    no_changes = not request["edits"] and not request["additions"]
    if no_changes:
        summary = {"no_changes": True, "plan_hash": request["plan_hash"], "source_sha256": request["source_sha256"]}
    else:
        # The existing PDF reconstruction writer needs a writable sibling of source.
        scratch = root / "scratch" / "revision-render"
        scratch.mkdir(exist_ok=True)
        check(not scratch.is_symlink(), "WORD_OUTPUT_UNSAFE")
        copied = scratch / "source"
        if copied.exists() or copied.is_symlink():
            regular(copied)
        shutil.copyfile(source, copied)
        summary = render(request, copied, output / "tracked.docx", output / "clean.docx", output / "baseline.docx")
    summary.update({"method": VERSION, "input_hash": data["input_hash"], "authoring_summary": proposal["summary"], "review_passed": False})
    for name, value in (("proposal.json", proposal), ("handling.json", request["revision_handling"]), ("summary.json", summary)):
        (output / name).write_bytes(encoded(value))
    return summary


def main():
    try:
        check(len(sys.argv) in (2, 4), "WORD_REVISION_ARGUMENTS")
        workspace = Path.cwd() if len(sys.argv) == 2 else Path(sys.argv[3])
        check(len(sys.argv) == 2 or sys.argv[2] == "--workspace", "WORD_REVISION_ARGUMENTS")
        print(json.dumps(generate(workspace, sys.argv[1]), ensure_ascii=False))
    except OSError:
        print("WORD_REVISION_INFRASTRUCTURE_ERROR", file=sys.stderr)
        return 2
    except (ValueError, KeyError, TypeError) as error:
        message = str(error)
        print(message if message.startswith("WORD_") and message.replace("_", "").isalnum() else "WORD_REVISION_INVALID", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
