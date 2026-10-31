"""Read prepared drawing tiles as uncorrected, local OCR candidates.

The JSON preserves every observation. The companion text only combines identical
text at the same approximate position in the same source image. Neither output
is a PDF text layer or an interpretation of manufacturing dimensions.
Requires Python 3.11 or newer and the adjacent requirements.txt dependencies.
"""
import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time

ROTATIONS = (0, 45, 90, 135)
FIELD_LABELS = {"物资编码", "工作令号", "客户图号及版本号", "提交客户图号及版本号", "材料", "重量", "重量比例"}
NOTICE = (
    "OCR候选，不是事实或权威PDF文字层；score是引擎分数，不代表准确率。"
    "box是图像像素位置，不是工艺尺寸；approxOriginalBox仅按旋转中心逆变换近似映射到原图块，"
    "不是完整PDF或精确CAD坐标。不同识读全部保留，不按分数选答案。"
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepared_images(prepared, base):
    found = {}
    for page in prepared.get("pages", []):
        for value in page.get("imagePaths", []):
            path = Path(value)
            path = path if path.is_absolute() else base / path
            if path.suffix.lower() == ".png" and re.search(r"-(?:tile-|focus-)", path.stem):
                found[str(path.resolve())] = {
                    "image": str(path.resolve()), "file": page.get("file"),
                    "documentId": page.get("docId"), "page": page.get("page"),
                }
    if not found:
        for value in prepared.get("images", []):
            path = Path(value)
            path = path if path.is_absolute() else base / path
            if path.suffix.lower() != ".png" or not re.search(r"-(?:tile-|focus-)", path.stem):
                continue
            match = re.search(r"(?P<doc>doc-\d+)-page-(?P<page>\d+)", path.stem)
            found[str(path.resolve())] = {
                "image": str(path.resolve()), "file": None,
                "documentId": match["doc"] if match else None,
                "page": int(match["page"]) if match else None,
            }
    if not found:
        raise ValueError("prepared.json contains no tile/focus PNGs")
    for item in found.values():
        if not Path(item["image"]).is_file():
            raise FileNotFoundError(item["image"])
    return list(found.values())


def inverse_rotation(box, original_size, rotated_size, rotation):
    """Approximate image-pixel inverse of PIL's expand=True rotation."""
    width, height = original_size
    rotated_width, rotated_height = rotated_size
    angle = math.radians(rotation)
    cosine, sine = math.cos(angle), math.sin(angle)
    points = []
    for x, y in box:
        dx, dy = x - rotated_width / 2, y - rotated_height / 2
        points.append([round(cosine * dx - sine * dy + width / 2, 3),
                       round(sine * dx + cosine * dy + height / 2, 3)])
    return points


def bounds(box):
    return [min(p[0] for p in box), min(p[1] for p in box),
            max(p[0] for p in box), max(p[1] for p in box)]


def same_position(first, second):
    """Conservative overlap + center check; nearby repeated text stays separate."""
    a, b = bounds(first), bounds(second)
    aw, ah, bw, bh = a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1]
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = aw * ah + bw * bh - intersection
    center_distance = math.hypot((a[0] + a[2] - b[0] - b[2]) / 2,
                                 (a[1] + a[3] - b[1] - b[3]) / 2)
    return union > 0 and intersection / union >= 0.5 and center_distance <= 0.2 * max(1, min(aw, ah, bw, bh))


def compact_candidates(images):
    groups = []
    for image in images:
        for candidate in image["candidates"]:
            group = next((g for g in groups
                          if g["image"] == image["image"] and g["page"] == image["page"]
                          and g["imageSha256"] == image["imageSha256"] and g["text"] == candidate["text"]
                          and same_position(g["approxOriginalBox"], candidate["approxOriginalBox"])), None)
            observation = {"candidateId": candidate["id"], "rotation": image["rotation"],
                           "score": candidate["score"]}
            if group is None:
                group = {"image": image["image"], "page": image["page"],
                         "imageSha256": image["imageSha256"], "text": candidate["text"],
                         "approxOriginalBox": candidate["approxOriginalBox"], "observations": []}
                groups.append(group)
            group["observations"].append(observation)
    return groups


