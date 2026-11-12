"""Record saved-error placement without recalculation or changing the source."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

from rq_q3_baseline import NS, R, authorized_files, output_directory, spreadsheet_inventory


def column_number(address: str) -> int:
    result = 0
    for char in re.match(r"[A-Z]+", address).group():
        result = result * 26 + ord(char) - ord("A") + 1
    return result


def error_placement() -> dict:
    source, path, data = next(item for item in authorized_files() if item[0]["file_id"] == "rq-202509-02")
    inventory = spreadsheet_inventory(data)
    contexts = []
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        workbook = ET.fromstring(package.read("xl/workbook.xml"))
        rels = {item.attrib["Id"]: item.attrib["Target"] for item in ET.fromstring(package.read("xl/_rels/workbook.xml.rels"))}
        definitions = [{"name": item.attrib.get("name"), "local_sheet_id": item.attrib.get("localSheetId"), "text": item.text}
                       for item in workbook.findall("s:definedNames/s:definedName", NS)]
        for index, item in enumerate(workbook.findall("s:sheets/s:sheet", NS)):
            saved = next(sheet for sheet in inventory["sheets"] if sheet["name"] == item.attrib["name"])
            if not saved["saved_errors"]:
                continue
            target = rels[item.attrib[f"{{{R}}}id"]]
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            xml = ET.fromstring(package.read(part))
            rows = {int(row.attrib["r"]): row for row in xml.findall("s:sheetData/s:row", NS)}
            cols = [col.attrib for col in xml.findall("s:cols/s:col", NS)]
            text_labels = [cell for cell in saved["cells"] if cell["type"] in {"s", "inlineStr"} and cell["value"]]
            for error in saved["saved_errors"]:
                row_number = int(re.search(r"\d+$", error["cell"]).group())
                col_number = column_number(error["cell"])
                row = rows[row_number]
                matching_columns = [col for col in cols if int(col["min"]) <= col_number <= int(col["max"])]
                nearby = [cell for cell in text_labels if abs(int(re.search(r"\d+$", cell["cell"]).group()) - row_number) <= 5]
                above = [cell for cell in text_labels if int(re.search(r"\d+$", cell["cell"]).group()) < row_number]
                contexts.append({"sheet": saved["name"], "sheet_state": saved["state"], "error": error,
                                 "sheet_dimension": xml.find("s:dimension", NS).attrib,
                                 "row_attributes": row.attrib, "column_attributes": matching_columns,
                                 "row_hidden": row.attrib.get("hidden", "0") == "1",
                                 "column_hidden": any(col.get("hidden", "0") == "1" for col in matching_columns),
                                 "row_cells": [cell.attrib["r"] for cell in row.findall("s:c", NS)],
                                 "nearby_text_labels": nearby, "last_text_labels_above": above[-10:],
                                 "period_and_column_headers": saved["headers"],
                                 "sheet_defined_names": [entry for entry in definitions if entry["local_sheet_id"] == str(index)]})
    if path.read_bytes() != data:
        raise ValueError("Original changed during saved-error placement check")
    return {"schema": "rq-q3-saved-error-placement-v1", "file_id": source["file_id"], "source_sha256": source["sha256"],
            "original_unchanged": True, "external_links_evaluated": False, "recalculated": False, "contexts": contexts}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    directory = output_directory(args.output_dir)
    report = error_placement()
    (directory / "rq-q3-saved-error-placement.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"errors": [{"sheet": item["sheet"], "cell": item["error"]["cell"],
                                 "row_hidden": item["row_hidden"], "column_hidden": item["column_hidden"],
                                 "nearby_text_label_count": len(item["nearby_text_labels"]), "row_cells": item["row_cells"]}
                                for item in report["contexts"]], "original_unchanged": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
