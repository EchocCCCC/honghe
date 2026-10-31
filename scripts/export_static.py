"""Export existing API results as one offline HTML file. No model calls."""
import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen
from zoneinfo import ZoneInfo

ROW_KEYS = ("id", "informationType", "processCategory", "usage", "conflict", "category", "requirement", "scope", "parameters", "sources", "review_required", "review_note", "conditions", "exceptions", "origin", "ruleIds", "strength", "overridePolicy", "externalReferences")
PROFILE_KEYS = ("partNumber", "name", "revision", "material", "materialForm", "process", "castingClass", "airtightness", "dimensionState", "references", "facts", "uncertainties")
UUID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z")


def get_json(base, path):
    with urlopen(base.rstrip("/") + path, timeout=30) as response:
        return json.load(response)


def pick(value, keys):
    return {key: value[key] for key in keys if key in value}


def public_error(value):
    """Keep the failure reason, without local diagnostic paths or credentials."""
    text = str(value or "")[:3000]
    text = re.sub(r"(?i)\bsk-[a-z0-9_-]{12,}", "[密钥已隐藏]", text)
    text = re.sub(r"(?i)(?:[a-z]:[\\/]|file:///)[^\r\n\"'<>，；。]*", "[本地路径已隐藏]", text)
    return text


def snapshot(base, state, allow_incomplete=False):
    if not isinstance(state.get("specifications"), dict) or not state["specifications"]:
        raise ValueError("State must identify at least one specification")
    if not isinstance(state.get("batches"), list):
        raise ValueError("State must contain an explicit batch list")
    if any(not isinstance(entry, dict) or entry.get("series") not in state["specifications"] for entry in state["batches"]):
        raise ValueError("Every selected batch must belong to a selected series")
    specifications = []
    for series, spec_id in state["specifications"].items():
        if not isinstance(spec_id, str) or not UUID.fullmatch(spec_id):
            raise ValueError("Invalid specification ID")
        spec = get_json(base, "/api/specifications/" + spec_id)
        if spec["status"] != "completed":
            raise ValueError("Only completed specifications may be exported")
        result = spec["result"]
        drawings_by_source = {}
        batches = [entry for entry in state["batches"] if entry.get("series") == series]
        if not batches:
            raise ValueError("No batches selected for " + series)
        for entry in batches:
            batch_id = entry.get("id")
            if not isinstance(batch_id, str) or not UUID.fullmatch(batch_id):
                raise ValueError("Invalid batch ID")
            batch = get_json(base, "/api/drawing-batches/" + batch_id)
            if batch["specificationId"] != spec_id:
                raise ValueError("Only exactly linked batches may be exported")
            for drawing in batch["drawings"]:
                source_key = (drawing.get("sourceSha256") or batch_id + "/" + drawing["id"], batch.get("stage", "all"))
                # Explicit state order chooses the latest attempt, including failed attempts.
                drawings_by_source[source_key] = (batch, drawing)
        drawings = []
        for batch, drawing in drawings_by_source.values():
            batch_id, stage = batch["id"], batch.get("stage", "all")
            output = drawing.get("result") or {}
            current_attempt = drawing.get("attemptId", "")
            attempt_matches = not current_attempt or output.get("run", {}).get("attemptId") == current_attempt
            published = drawing["status"] in ("completed", "partial") and bool(output.get("requirements")) and attempt_matches
            if not published and not allow_incomplete:
                raise ValueError("Latest selected drawing result is incomplete: " + batch_id + "/" + drawing["id"] + " (" + drawing["status"] + ")")
            item = {
                    "id": drawing["id"], "batchId": batch_id, "stage": stage, "filename": drawing["name"],
                    "sourceSha256": drawing.get("sourceSha256", ""), "status": drawing["status"], "published": published,
                    "attemptId": current_attempt, "batchCreatedAt": batch.get("createdAt", ""),
                    "batchUpdatedAt": batch.get("updatedAt", ""),
                }
            if not published:
                # Ignore any retained result on failed/pending jobs, and never read audited candidates.
                reason = drawing.get("error") or ("当前结果与本轮尝试不一致，未展示旧清单。" if not attempt_matches else drawing.get("message"))
                item.update({"error": public_error(reason), "scopePolicy": result.get("scopePolicy", ""),
                             "drawing": {}, "summary": "", "requirements": [], "warnings": [], "dispositions": [],
                             "model": "", "pipelineVersion": ""})
                drawings.append(item)
                continue
            item.update({"scopePolicy": output.get("scopePolicy", ""),
                    "drawing": pick(output["drawing"], PROFILE_KEYS), "summary": output.get("summary", ""),
                    "requirements": [pick(row, ROW_KEYS) for row in output["requirements"]],
                    "warnings": output.get("warnings", []),
                    "review": {**pick(output.get("review", {}), ("status", "pendingRuleIds", "affectedRequirementIds")), "note": public_error(output.get("review", {}).get("note", ""))},
                    "dispositions": [pick(row, ("ruleId", "status", "reason", "evidence", "usage")) for row in output.get("dispositions", [])],
                    "model": output.get("run", {}).get("model", "deepseek-flash"),
                    "pipelineVersion": output.get("run", {}).get("pipelineVersion", ""),
                    "processingMode": output.get("run", {}).get("processingMode", ""),
                })
            drawings.append(item)
        if not drawings:
            raise ValueError("No drawings selected for " + series)
        specifications.append({
            "id": spec_id, "series": series, "metadata": result["metadata"],
            "sourceSha256": spec.get("sourceSha256", ""), "scopePolicy": result.get("scopePolicy", ""),
            "rules": [pick(row, ROW_KEYS) for row in result["rules"]],
            "warnings": result.get("warnings", []), "drawings": drawings,
        })
    totals = {"specifications": len(specifications),
              "drawings": sum(len(spec["drawings"]) for spec in specifications),
              "requirements": sum(len(d["requirements"]) for s in specifications for d in s["drawings"])}
    return {"title": "轨道交通零件工艺要求", "formatVersion": 2,
            "exportedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
            "note": "现有机器结果的静态快照。保留待确认项和独立原图复核提示，未经全部人工确认。原 PDF 未内嵌；来源可查看文件名、物理页码和引文。",
            "totals": totals, "specifications": specifications}


