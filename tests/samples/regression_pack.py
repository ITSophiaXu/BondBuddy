"""Offline inventory, validation and preparation of authorized regression cases.

No credentials, network requests, production imports or model calls.
"""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
DEFAULT_BATCH = ROOT / "2026-11-05"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def safe_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError(f"Invalid relative path: {relative!r}")
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError(f"Path escapes sample batch: {relative!r}")
    return path


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_batch(batch):
    batch = batch.resolve()
    manifest = read_json(batch / "manifest.json")
    if manifest.get("manifest_version") != 2:
        raise ValueError("Expected regression manifest version 2")
    if not manifest.get("authorization", {}).get("git_commit_authorized"):
        raise ValueError("Missing recorded Git authorization")
    assets = manifest["assets"]
    by_id, paths, total_bytes = {}, set(), 0
    for asset in assets:
        key = asset["file_id"]
        if key in by_id or not re.fullmatch(r"[a-z0-9][a-z0-9_-]+", key):
            raise ValueError(f"Invalid or duplicate file ID: {key}")
        path = safe_path(batch, asset["path"])
        if path in paths or path.name != asset["original_filename"]:
            raise ValueError(f"Duplicate path or changed original filename: {key}")
        if not path.is_file() or path.stat().st_size != asset["bytes"] or digest(path) != asset["sha256"]:
            raise ValueError(f"Original size/hash mismatch: {key}")
        if path.suffix.lower() in {".docx", ".xlsx"}:
            with ZipFile(path) as archive:
                required = "word/document.xml" if path.suffix.lower() == ".docx" else "xl/workbook.xml"
                if archive.testzip() is not None or required not in archive.namelist():
                    raise ValueError(f"Invalid Office package: {key}")
        elif path.suffix.lower() == ".pdf":
            with path.open("rb") as stream:
                if stream.read(5) != b"%PDF-":
                    raise ValueError(f"Invalid PDF signature: {key}")
        by_id[key] = asset
        paths.add(path)
        total_bytes += asset["bytes"]
    if len(assets) != manifest["file_count"] or total_bytes != manifest["total_bytes"]:
        raise ValueError("Manifest totals do not match originals")
    cases = manifest["cases"]
    if manifest.get("case_count", len(cases)) != len(cases):
        raise ValueError("Case count does not match manifest")
    if manifest.get("preparable_case_count", sum(c.get("preparable", True) for c in cases)) != sum(c.get("preparable", True) for c in cases):
        raise ValueError("Preparable case count does not match manifest")
    case_ids = [case["case_id"] for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("Duplicate case IDs")
    referenced = set()
    for case in cases:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]+", case["case_id"]):
            raise ValueError("Unsafe case ID")
        if case["task_type"] not in {"update", "review", "project_qa", "workpaper", "integrity"}:
            raise ValueError("Unknown task type")
        if set(case.get("source_case_ids", [])) - set(case_ids):
            raise ValueError("Unknown source case")
        file_ids = case["file_ids"]
        if len(file_ids) != len(set(file_ids)) or set(file_ids) - by_id.keys():
            raise ValueError(f"Unresolved/duplicate file binding: {case['case_id']}")
        referenced.update(file_ids)
        data = read_json(safe_path(batch, case["input_path"]))
        if data.get("case_id") != case["case_id"]:
            raise ValueError("Input belongs to another case")
        if data.get("missing_materials") and case.get("preparable", True):
            raise ValueError("Incomplete case cannot be marked preparable")
        for binding in data.get("materials", []):
            if binding["file_id"] not in file_ids:
                raise ValueError("Input material is not included in case")
        if not case.get("checks") or not case.get("readiness"):
            raise ValueError("Case lacks checks/readiness")
    if referenced != set(by_id):
        raise ValueError("Unreferenced originals in sample pack")
    for item in manifest.get("metadata_files", []):
        path = safe_path(batch, item["path"])
        if not path.is_file() or digest(path) != item["sha256"]:
            raise ValueError(f"Metadata checksum mismatch: {item['path']}")
    listed_metadata = {item["path"] for item in manifest.get("metadata_files", [])}
    if any(case["input_path"] not in listed_metadata for case in cases):
        raise ValueError("Unpinned case input")
    for case in cases:
        data = read_json(safe_path(batch, case["input_path"]))
        if data.get("source_snapshot") and data["source_snapshot"] not in listed_metadata:
            raise ValueError("Unpinned source snapshot")
    actual = {p.resolve() for p in (batch / "originals").rglob("*") if p.is_file()}
    if actual != paths:
        raise ValueError("Original files and manifest differ")
    # Transfer URLs and authentication material must never enter a committed fixture.
    for path in batch.rglob("*"):
        if path.suffix.lower() not in {".json", ".md", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"(?i)(AccountKey=|SharedAccessSignature=|[?&](?:sig|access_token)=|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN .*PRIVATE KEY-----)", text):
            raise ValueError(f"Authentication material in fixture: {path.name}")
        if re.search(r'"(?:password|access_token|refresh_token|cookie|connection_string)"\s*:', text, re.I):
            raise ValueError(f"Credential field in fixture: {path.name}")
    return manifest, paths


