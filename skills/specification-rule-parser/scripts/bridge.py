"""JSON adapter for the website; all actual PDF work stays in Python."""
import argparse
import json
from pathlib import Path
import sys

from pdf_core import augment_table_evidence, json_text, prepare_documents, set_poppler
from prepare_pdf import prepare_specification


def execute(request):
    operation, payload = request["operation"], request["payload"]
    set_poppler(payload.get("poppler"))
    if operation == "prepare":
        options = payload.get("options") or {}
        return prepare_documents(payload["files"], payload["directory"],
                                 render_images=options.get("renderImages", True),
                                 detail_mode=options.get("detailMode", False))
    if operation == "specification":
        options = payload.get("options") or {}
        return prepare_specification(payload["file"], payload["directory"],
                                     table_directory=options.get("tableDirectory"),
                                     audit_details=options.get("auditDetails", False))
    if operation == "drawing":
        prepared = prepare_documents(payload["files"], payload["directory"], detail_mode=True)
        prepared["preparation"] = {"mode": "drawing", "version": "skill-pdf-py-v1"}
        return prepared
    if operation == "augment":
        return augment_table_evidence(payload["prepared"], payload["files"], payload["directory"])
    if operation == "table":
        from table_structure import append_table_structure
        prepared = payload["prepared"]
        tables = append_table_structure(prepared, payload["file"], payload["directory"])
        return {"prepared": prepared, "payload": tables}
    raise ValueError("未知PDF操作：" + str(operation))


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        parser = argparse.ArgumentParser(allow_abbrev=False)
        parser.add_argument("--request", required=True)
        args = parser.parse_args()
        request = json.loads(Path(args.request).read_bytes().decode("utf-8"))
        print(json_text(execute(request)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