HTML = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light">
<title>工艺要求 · 静态报告</title>
<style>
:root{--bg:#f4f6f3;--paper:#fff;--ink:#253d39;--muted:#687d76;--line:#dce5dd;--green:#28766b;--pale:#edf5ef;--amber:#825b28;--amber-bg:#fff8e9;--radius:15px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;font-size:14px;line-height:1.7}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button,input,select,a{outline-offset:4px}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #62bbaa}button{border:1px solid var(--line);background:white;border-radius:8px;padding:9px 14px;color:var(--ink)}button:hover{border-color:#70a393;background:#f5faf6}button.primary{background:var(--green);color:#fff;border-color:var(--green)}.wrap{max-width:1510px;margin:auto;padding:30px 34px 48px}.top{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:24px}.brand{font-size:12px;letter-spacing:.16em;color:var(--green);font-weight:700}.top h1{font-size:29px;letter-spacing:.03em;line-height:1.4;margin:8px 0}.sub{color:var(--muted);margin:3px 0;font-size:13px}.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.badge{border:1px solid #c8ddd0;color:var(--green);padding:3px 9px;border-radius:5px;font-size:12px;white-space:nowrap;background:var(--pale)}.stats{display:grid;grid-template-columns:repeat(3,1fr);background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:24px}.stat{padding:18px 25px;display:flex;gap:16px;align-items:center}.stat+.stat{border-left:1px solid var(--line)}.stat b{font-size:30px;line-height:1.3;font-weight:500;color:var(--green);font-variant-numeric:tabular-nums}.stat span{font-size:13px;color:var(--muted)}.layout{display:grid;grid-template-columns:310px minmax(0,1fr);gap:22px;align-items:start}.side{position:sticky;top:18px;max-height:calc(100vh - 36px);overflow:auto;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:20px}.label{font-size:12px;color:var(--muted);letter-spacing:.04em;margin:0 0 12px}.spec-button{display:block;text-align:left;width:100%;padding:14px;margin:9px 0 0;border-radius:10px}.spec-button[aria-pressed=true]{border-color:var(--green);background:var(--pale);box-shadow:inset 3px 0 var(--green)}.spec-button strong{display:block;font-size:15px;margin-bottom:5px}.spec-button span{display:block;color:var(--muted);font-size:12px}.side hr{border:0;border-top:1px solid var(--line);margin:23px 0 18px}.draw-list{display:flex;flex-direction:column;gap:8px}.drawing-button{display:block;text-align:left;width:100%;padding:11px 12px;border-color:transparent;background:#f7f9f6}.drawing-button[aria-current=true]{border-color:#78aa91;background:#edf5ef}.drawing-button strong{display:block;font-size:13px;overflow-wrap:anywhere;font-weight:500;line-height:1.6}.drawing-button small{display:block;color:var(--muted);margin-top:4px;font-size:12px}.main{min-width:0}.section-head{border:1px solid var(--line);background:white;border-radius:var(--radius);padding:23px 26px 0}.section-head h2{font-size:20px;margin:0 0 4px;line-height:1.6}.scope{font-size:13px;color:var(--muted);margin:10px 0 17px}.tabs{display:flex;gap:24px}.tab{background:none;border:0;border-bottom:3px solid transparent;border-radius:0;padding:12px 0 13px;font-size:14px}.tab[aria-selected=true]{border-bottom-color:var(--green);color:var(--green);font-weight:700}.tab:hover{background:none;border-color:#a6c7b2}.tab[aria-selected=true]:hover{border-color:var(--green)}.content{margin-top:20px;background:white;border:1px solid var(--line);border-radius:var(--radius);padding:24px 26px}.result-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.result-head h3{font-size:23px;line-height:1.5;margin:0 0 7px;overflow-wrap:anywhere}.file-name{overflow-wrap:anywhere;font-size:12px;color:var(--muted);margin:0}.profile{display:flex;gap:9px;flex-wrap:wrap;margin-top:13px}.profile span{font-size:12px;padding:3px 8px;background:#f3f6f1;border:1px solid #e4ebe0;border-radius:5px}.note{color:var(--muted);font-size:12px;margin:16px 0}.notice{margin:18px 0;padding:13px 15px;border:1px solid #e7d4a9;background:var(--amber-bg);border-radius:9px;color:var(--amber);font-size:13px}.notice strong{display:block;margin-bottom:4px}.notice p{margin:5px 0;white-space:pre-wrap}.aux{border:1px solid var(--line);background:#fafbf8;border-radius:8px;margin:12px 0;padding:10px 13px;font-size:13px}.aux summary{cursor:pointer;color:var(--muted)}.aux li{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.aux ul{padding-left:20px}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:23px 0 12px}.search{flex:1;min-width:190px;position:relative}.search input{border:1px solid var(--line);border-radius:8px;padding:10px 13px;width:100%;background:#fafbf8;color:var(--ink)}.check{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;white-space:nowrap}.check input{accent-color:var(--green);width:16px;height:16px}.export-group{display:flex;gap:7px}.export-group button{font-size:12px;padding:9px 10px}.table-caption{font-size:12px;display:flex;justify-content:space-between;align-items:center;color:var(--muted);margin-bottom:10px;gap:15px}.table-wrap{border:1px solid var(--line);border-radius:9px;overflow:hidden}table{width:100%;border-collapse:collapse;table-layout:fixed}th{font-size:12px;color:var(--muted);font-weight:500;background:#eff4ed;text-align:left;padding:13px 16px;border-bottom:1px solid var(--line)}th:first-child{width:29%}td{vertical-align:top;padding:17px 16px;border-bottom:1px solid #e4ebe2;font-size:13px;overflow-wrap:anywhere}tr:last-child td{border-bottom:0}td:first-child{font-weight:500;background:#fcfdfb;border-right:1px solid #e7eee4}.req-text{white-space:pre-wrap;line-height:1.9}.row-id{display:block;color:#839387;font-size:11px;font-weight:400;margin-bottom:5px;letter-spacing:.04em}.pending{display:inline-block;margin-top:7px;border:1px solid #e5d4af;background:var(--amber-bg);color:var(--amber);border-radius:4px;font-size:11px;padding:1px 6px;font-weight:400}.evidence{margin-top:11px;font-size:12px}.evidence summary{cursor:pointer;color:var(--green);width:fit-content}.evidence-content{border-left:2px solid #d8e4d8;padding:4px 0 0 12px;color:var(--muted);font-size:12px}.evidence-content p{white-space:pre-wrap;margin:9px 0}.evidence-content blockquote{margin:8px 0 13px;padding:9px 11px;background:#f6f8f3;white-space:pre-wrap;font-size:12px;color:#4f6257}.source-label{font-size:11px;overflow-wrap:anywhere}.empty{text-align:center;padding:35px;color:var(--muted)}footer{text-align:center;color:#849386;font-size:12px;margin-top:26px}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#254f43;color:white;padding:10px 20px;border-radius:8px;box-shadow:0 5px 25px #233e3320;z-index:5}.mobile-label{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}
@media(min-width:1600px){.wrap{padding-top:40px}}@media(max-width:1050px){.wrap{padding:22px}.layout{grid-template-columns:260px minmax(0,1fr);gap:16px}.side{padding:16px}.content{padding:19px}.section-head{padding:19px 19px 0}.export-group{width:100%}.result-head h3{font-size:20px}.top h1{font-size:25px}}
@media(max-width:760px){.wrap{padding:18px 13px}.top{align-items:flex-start;margin-bottom:18px}.top h1{font-size:23px}.top-actions button{font-size:12px;padding:8px 10px}.top-actions{max-width:130px}.brand{font-size:10px}.stats{margin-bottom:16px}.stat{display:block;padding:13px 16px}.stat b{font-size:26px;display:block}.stat span{font-size:11px}.layout{grid-template-columns:1fr}.side{position:static;max-height:none}.specs{display:grid;grid-template-columns:1fr 1fr;gap:9px}.spec-button{margin:0;padding:11px}.spec-button strong{font-size:13px}.spec-button span{font-size:11px}.draw-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.side hr{margin:15px 0}.section-head h2{font-size:18px}.content{padding:17px 13px}.section-head{padding:17px 15px 0}.scope{margin-bottom:10px}.result-head h3{font-size:19px}.result-head{display:block}.result-head>.badge{display:inline-block;margin-top:10px}th,td{padding:12px 10px}th:first-child{width:32%}td{font-size:12px}.notice{font-size:12px}.toolbar{margin-top:18px}.search{min-width:100%;width:100%}.table-caption{align-items:flex-start}.check{font-size:12px}}
@media print{@page{size:A4;margin:13mm}body{background:white;color:#152e25;font-size:10pt}.wrap{padding:0;max-width:none}.top-actions,.stats,.side,.tabs,.toolbar,.note,.aux,footer,.toast,.evidence{display:none!important}.layout{display:block}.section-head,.content{border:0;padding:0;margin:14px 0}.top{margin-bottom:14px}.top h1{font-size:20pt}.section-head h2{font-size:14pt}.result-head h3{font-size:16pt}.notice{break-inside:avoid;background:white;font-size:9pt}.table-wrap{overflow:visible}thead{display:table-header-group}tr{break-inside:auto}th,td{padding:9px;font-size:9pt}th{background:#eee}.table-caption{font-size:9pt}.profile span{background:white}.sub,.scope{font-size:9pt}}
.category-select{padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:white;color:var(--ink);max-width:100%}.process-chip{display:inline-block;margin-top:7px;padding:1px 7px;border-radius:4px;border:1px solid #cbddd1;background:var(--pale);font-size:11px;color:var(--green);font-weight:400}.conflict-chip{display:inline-block;margin-top:7px;font-size:11px;font-weight:500;color:#a33029}.conflict-chip.drawing_override{color:var(--amber)}.conflict-box{border-left:3px solid #c24c42;padding:10px 12px;background:#fff3ef;margin-top:10px;font-size:12px;color:#7f332b}.conflict-box.drawing_override{border-left-color:#b89a55;background:var(--amber-bg);color:var(--amber)}.conflict-box p{margin:5px 0;white-space:pre-wrap}.conflict-box strong{display:block}.source-kind{font-size:11px;color:var(--muted)}tr.has-conflict>td:first-child{box-shadow:inset 3px 0 #c24c42}tr.has-override>td:first-child{box-shadow:inset 3px 0 #b89a55}
th:first-child{width:26%}th:last-child{width:14%}.stage-cell{font-weight:500;color:var(--green);border-left:1px solid var(--line);white-space:normal}@media(max-width:760px){th:first-child{width:29%}th:last-child{width:20%}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><div class="brand">TONGHE / ENGINEERING REQUIREMENTS</div><h1>零件工艺要求</h1><p class="sub">两份技术规范与对应图纸的提取结果</p></div>
    <div class="top-actions"><span class="badge">离线静态报告</span><button id="export-all" type="button">导出全部 JSON</button></div>
  </header>
  <section class="stats" aria-label="结果总览"><div class="stat"><b id="total-specs">—</b><span>技术规范</span></div><div class="stat"><b id="total-drawings">—</b><span>本轮图纸</span></div><div class="stat"><b id="total-rows">—</b><span>已发布工艺要求</span></div></section>
  <p class="note" id="snapshot-status"></p>
  <div class="layout">
    <aside class="side" aria-label="选择技术规范和图纸"><p class="label">01 / 技术规范</p><div id="spec-list" class="specs"></div><hr><p class="label" id="drawing-label">02 / 对应图纸</p><nav id="drawing-list" class="draw-list" aria-labelledby="drawing-label"></nav></aside>
    <main class="main">
      <section class="section-head"><h2 id="spec-title"></h2><p class="sub" id="spec-version"></p><p class="scope" id="spec-scope"></p><div class="tabs" role="tablist" aria-label="查看内容"><button type="button" class="tab" id="tab-drawing" role="tab" aria-selected="true" aria-controls="result-panel">零件工艺要求</button><button type="button" class="tab" id="tab-spec" role="tab" aria-selected="false" aria-controls="result-panel">规范提取结果</button></div></section>
      <section class="content" id="result-panel" role="tabpanel" aria-labelledby="tab-drawing">
        <div class="result-head"><div><h3 id="result-title"></h3><p class="file-name" id="result-file"></p></div><span class="badge" id="result-count"></span></div>
        <div id="result-status" role="status"></div>
        <div id="profile" class="profile"></div>
        <p class="note">现有机器提取结果；请结合待确认条件与原图复核提示使用。此文件可离线查看，不执行新的文件解析。</p>
        <div id="review-notices"></div>
        <details class="aux" id="uncertainties" hidden><summary id="uncertainty-title"></summary><ul id="uncertainty-list"></ul></details>
        <details class="aux" id="applicability" hidden><summary id="applicability-title"></summary><ul id="applicability-list"></ul></details>
        <details class="aux" id="warnings" hidden><summary id="warning-title"></summary><p class="note"><strong>原始提取记录（未经确认）</strong></p><p class="note">以下为模型提取说明和程序提示，不代表已经确认正确；原图核对结论见单独提示，具体问题以要求行标注为准。R 编号仅用于本次关联规范的内部定位，跨版本含义可能变化，请以原文条款为准。</p><ul id="warning-list"></ul></details>
        <div class="toolbar"><label class="search"><span class="sr-only">搜索要求名称、指标或来源</span><input type="search" id="search" placeholder="搜索要求名称、指标或来源…" autocomplete="off"></label><select class="category-select" id="category-filter" aria-label="按工艺类别筛选"></select><select class="category-select" id="conflict-filter" aria-label="按冲突或覆盖筛选"><option value="">全部状态</option><option value="conflict">要求冲突</option><option value="drawing_override">图纸覆盖</option></select><select class="category-select" id="usage-filter" aria-label="按规范用途筛选" hidden><option value="inspection">用于补充的检验要求</option><option value="comparison">仅用于冲突对照</option><option value="all">全部规范依据</option></select><label class="check"><input type="checkbox" id="pending-only">仅看待复核项</label><label class="check" id="context-control" hidden><input type="checkbox" id="include-context">包含背景说明</label><div class="export-group"><button type="button" id="export-csv">导出当前三列 CSV</button><button type="button" id="export-json">导出当前 JSON</button><button type="button" id="print">打印当前结果</button></div></div>
        <div class="table-caption"><span id="table-count" aria-live="polite"></span><span>展开指标下方可查看来源和适用条件</span></div>
        <div class="table-wrap"><table aria-label="工艺要求"><thead><tr><th scope="col">工艺要求的名称</th><th scope="col">量化指标</th><th scope="col">阶段</th></tr></thead><tbody id="requirements"></tbody></table><div class="empty" id="empty" hidden>没有符合当前筛选条件的要求。</div></div>
      </section>
    </main>
  </div>
  <footer id="footer"></footer><noscript><p>请启用 JavaScript 后查看嵌入此文件的离线结果。</p></noscript>
</div>
<div class="toast" id="toast" role="status" hidden></div>
<script id="report-data" type="application/json">__REPORT_DATA__</script>
<script>
'use strict';
const report=JSON.parse(document.getElementById('report-data').textContent);
const $=id=>document.getElementById(id);
const specs=report.specifications;
let spec=specs[0],drawing=spec.drawings[0],mode='drawing',visibleRows=[],toastTimer;
const simple=v=>Array.isArray(v)?v.map(simple).filter(Boolean).join('；'):v&&typeof v==='object'?Object.entries(v).map(([k,x])=>k+'：'+simple(x)).join('；'):v==null?'':String(v);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
const isPending=row=>row.review_required===true;
const background=row=>row.informationType==='context';
const processNames=['铸造','机加','热处理','表面处理','刻字','检验','焊接','其他'];
const scoped=value=>value.scopePolicy==='drawing-plus-inspection-v1'||(value.requirements||value.rules||[]).some(r=>processNames.includes(r.processCategory));
const processStage=row=>processNames.includes(row.processCategory)?row.processCategory:'待分类';
const conflictKind=row=>['conflict','drawing_override'].includes(row.conflict?.kind)?row.conflict.kind:'';
const published=d=>d.published!==false&&(!d.status||['completed','partial'].includes(d.status))&&d.requirements.length>0;
const resultNeedsReview=d=>published(d)&&(['needs_review','partial'].includes(d.review?.status)||d.requirements.some(r=>r.review_required===true));
const statusLabel=d=>published(d)?(d.review?.status==='partial'?'部分提取 · 待复核':resultNeedsReview(d)?'已提取 · 待复核':'已提取清单'):({failed:'处理失败',queued:'等待处理',preparing:'准备图纸',reading:'识读图纸',matching:'匹配检验要求',auditing:'原图复核',completed:'结果不完整'}[d.status]||'尚未完成');
function pendingApplicability(specification,drawing){const decisions=drawing.dispositions||[];const pendingIds=new Set(drawing.review?.pendingRuleIds||[]);const ids=new Set([...decisions.filter(d=>d.status==='needs_confirmation').map(d=>d.ruleId),...pendingIds]);const names={applicable:'适用',not_applicable:'不适用',overridden:'图纸覆盖',needs_confirmation:'待确认'};return [...ids].map(id=>{const decision=decisions.find(d=>d.ruleId===id);const rule=specification.rules.find(r=>r.id===id);const label=pendingIds.has(id)?decision?'待复核（原模型：'+(names[decision.status]||decision.status)+'）':'待复核（尚未匹配）':'待确认';return id+(rule?' '+rule.category:'')+'：'+label+'；'+(decision?.reason||'尚未得到可核对的规范匹配处置。');});}
function snapshotStatusText(drawings){const complete=drawings.filter(published).length;const review=drawings.filter(resultNeedsReview).length;const failed=drawings.filter(d=>d.status==='failed'&&!published(d)).length;return '本轮 '+drawings.length+' 张图纸 · '+complete+' 张已有清单（'+review+' 张待复核） · '+failed+' 张失败 · '+(drawings.length-complete-failed)+' 张待完成';}
function statusCard(d){const box=node('div',null,published(d)&&!resultNeedsReview(d)?'note':'notice');if(!published(d))box.style.cssText=d.status==='failed'?'border-color:#d59b94;background:#fff3ef;color:#8b3028':'';box.append(node('strong',statusLabel(d)+(published(d)?'':' · 本次无有效清单')));if(!published(d))box.append(node('p',d.error||'本轮处理尚未完成，尚无可展示的工艺要求。'));else if(resultNeedsReview(d))box.append(node('p',d.review?.note||'已保留本轮可提取的清单；待复核条目及关联规范需逐项核对，提取完成不表示验收通过。'));if(published(d)&&d.processingMode==='reprocess_existing')box.append(node('p','已重新整理上轮提取结果，保留原始模型输出及本轮复核标记。'));const times=[];if(d.batchCreatedAt)times.push('批次建立 '+d.batchCreatedAt);if(d.batchUpdatedAt)times.push('本轮更新 '+d.batchUpdatedAt);if(d.attemptId)times.push('尝试 '+d.attemptId.slice(0,8));if(times.length)box.append(node('p',times.join(' · ')));return box;}
function categoryOptions(rows){$('category-filter').replaceChildren(...['',...processNames].map(value=>{const option=node('option',value?value+' · '+rows.filter(r=>r.processCategory===value).length:'全部工艺 · '+rows.length);option.value=value;return option;}));}
function flash(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,2800);}
function download(name,text,type){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);flash('已生成下载文件');}
function safeName(value){return value.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,100);}
function currentName(){return safeName(mode==='spec'?spec.metadata.number:(drawing.drawing.name||drawing.filename.replace(/\.pdf$/i,'')));}
function listDetails(id,titleId,listId,values,title){$(id).hidden=!values.length;$(id).open=false;$(titleId).textContent=title+' · '+values.length+' 项';$(listId).replaceChildren(...values.map(v=>node('li',simple(v))));}
function clearFilters(){$('search').value='';$('pending-only').checked=false;$('include-context').checked=false;$('category-filter').value='';$('conflict-filter').value='';$('usage-filter').value='inspection';}
function selectSpec(next){spec=next;drawing=next.drawings[0];clearFilters();render();}
function selectDrawing(next){drawing=next;mode='drawing';clearFilters();render();}
function renderNavigation(){
  $('spec-list').replaceChildren(...specs.map(s=>{const b=node('button',null,'spec-button');b.type='button';b.setAttribute('aria-pressed',String(s===spec));b.append(node('strong',s.metadata.number),node('span',s.metadata.title),node('span',s.drawings.length+' 张图纸 · '+(scoped(s)?s.rules.filter(r=>r.usage==='inspection').length+' 条检验候选':s.rules.length+' 条历史规范记录')));b.addEventListener('click',()=>selectSpec(s));return b;}));
  $('drawing-list').replaceChildren(...spec.drawings.map(d=>{const b=node('button',null,'drawing-button');b.type='button';b.setAttribute('aria-current',String(d===drawing&&mode==='drawing'));b.append(node('strong',d.filename.replace(/_内部参考副本/g,'').replace(/\.pdf$/i,'')),node('small',published(d)?d.requirements.length+' 项要求 · '+statusLabel(d):statusLabel(d)+' · 无有效清单'));b.addEventListener('click',()=>selectDrawing(d));return b;}));
}
function render(){
  renderNavigation();$('spec-title').textContent=spec.metadata.title;$('spec-version').textContent=spec.metadata.number+' · '+spec.metadata.version;$('spec-scope').textContent=spec.metadata.scope;
  $('tab-drawing').setAttribute('aria-selected',String(mode==='drawing'));$('tab-spec').setAttribute('aria-selected',String(mode==='spec'));$('result-panel').setAttribute('aria-labelledby',mode==='drawing'?'tab-drawing':'tab-spec');
  const isSpec=mode==='spec';const rows=isSpec?spec.rules:drawing.requirements;const profile=isSpec?null:drawing.drawing;
  $('result-title').textContent=isSpec?'规范提取结果':profile.name||drawing.filename.replace(/\.pdf$/i,'');
  $('result-file').textContent=isSpec?spec.metadata.number+' · '+(scoped(spec)?spec.rules.filter(r=>r.usage==='inspection').length+' 条检验候选，'+spec.rules.filter(r=>r.usage==='comparison').length+' 条对照依据':spec.rules.length+' 条历史规范记录'):drawing.filename;
  $('result-count').textContent=!isSpec&&!published(drawing)?statusLabel(drawing):rows.length+(isSpec?' 条规范依据':' 项工艺要求');
  $('result-status').replaceChildren(...(isSpec?[]:[statusCard(drawing)]));
  const tags=[];if(profile){if(profile.partNumber)tags.push('图号（提取值） '+profile.partNumber);if(profile.material)tags.push('材料 '+simple(profile.material));if(profile.revision)tags.push('版次 '+profile.revision);}
  $('profile').replaceChildren(...tags.map(t=>node('span',t)));$('profile').hidden=!tags.length;
  const warnings=isSpec?spec.warnings:drawing.warnings;const review=warnings.filter(w=>typeof w==='string'&&w.startsWith('【原图复核】'));
  $('review-notices').replaceChildren(...review.map(w=>{const box=node('div',null,'notice');box.append(node('strong','原图复核提示 · 独立 GPT 抽查'),node('p',w.replace(/^【原图复核】GPT 对照原件的抽查提示，非 DeepSeek 自动结论：/,'')));return box;}));
  const pending=profile?(profile.uncertainties||[]):[];listDetails('uncertainties','uncertainty-title','uncertainty-list',pending,'零件信息与适用条件待确认');
  const applicability=isSpec?[]:pendingApplicability(spec,drawing);listDetails('applicability','applicability-title','applicability-list',applicability,'规范适用性待复核');
  listDetails('warnings','warning-title','warning-list',warnings.filter(w=>!review.includes(w)),'提取说明与疑点');
  $('context-control').hidden=!isSpec||scoped(spec)||!rows.some(background);$('usage-filter').hidden=!isSpec||!scoped(spec);$('category-filter').hidden=isSpec||!scoped(drawing);$('conflict-filter').hidden=isSpec||!scoped(drawing);categoryOptions(isSpec?[]:rows);renderTable();
}
function renderTable(){
  const query=$('search').value.trim().toLocaleLowerCase();const rows=mode==='spec'?spec.rules:drawing.requirements;
  const eligible=rows.filter(r=>mode==='spec'&&scoped(spec)?$('usage-filter').value==='all'||r.usage===$('usage-filter').value:!background(r)||(mode==='spec'&&$('include-context').checked));
  visibleRows=eligible.filter(r=>(mode==='spec'||!scoped(drawing)||(!$('category-filter').value||r.processCategory===$('category-filter').value)&&(!$('conflict-filter').value||conflictKind(r)===$('conflict-filter').value))&&(!$('pending-only').checked||isPending(r))&&(!query||[r.category,r.requirement,r.processCategory,r.scope,r.review_note,simple(r.conflict),simple(r.sources),simple(r.conditions),r.id].join(' ').toLocaleLowerCase().includes(query)));
  $('table-count').textContent='显示 '+visibleRows.length+' / '+eligible.length+' 项'+($('pending-only').checked?' · 待复核项':'');
  const fragment=document.createDocumentFragment();
  for(const row of visibleRows){const tr=node('tr');const name=node('td');name.append(node('span',row.id,'row-id'),node('span',row.category));if(row.usage)name.append(node('br'),node('span',row.usage==='inspection'?'检验候选':'仅用于对照','source-kind'));if(isPending(row))name.append(node('br'),node('span','待复核','pending'));if(background(row))name.append(node('br'),node('span','背景说明','pending'));const metric=node('td');if(conflictKind(row))metric.append(node('strong','图纸执行要求'));metric.append(node('div',row.requirement,'req-text'));
    if(conflictKind(row)){const kind=conflictKind(row);tr.className=kind==='conflict'?'has-conflict':'has-override';name.append(node('br'),node('span',kind==='conflict'?'要求冲突':'图纸覆盖','conflict-chip '+kind));const box=node('div',null,'conflict-box '+kind);box.append(node('strong',kind==='conflict'?'要求冲突 · 以图纸为准，需核对':'图纸覆盖通用要求'),node('p','规范要求：'+row.conflict.specificationRequirement),node('p',row.conflict.reason));metric.append(box);}
    const sources=row.sources||[];const details=node('details',null,'evidence');details.append(node('summary','来源与适用条件'+(sources.length?' · '+sources.length+' 处':'')));const body=node('div',null,'evidence-content');
    for(const [label,value] of [['适用范围',row.scope],['适用条件',row.conditions],['例外',row.exceptions],['复核说明',row.review_note],['关联规范规则',row.ruleIds],['覆盖关系',row.overridePolicy],['外部引用',row.externalReferences]])if(simple(value))body.append(node('p',label+'：'+simple(value)));
    for(const source of sources){body.append(node('p',source.file+' · 物理页 '+source.page+(source.section?' · '+source.section:''),'source-label'));if(source.quote)body.append(node('blockquote',source.quote));}
    if(!body.childNodes.length)body.append(node('p','此条未附其他说明。'));details.append(body);metric.append(details);tr.append(name,metric,node('td',processStage(row),'stage-cell'));fragment.append(tr);
  }
  $('requirements').replaceChildren(fragment);$('empty').hidden=visibleRows.length>0;$('export-csv').disabled=visibleRows.length===0;
}
$('tab-drawing').addEventListener('click',()=>{mode='drawing';clearFilters();render();});$('tab-spec').addEventListener('click',()=>{mode='spec';clearFilters();render();});
$('search').addEventListener('input',renderTable);$('pending-only').addEventListener('change',renderTable);$('include-context').addEventListener('change',renderTable);
for(const id of ['category-filter','conflict-filter','usage-filter'])$(id).addEventListener('change',renderTable);
function csvCell(value){let s=String(value??'');if(/^\s*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function csvContent(rows){return '\ufeff'+[['工艺要求的名称','量化指标','阶段'],...rows.map(r=>[r.category,r.requirement,processStage(r)])].map(row=>row.map(csvCell).join(',')).join('\r\n');}
$('export-csv').addEventListener('click',()=>download(currentName()+'-工艺要求.csv',csvContent(visibleRows),'text/csv;charset=utf-8'));
$('export-json').addEventListener('click',()=>{const value=mode==='spec'?{...spec,drawings:undefined}:{specification:{id:spec.id,metadata:spec.metadata,sourceSha256:spec.sourceSha256},...drawing};download(currentName()+'-完整结果.json',JSON.stringify(value,null,2),'application/json;charset=utf-8');});
$('export-all').addEventListener('click',()=>download('全部规范与图纸-静态快照.json',JSON.stringify(report,null,2),'application/json;charset=utf-8'));
$('print').addEventListener('click',()=>window.print());
$('footer').textContent='数据快照 '+report.exportedAt.replace('T',' ').replace('+08:00','（北京时间）')+' · 单文件离线查看 · 原 PDF 未内嵌，保留来源引文与物理页码';
for(const [id,value] of [['total-specs',report.totals.specifications],['total-drawings',report.totals.drawings],['total-rows',report.totals.requirements]])$(id).textContent=value;
$('snapshot-status').textContent=snapshotStatusText(specs.flatMap(s=>s.drawings));
render();
</script>
</body>
</html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--state-file", required=True, type=Path, help="JSON with specifications mapping and explicit batches [{series,id}]")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allow-incomplete", action="store_true", help="Explicitly export latest failed/pending attempts as status cards with no requirements; never fall back to older results")
    args = parser.parse_args()
    data = snapshot(args.base_url, json.loads(args.state_file.read_text(encoding="utf-8-sig")), allow_incomplete=args.allow_incomplete)
    # Escape HTML parser delimiters, including user/model-authored text in script JSON.
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    page = HTML.replace("__REPORT_DATA__", payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page, encoding="utf-8")
    print(json.dumps({"output": str(args.output), "bytes": args.output.stat().st_size, "totals": data["totals"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