def label_neighbors(groups, label):
    """Return geometric neighbors, without deciding which text is a field value."""
    label_box = bounds(label["approxOriginalBox"])
    options = {"above": [], "below": []}
    for group in groups:
        if group is label or group["image"] != label["image"] or group["page"] != label["page"]:
            continue
        box = bounds(group["approxOriginalBox"])
        overlap = max(0, min(label_box[2], box[2]) - max(label_box[0], box[0]))
        minimum_width = min(label_box[2] - label_box[0], box[2] - box[0])
        if minimum_width <= 0 or overlap / minimum_width < 0.5:
            continue
        if box[3] <= label_box[1]:
            options["above"].append((label_box[1] - box[3], group))
        elif box[1] >= label_box[3]:
            options["below"].append((box[1] - label_box[3], group))
    result = {}
    for direction, values in options.items():
        nearest = min((gap for gap, _ in values), default=None)
        result[direction] = [{"text": group["text"], "approxOriginalBBox": bounds(group["approxOriginalBox"]),
                              "observations": group["observations"]}
                             for gap, group in values if nearest is not None and gap <= nearest + 2.0]
    return result


def format_compact(groups):
    lines = [NOTICE]
    for group in groups:
        observations = group["observations"]
        rotations = ",".join(str(x["rotation"]) for x in observations)
        scores = ",".join(f'{x["rotation"]}:{x["score"]:.5f}' for x in observations)
        lines.append(f'{Path(group["image"]).name} | page={group["page"]} | rotation={rotations} | '
                     f'approxOriginalBBox={json.dumps(bounds(group["approxOriginalBox"]), separators=(",", ":"))} | '
                     f'text={json.dumps(group["text"], ensure_ascii=False)} | score={scores}')
        if "".join(group["text"].split()).rstrip(":：") in FIELD_LABELS:
            neighbors = label_neighbors(groups, group)
            lines.append('  空间提示（同图块，非字段值断言）：上方候选='
                         + json.dumps(neighbors["above"], ensure_ascii=False, separators=(",", ":"))
                         + '；下方候选='
                         + json.dumps(neighbors["below"], ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines) + "\n"


def create_engine():
    if sys.version_info < (3, 11):
        raise RuntimeError("图纸 OCR 需要 Python 3.11 或更高版本（ONNX Runtime 的版本要求）。")
    # Set thread limits before importing numerical runtimes.
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[name] = "2"
    from rapidocr import EngineType, RapidOCR
    import cv2
    from omegaconf import OmegaConf
    cv2.setNumThreads(2)
    params = {
        "Global.text_score": 0.0, "Global.max_side_len": 2000, "Global.log_level": "warning",
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Cls.engine_type": EngineType.ONNXRUNTIME,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Det.limit_type": "max", "Det.limit_side_len": 2000,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": False,
        "EngineConfig.onnxruntime.use_dml": False,
    }
    engine = RapidOCR(params=params)
    config = json.loads(json.dumps(OmegaConf.to_container(engine.cfg, resolve=True, enum_to_str=True), default=os.fspath))
    if config["Det"]["limit_side_len"] != 2000 or config["Det"]["limit_type"] != "max" or config["Global"]["max_side_len"] != 2000:
        raise RuntimeError("Installed OCR version did not apply the requested detection limits")
    return engine, {
        "rapidocr": importlib.metadata.version("rapidocr"),
        "onnxruntime": importlib.metadata.version("onnxruntime"),
        "configuration": {"Global": config["Global"], "Det": config["Det"],
                          "Rec": config["Rec"], "onnxruntime": config["EngineConfig"]["onnxruntime"]},
    }


def generate(prepared_path, output_path, engine_factory=None):
    from PIL import Image
    started = time.perf_counter()
    prepared_path, output_path = Path(prepared_path).resolve(), Path(output_path).resolve()
    if output_path.suffix.lower() != ".json" or output_path == prepared_path:
        raise ValueError("--output must be a separate .json file")
    prepared_hash = digest(prepared_path)
    prepared = json.loads(prepared_path.read_text(encoding="utf-8-sig"))
    inputs = prepared_images(prepared, prepared_path.parent)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({"complete": False, "notice": NOTICE}, ensure_ascii=False), encoding="utf-8")
    engine, engine_info = (engine_factory or create_engine)()
    records = []
    for image_index, item in enumerate(inputs, 1):
        path = Path(item["image"])
        source_hash = digest(path)
        with Image.open(path) as original:
            original_size = original.size
            for rotation in ROTATIONS:
                pass_started = time.perf_counter()
                with tempfile.TemporaryDirectory(prefix="ocr-rotation-", dir=output_path.parent) as temporary:
                    rotated = original.convert("RGB")
                    if rotation:
                        rotated = rotated.rotate(rotation, expand=True, fillcolor="white", resample=Image.Resampling.BICUBIC)
                    rotated_path = Path(temporary) / "input.png"
                    rotated.save(rotated_path)
                    inference_started = time.perf_counter()
                    result = engine(str(rotated_path))
                    inference_seconds = time.perf_counter() - inference_started
                    boxes = result.boxes if result.boxes is not None else []
                    texts = result.txts if result.txts is not None else []
                    scores = result.scores if result.scores is not None else []
                    if not len(boxes) == len(texts) == len(scores):
                        raise ValueError("Mismatched OCR output lengths: " + path.name)
                    candidates = []
                    for index, (text, score, box) in enumerate(zip(texts, scores, boxes), 1):
                        box = [[float(x), float(y)] for x, y in box]
                        if len(box) != 4 or not math.isfinite(float(score)) or not all(math.isfinite(v) for p in box for v in p):
                            raise ValueError("Invalid OCR score or four-point box: " + path.name)
                        candidates.append({
                            "id": f"image-{image_index}-rotation-{rotation}-{index}",
                            "text": str(text), "score": float(score), "rotation": rotation,
                            "rotatedBox": box,
                            "approxOriginalBox": inverse_rotation(box, original_size, rotated.size, rotation),
                            "evidenceStatus": "ocr_candidate",
                        })
                    records.append({
                        **item, "imageSha256": source_hash, "rotation": rotation,
                        "originalSize": list(original_size), "rotatedSize": list(rotated.size),
                        "boxCoordinateFrame": "rotatedBox=rotated image pixels; approxOriginalBox=approximate source tile pixels",
                        "elapsedSeconds": round(time.perf_counter() - pass_started, 3),
                        "inferenceElapsedSeconds": round(inference_seconds, 3),
                        "candidates": candidates,
                    })
                print(json.dumps({"image": path.name, "rotation": rotation, "candidates": len(candidates),
                                  "elapsedSeconds": records[-1]["elapsedSeconds"]}, ensure_ascii=False), file=sys.stderr, flush=True)
        if source_hash != digest(path):
            raise RuntimeError("Original image changed during OCR: " + str(path))
    if prepared_hash != digest(prepared_path):
        raise RuntimeError("prepared.json changed during OCR")
    groups = compact_candidates(records)
    candidate_count = sum(len(x["candidates"]) for x in records)
    report = {
        "complete": True, "kind": "ocr_candidates", "authority": "candidate_only_not_pdf_text_layer",
        "createdAt": datetime.now(timezone.utc).isoformat(), "notice": NOTICE,
        "prepared": str(prepared_path), "preparedSha256": prepared_hash,
        "engine": engine_info, "rotationDirection": "counterclockwise", "rotations": list(ROTATIONS),
        "imageCount": len(inputs), "candidateCount": candidate_count,
        "elapsedSeconds": round(time.perf_counter() - started, 3), "images": records,
        "compactCandidates": groups,
    }
    text_path = output_path.with_name("ocr-candidates.txt")
    text_path.write_text(format_compact(groups), encoding="utf-8")
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"outputPath": str(output_path), "textPath": str(text_path), "complete": True,
            "imageCount": len(inputs), "candidateCount": candidate_count,
            "engine": {"rapidocr": engine_info["rapidocr"], "onnxruntime": engine_info["onnxruntime"]},
            "passCount": len(records), "compactCandidateCount": len(groups), "elapsedSeconds": report["elapsedSeconds"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        with redirect_stdout(sys.stderr):
            summary = generate(args.prepared, args.output)
    except Exception as error:
        message = str(error)
        if isinstance(error, ImportError):
            message = (f"OCR 依赖缺失或无法加载：{error}。请使用 Python 3.11 或更高版本，"
                       f"在同一运行环境安装 {Path(__file__).with_name('requirements.txt')} 中的依赖；"
                       "使用独立依赖目录时，请由调用方配置 PYTHONPATH。")
        print(f"OCR candidate generation failed: {type(error).__name__}: {message}", file=sys.stderr)
        print(json.dumps({"complete": False, "error": message}, ensure_ascii=False))
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
