"""Shared, strict command-line contract for the paired Python PDF skills."""
from pathlib import Path
import re
import sys

from pdf_core import json_text, write_json


def run_pdf_cli(label, prepare, *, allow_audit_details=False, args=None):
    args = list(sys.argv[1:] if args is None else args)
    usage = label + "：python scripts/prepare_pdf.py --input 文件.pdf --output 新目录 [--name 原文件名.pdf]"
    if allow_audit_details:
        usage += " [--audit-details]"
    if len(args) == 1 and args[0] in ("--help", "-h"):
        print(usage)
        return
    options, index = {}, 0
    valued = {"--input", "--output", "--name"}
    while index < len(args):
        key = args[index]
        if key in options:
            raise ValueError("重复参数：" + key)
        if key == "--audit-details" and allow_audit_details:
            options[key] = True
        elif key in valued and index + 1 < len(args) and not args[index + 1].startswith("--"):
            index += 1
            options[key] = args[index]
        else:
            raise ValueError("未知参数或缺少参数值：" + key + "。" + usage)
        index += 1
    if not options.get("--input") or not options.get("--output"):
        raise ValueError(usage)
    source = Path(options["--input"]).resolve()
    directory = Path(options["--output"]).resolve()
    if not source.is_file():
        raise ValueError("输入必须是PDF文件")
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("输出目录必须是新目录或空目录，已有文件未覆盖")
    name = options.get("--name") or source.name
    if Path(name).name != name or re.search(r"[\\/\x00-\x1f]", name):
        raise ValueError("--name 只能是原文件名，不能包含目录")
    directory.mkdir(parents=True, exist_ok=True)
    prepared = prepare({"name": name, "path": str(source)}, str(directory),
                       audit_details="--audit-details" in options)
    prepared_path = str(directory / "prepared.json")
    write_json(prepared_path, prepared)
    print(json_text({"preparedPath": prepared_path, "sourcePath": prepared["sourcePath"],
                     "coverage": prepared["coverage"], "warnings": prepared["warnings"]}))
