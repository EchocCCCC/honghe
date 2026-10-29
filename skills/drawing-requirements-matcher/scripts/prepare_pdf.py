"""Drawing PDF entrypoint. Install the two complete skill folders side by side."""
from pathlib import Path
import sys


def shared_runtime():
    shared = Path(__file__).resolve().parents[2] / "specification-rule-parser" / "scripts"
    if not all((shared / name).is_file() for name in ("pdf_core.py", "cli.py", "process.py")):
        raise RuntimeError("缺少配套规范Skill的PDF脚本：请将 specification-rule-parser 与 drawing-requirements-matcher 两个完整目录并列安装。")
    shared_string = str(shared)
    if shared_string not in sys.path:
        sys.path.insert(0, shared_string)
    from cli import run_pdf_cli
    from pdf_core import prepare_documents
    return run_pdf_cli, prepare_documents


def prepare_drawing_documents(files, directory):
    _, prepare_documents = shared_runtime()
    prepared = prepare_documents(files, directory, detail_mode=True)
    prepared["preparation"] = {"mode": "drawing", "version": "skill-pdf-py-v1"}
    return prepared


def _prepare_one(file, directory, *, audit_details=False):
    return prepare_drawing_documents([file], directory)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        run_pdf_cli, _ = shared_runtime()
        run_pdf_cli("图纸PDF预处理", _prepare_one)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
