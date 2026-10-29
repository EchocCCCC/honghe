"""Specification PDF entrypoint, usable independently of the website."""
from pathlib import Path
import sys

from cli import run_pdf_cli
from pdf_core import augment_table_evidence, prepare_documents


def prepare_specification(file, directory, *, table_directory=None, audit_details=False):
    from table_structure import append_table_structure
    prepared = prepare_documents([file], directory)
    append_table_structure(prepared, file, table_directory or directory)
    if audit_details:
        augment_table_evidence(prepared, [file], str(Path(directory) / "table-details"))
    prepared["preparation"] = {"mode": "specification", "version": "skill-pdf-py-v1"}
    return prepared


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        run_pdf_cli("规范PDF预处理", prepare_specification, allow_audit_details=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