def prepare_case(batch, case_id, output):
    manifest, _ = verify_batch(batch)
    case = next((c for c in manifest["cases"] if c["case_id"] == case_id), None)
    if case is None:
        raise ValueError(f"Unknown case: {case_id}")
    if not case.get("preparable", True):
        raise ValueError(f"Case is incomplete: {case_id}; see its input.json and missing materials")
    output = output.resolve()
    if output.exists():
        raise ValueError("Output already exists; choose a fresh directory to preserve previous runs")
    if output.is_relative_to(batch.resolve()):
        raise ValueError("Prepared runs must stay outside the immutable sample batch")
    output.mkdir(parents=True)
    by_id = {a["file_id"]: a for a in manifest["assets"]}
    copied = []
    for key in case["file_ids"]:
        asset = by_id[key]
        relative = "materials/" + key + "/" + asset["original_filename"]
        dest = safe_path(output, relative)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(safe_path(batch, asset["path"]), dest)
        if digest(dest) != asset["sha256"]:
            raise ValueError("Prepared copy hash mismatch")
        copied.append({"file_id": key, "path": relative, "sha256": asset["sha256"]})
    source = read_json(safe_path(batch, case["input_path"]))
    if source.get("source_snapshot"):
        shutil.copyfile(safe_path(batch, source["source_snapshot"]), output / "source-inputs.json")
        source["source_snapshot"] = "source-inputs.json"
    (output / "input.json").write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    receipt = {"case_id": case_id, "sample_manifest_sha256": digest(batch / "manifest.json"),
               "source_input_sha256": digest(safe_path(batch, case["input_path"])),
               "prepared_input_sha256": digest(output / "input.json"),
               "mode": "offline_preparation_only", "business_test_status": "not_run", "files": copied,
               "instructions": "在隔离测试环境重新上传；源项目和任务 ID 仅供追踪，不向生产重放；模型/查询/积分均未执行。"}
    (output / "preparation.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    checks = "\n".join("- [ ] " + text for text in case["checks"])
    (output / "RUN-RECORD.md").write_text(
        f"# {case['title']}\n\n状态：未执行\n\n"
        "测试日期：\n执行人：\n测试环境：\n代码 commit／镜像：\n模型／提示词／规则版本：\n"
        "新建测试项目 ID／任务 ID：\n输入清单 hash：见 preparation.json\n真实模型或模拟：\n"
        "耗时／费用：\n结果文件及 hash：\n首次失败与重试记录：\n缺陷链接：\n人工验收结论：\n\n"
        + checks + "\n", encoding="utf-8")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", type=Path, default=DEFAULT_BATCH)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    sub.add_parser("verify")
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--case", required=True)
    prepare.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare_case(args.batch, args.case, args.output)
        print(f"Prepared {args.case}: {len(result['files'])} files; business tests NOT run")
    else:
        manifest, _ = verify_batch(args.batch)
        if args.command == "list":
            for case in manifest["cases"]:
                status = "READY" if case.get("preparable", True) else "INCOMPLETE"
                print(f"{case['case_id']}\t{status}\t{case['task_type']}\t{len(case['file_ids'])} files\t{case['title']}")
        else:
            ready = sum(c.get("preparable", True) for c in manifest["cases"])
            print(f"INTEGRITY PASS: {len(manifest['cases'])} cases ({ready} preparable); {manifest['file_count']} originals; {manifest['total_bytes']:,} bytes; business tests NOT run")


if __name__ == "__main__":
    main()
