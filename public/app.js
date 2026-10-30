"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const state = { configured: false, specifications: [], specId: null, specJob: null, specSubmitting: false, drawingSubmitting: false, files: [], batchId: null, batch: null, drawingId: null, resultKey: "", filter: "core", search: "", pollTimer: null, pollRunning: false, pollErrors: 0, specListRequest: null, specRequests: new Map(), specListKey: "", retryingDrawings: new Set(), savedBatches: [], savedSpecId: null, savedLoading: false, savedError: "", savedRequest: 0 };
  const statusNames = { queued: "等待处理", preparing: "读取页面", extracting: "解析规则", matching: "匹配要求", auditing: "核对原文", running: "正在处理", completed: "已完成", partial: "部分完成", failed: "未完成" };
  const strengthNames = { required: "必须", prohibited: "禁止", recommended: "推荐", permitted: "允许", reference: "参考", conditional: "条件适用" };
  const dispositionNames = { applicable: "适用", not_applicable: "不适用", overridden: "图纸覆盖", needs_confirmation: "待确认" };
  const originNames = { drawing: "图纸要求", specification: "规范要求", combined: "规范＋图纸" };
  const stageNames = { all: "保留全部阶段条件", sample: "样件阶段", trial: "试生产阶段", batch: "批量生产阶段" };
  const list = value => Array.isArray(value) ? value : [];
  const str = (value, fallback = "") => value == null ? fallback : typeof value === "object" ? JSON.stringify(value) : String(value);
  const active = value => Boolean(value) && !["completed", "partial", "failed"].includes(value);
  const enc = value => encodeURIComponent(str(value));
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = str(text); return node; };
  const showAlert = message => { $("alert-text").textContent = str(message); $("global-alert").hidden = false; };
  const clearAlert = () => { $("global-alert").hidden = true; };
  const selectedDrawing = () => list(state.batch?.drawings).find(item => item.id === state.drawingId);
  const currentResult = () => selectedDrawing()?.result;
  const informationNames = { manufacturing: "直接制造约束", quality: "质量与检验", procurement: "采购与交付", context: "背景说明", unclassified: "待分类" };
  const scopeNames = { core: "制造与检验", manufacturing: "直接制造约束", quality: "质量与检验", review: "制造与检验待复核", procurement: "采购与交付", context: "背景说明", unclassified: "待分类", all: "全部记录" };
  const informationType = item => Object.hasOwn(informationNames, item?.informationType) ? item.informationType : "unclassified";
  const core = item => ["manufacturing", "quality", "unclassified"].includes(informationType(item));
  const classificationPending = item => Boolean(item.classificationPending || item.classification?.pending || informationType(item) === "unclassified");
  const needsReview = item => Boolean(item.review_required || classificationPending(item));
  function informationSummary(items) {
    const counts = { total: items.length, manufacturing: 0, quality: 0, procurement: 0, context: 0, unclassified: 0 };
    items.forEach(item => counts[informationType(item)]++);
    return { ...counts, core: counts.manufacturing + counts.quality, actionable: counts.manufacturing + counts.quality + counts.procurement };
  }
  const inScope = (item, scope) => scope === "all" || scope === "core" && core(item) || scope === "review" && core(item) && needsReview(item) || informationType(item) === scope;
  function informationNote(items) {
    const counts = informationSummary(items), pending = items.filter(classificationPending).length;
    const note = el("p", "information-note", `完整资料 ${counts.total} 条记录；制造与检验 ${counts.core} 条，采购与交付 ${counts.procurement} 条，背景说明 ${counts.context} 条${counts.unclassified ? `，另有 ${counts.unclassified} 条未分类记录默认保留待确认` : ""}。背景定义和引用导航不计入可执行要求。`);
    if (pending) note.append(el("strong", "", ` ${pending} 条分类仍待确认，保留在页面供核对；未分类记录不会归入制造约束。`));
    return note;
  }
  function informationTag(item) {
    const type = informationType(item), tag = el("span", `information-tag ${type}`, informationNames[type]);
    tag.title = [item.classification?.reason, classificationPending(item) ? "信息类型尚待确认" : ""].filter(Boolean).join("；");
    return tag;
  }
  function classificationExplanation(item) {
    if (!item.classification?.reason && !classificationPending(item)) return null;
    const panel = details(classificationPending(item) ? "分类依据 · 待确认" : "分类依据"); panel.node.classList.add("classification-details");
    if (item.classification?.reason) panel.body.append(el("p", "", item.classification.reason));
    const source = ({ model_output: "本轮提取时分类", legacy_profile: "既有记录重新分类", legacy_category: "旧记录分类候选" })[item.classification?.source] || "分类来源未记录";
    panel.body.append(el("p", "classification-source", `${source}${classificationPending(item) ? "；分类尚待确认，不能据此视为确定的制造约束。" : ""}`)); return panel.node;
  }
  function filteredRequirements(result, scope = state.filter, keyword = state.search) {
    const query = str(keyword).trim().toLocaleLowerCase();
    return list(result.requirements).filter(item => inScope(item, scope) && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
  }
  const uniqueText = values => [...new Set(values.map(value => str(value).trim()).filter(Boolean))];
  const specificationTitle = meta => uniqueText([meta?.number, meta?.version]).join(" · ");
  function creationLabel(spec, batchFirst = false) {
    const created = new Date(spec.createdAt), batch = spec.id ? `解析批次 ${str(spec.id).slice(0, 8)}` : "";
    const when = spec.createdAt && !Number.isNaN(created.getTime()) ? `建立于 ${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(created)}` : "建立时间未记录";
    return (batchFirst ? [batch, when] : [when, batch]).filter(Boolean).join(" · ");
  }
  const specListKey = () => JSON.stringify([state.specId, state.specifications.map(({ id, status, sourceSha256, name, metadata, ruleCount, recordCount, informationSummary, classification, warningsCount, createdAt }) => ({ id, status, sourceSha256, name, metadata, ruleCount, recordCount, informationSummary, classification, warningsCount, createdAt }))]);

  async function api(url, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error(`服务响应无法识别（HTTP ${response.status}），请检查后端状态。`);
      const data = await response.json();
      if (!response.ok) throw new Error(str(data.error || data.message, `请求失败（HTTP ${response.status}）`));
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("服务响应超时。任务可能仍在后台运行，请刷新状态后再操作。");
      if (error instanceof TypeError) throw new Error("无法连接到服务，请确认后端已启动。");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function updateUrl() {
    const url = new URL(location.href);
    for (const [key, value] of [["spec", state.specId], ["batch", state.batchId], ["drawing", state.drawingId]]) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    url.searchParams.delete("job"); history.replaceState(null, "", url);
  }
  function updateControls() {
    const specBusy = state.specSubmitting;
    const drawBusy = state.drawingSubmitting || active(state.batch?.status);
    $("build-spec").disabled = specBusy || !state.configured || !$("spec-file").files.length;
    $("spec-file").disabled = specBusy; $("spec-label").disabled = specBusy;
    $("build-spec").textContent = specBusy ? "正在提交规范…" : "导入并解析规范 →";
    $("spec-start-hint").textContent = specBusy ? "上传完成后，规范将在后台解析" : !state.configured ? "等待服务和模型配置就绪" : $("spec-file").files.length ? "整份规范将分批解析并核对" : active(state.specJob?.status) ? "当前规范在后台解析，可继续新增其他规范" : "这里只导入技术规范 PDF；对应图纸在下一步导入";
    $("start-drawings").disabled = drawBusy || !state.configured || !$("spec-select").value || !state.files.length;
    $("drawing-files").disabled = drawBusy; $("spec-select").disabled = drawBusy; $("production-stage").disabled = drawBusy;
    $("dropzone").classList.toggle("disabled", drawBusy); $("dropzone").setAttribute("aria-disabled", str(drawBusy));
    $("clear-files").hidden = !state.files.length || drawBusy;
    $("start-drawings").textContent = drawBusy ? "正在逐件提取…" : "开始逐件提取 →";
    $("drawing-start-hint").textContent = drawBusy ? "每张图纸独立处理，完成的零件可先查看" : !state.configured ? "等待服务和模型配置就绪" : !$("spec-select").value ? "请先选择已完成的规范版本" : state.files.length ? `已准备 ${state.files.length} 张图纸，逐件生成要求` : "添加与所选规范对应的图纸";
    document.querySelectorAll(".file-remove").forEach(button => { button.disabled = drawBusy; });
    $("export-actions").hidden = !currentResult();
    updateRetryButtons();
  }
  async function health() {
    $("refresh-health").disabled = true;
    try { const data = await api("/api/health"); state.configured = Boolean(data.ok && data.configured); $("connection-text").textContent = state.configured ? "服务已就绪" : "请配置模型 API 密钥"; }
    catch (error) { state.configured = false; $("connection-text").textContent = "服务未连接"; $("connection-text").title = error.message; }
    finally { $("connection-dot").className = `status-dot ${state.configured ? "connected" : "error"}`; $("refresh-health").disabled = false; updateControls(); }
  }
  function badge(status) { return el("span", `status-tag ${active(status) ? "active" : status === "failed" ? "failed" : status === "partial" ? "partial" : ""}`, statusNames[status] || status || "未知状态"); }
  function statusBox(job) {
    const box = el("div", `status-box ${job.status === "failed" ? "failed" : ""}`);
    const line = el("div", "progress-activity"); if (active(job.status)) line.append(el("span", "spinner"));
    line.append(el("span", "", job.error || job.message || statusNames[job.status])); box.append(line); return box;
  }
  function stats(entries) {
    const grid = el("div", "stats-grid");
    for (const [label, value] of entries) { const item = el("div", "stat"); item.append(el("strong", "", value ?? "—"), el("span", "", label)); grid.append(item); }
    return grid;
  }
  function details(title, open = false) {
    const node = el("details", "details-panel"); node.open = open;
    const body = el("div", "panel-body"); node.append(el("summary", "", title), body); return { node, body };
  }
  function sourceLink(text, url) { const a = el("a", "source-link", text); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  function context(result, drawing) { return { specId: result?.specification?.id || state.batch?.specificationId, batchId: state.batchId, drawingId: drawing?.id, documents: list(result?.documents) }; }
  function evidence(sources, ctx = {}) {
    const rows = list(sources), node = el("details", "evidence"); node.append(el("summary", "", `原文依据 · ${rows.length} 处`));
    const body = el("div", "evidence-list");
    for (const source of rows) {
      const item = el("div", "source-item"), head = el("div", "source-head");
      const isSpec = ctx.specOnly || ctx.documents?.some(doc => doc.name === source.file && doc.role === "specification");
      let url = null;
      if (isSpec && ctx.specId) url = `/api/specifications/${enc(ctx.specId)}/file`;
      else if (ctx.batchId && ctx.drawingId) url = `/api/drawing-batches/${enc(ctx.batchId)}/drawings/${enc(ctx.drawingId)}/file`;
      const page = Number(source.page); if (url && Number.isInteger(page) && page > 0) url += `#page=${page}`;
      head.append(url ? sourceLink(source.file || "原始 PDF", url) : el("span", "", source.file || "来源文件"), el("span", "", `物理页 ${str(source.page, "—")}`));
      if (source.verification) head.append(el("span", "", ({ text_match: "引文可定位", visual_review: "图像证据待核对", unmatched_quote: "引文待核对", invalid_location: "来源待核对" })[source.verification] || "来源待核对"));
      item.append(head, el("blockquote", "", source.quote)); if (source.section) item.append(el("div", "source-location", `条款 / 位置：${source.section}`)); body.append(item);
    }
    if (!rows.length) body.append(el("p", "placeholder", "未提供可定位证据，请核对。"));
    node.append(body); return node;
  }
  function parameters(items) {
    const values = list(items); if (!values.length) return null;
    const ul = el("ul", "parameter-list"); for (const p of values) { const li = el("li", "", p.name); li.append(el("strong", "", `${str(p.value)}${p.unit ? ` ${p.unit}` : ""}`)); ul.append(li); } return ul;
  }
  function warnings(items, title = "解析提示与待核对事项") {
    const values = [...new Set(list(items).map(item => str(item)).filter(Boolean))]; if (!values.length) return null;
    const panel = details(`${title} · ${values.length} 项`), ul = el("ul", "warning-list"); values.forEach(item => ul.append(el("li", "", item))); panel.body.append(ul); return panel.node;
  }
  function coverage(data, review) {
    if (!data) return null;
    const panel = details("原文覆盖与核对范围");
    const reviewBatches = data.reviewBatches ?? review?.batchCount ?? (Array.isArray(review?.runs) ? review.runs.length : review?.metadata ? 1 : undefined);
    panel.body.append(stats([["物理页数", data.totalPages ?? data.physicalPages], ["已提交图像的页数", data.visualPages ?? data.renderedPages], ["图像缺口", data.failedVisualPages ?? list(data.missingImagePages).length], ["核对批次", reviewBatches]]));
    if (data.tableStructure) {
      const structure = data.tableStructure, count = Number.isInteger(structure.tables) && structure.tables >= 0 ? structure.tables : "—";
      const recovered = el("p", "panel-note"); recovered.append(el("strong", "", `已恢复向量表格 ${count} 张`));
      if (structure.engine || structure.version) recovered.append(el("span", "", ` · ${[structure.engine, structure.version].filter(Boolean).join(" ")}`));
      panel.body.append(recovered, el("p", "coverage-note", "按原 PDF 格线展开单元格合并范围，并与原图联合核对；扫描表格仍依赖图像识读。恢复数量不代表提取准确率。"));
    }
    if (Number(data.failedVisualPages) > 0) panel.body.append(el("p", "notice", `${data.failedVisualPages} 页图像未能提交，请查看原 PDF。`));
    panel.body.append(el("p", "coverage-note", data.note || "这些记录说明页面已提交模型，不代表模型理解正确或没有遗漏。图像证据和待确认内容仍需对照原文。")); return panel.node;
  }
  function specificationKey(spec) {
    return spec?.sourceSha256 ? `file:${spec.sourceSha256}` : `job:${spec?.id}`;
  }
  function specificationViews(specifications, selectedId) {
    const groups = new Map();
    const sorted = [...specifications].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    for (const spec of sorted) {
      const key = specificationKey(spec);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(spec);
    }
    const library = [], completed = [];
    for (const attempts of groups.values()) {
      library.push(attempts.find(spec => active(spec.status) || spec.status === "completed") || attempts[0]);
      const ready = attempts.find(spec => spec.status === "completed");
      if (ready) completed.push(attempts.find(spec => spec.id === selectedId && spec.status === "completed") || ready);
    }
    return { library, completed };
  }
  function renderSpecList() {
    state.specListKey = specListKey();
    const { library, completed } = specificationViews(state.specifications, state.specId);
    const selected = state.specifications.find(spec => spec.id === state.specId) || state.specJob;
    const holder = $("spec-list"); holder.replaceChildren(); $("spec-count").textContent = `${library.length} 个`;
    for (const spec of library) {
      const chosen = Boolean(selected) && specificationKey(spec) === specificationKey(selected);
      const item = el("button", `library-item ${chosen ? "selected" : ""}`); item.type = "button"; item.setAttribute("aria-pressed", str(chosen));
      const meta = spec.metadata || {}; item.append(el("strong", "", specificationTitle(meta) || spec.name || "技术规范"), el("small", "", meta.title || spec.name || ""), badge(spec.status));
      if (spec.status === "completed") {
        const counts = spec.informationSummary;
        item.append(el("small", "", counts ? `制造与检验 ${counts.core ?? 0} · 采购交付 ${counts.procurement ?? 0} · 背景 ${counts.context ?? 0}` : `共 ${spec.recordCount ?? spec.ruleCount ?? 0} 条历史记录 · 分类待确认`));
        if (counts?.unclassified) item.append(el("small", "", `另有 ${counts.unclassified} 条待分类`));
        if (spec.classification?.pending) item.append(el("small", "classification-list-note", "信息分类仍有待确认项"));
      }
      item.append(el("small", "creation-meta", creationLabel(spec)));
      item.addEventListener("click", () => selectSpec(spec.id).catch(error => showAlert(error.message))); holder.append(item);
    }
    if (!library.length) holder.append(el("p", "placeholder", "规范库还没有内容，请先上传一份技术规范。"));
    const select = $("spec-select"), previous = select.value; select.replaceChildren();
    const option = el("option", "", completed.length ? "选择技术规范" : "请先建立技术规范库"); option.value = ""; select.append(option);
    for (const spec of completed) { const o = el("option", "", [specificationTitle(spec.metadata) || spec.name || "技术规范", creationLabel(spec, true), spec.metadata?.title].filter(Boolean).join(" · ")); o.value = spec.id; select.append(o); }
    if (completed.some(spec => spec.id === previous)) select.value = previous;
    else if (completed.some(spec => spec.id === state.specId)) select.value = state.specId;
    updateControls();
  }
  function refreshSpecs() {
    if (!state.specListRequest) state.specListRequest = api("/api/specifications").then(data => {
      state.specifications = list(data.specifications);
      if (state.specListKey !== specListKey()) renderSpecList();
    }).finally(() => { state.specListRequest = null; });
    return state.specListRequest;
  }
  function fetchSpecJob(id) {
    if (!state.specRequests.has(id)) state.specRequests.set(id, api(`/api/specifications/${enc(id)}`).finally(() => state.specRequests.delete(id)));
    return state.specRequests.get(id);
  }
  function updateSpecSummary(job) {
    state.specifications = state.specifications.map(spec => spec.id === job.id ? { ...spec, status: job.status, message: job.message, ...(job.result ? { metadata: job.result.metadata, ruleCount: job.result.informationSummary?.actionable ?? list(job.result.rules).length, recordCount: list(job.result.rules).length, informationSummary: job.result.informationSummary, classification: job.result.classification, warningsCount: list(job.result.warnings).length } : {}) } : spec);
    if (state.specListKey !== specListKey()) renderSpecList();
  }
  function renderRule(rule, specId) {
    const card = el("article", "rule-card"), top = el("div", "item-top");
    top.append(el("span", "item-id", rule.id), informationTag(rule), el("span", "item-category", rule.category), el("span", "item-strength", strengthNames[rule.strength] || rule.strength || ""));
    if (needsReview(rule)) top.append(el("span", "status-tag warning", "待确认"));
    card.append(top, el("p", "item-text", rule.requirement));
    const params = parameters(rule.parameters); if (params) card.append(params);
    const fields = el("dl", "rule-fields");
    for (const [label, value] of [["范围", rule.scope], ["适用条件", list(rule.conditions).join("；")], ["例外", list(rule.exceptions).join("；")], ["覆盖 / 优先关系", rule.overridePolicy], ["引用文件", list(rule.externalReferences).join("；")]]) { if (value) fields.append(el("dt", "", label), el("dd", "", value)); }
    card.append(fields); const classification = classificationExplanation(rule); if (classification) card.append(classification); if (rule.review_note) card.append(el("p", "review-note", rule.review_note)); card.append(evidence(rule.sources, { specOnly: true, specId })); return card;
  }
  function renderSpec(job) {
    const holder = $("spec-detail"); holder.replaceChildren(); const result = job.result, meta = result?.metadata || {};
    const head = el("div", "detail-title"), names = el("div"); names.append(el("h3", "", meta.title || job.name || "技术规范"), el("div", "detail-subtitle", uniqueText([meta.number, meta.version && meta.version !== meta.number ? `版本 ${meta.version}` : !meta.version && result ? "版本未识别，待确认" : ""]).join(" · ")), el("div", "detail-subtitle creation-meta", creationLabel(job))); head.append(names, badge(job.status)); holder.append(head);
    const progress = statusBox(job.status === "completed" && result ? { ...job, message: `规范解析已完成：共 ${list(result.rules).length} 条资料记录，含采购交付及背景；默认查看制造与检验。` } : job); progress.id = "spec-progress-status"; holder.append(progress);
    const links = el("div", "detail-links"); links.append(sourceLink("打开规范原文 ↗", `/api/specifications/${enc(job.id)}/file`));
    if (result) { const exportButton = el("button", "text-button", "导出完整规范 JSON"); exportButton.type = "button"; exportButton.addEventListener("click", () => download(JSON.stringify(result, null, 2), `${specificationTitle(meta) || "技术规范"}-完整规范记录.json`, "application/json;charset=utf-8")); links.append(exportButton); } holder.append(links);
    if (!result) { if (job.status === "failed") holder.append(el("p", "notice", "本次未生成可用规范库。请根据错误处理后重新上传；已完成的其他版本仍可使用。")); return; }
    const rules = list(result.rules), counts = informationSummary(rules);
    holder.append(stats([["直接制造约束", counts.manufacturing], ["质量与检验", counts.quality], ["采购与交付", counts.procurement], ["背景说明", counts.context]]), informationNote(rules));
    if (meta.scope) holder.append(el("p", "detail-scope", meta.scope));
    if (list(meta.excludedProcesses).length) holder.append(el("p", "rule-note", `排除范围：${list(meta.excludedProcesses).join("；")}`));
    if (meta.priorityPolicy) holder.append(el("p", "rule-note", `优先关系：${meta.priorityPolicy}`));
    const warn = warnings(result.warnings); if (warn) holder.append(warn); const cov = coverage(result.sourceCoverage, result.review); if (cov) holder.append(cov);
    const panel = details(`分层查看规范 · ${rules.length} 条记录`), input = el("input", "search-input"), scope = el("select", "information-select"); input.type = "search"; input.placeholder = "搜索要求、适用条件、例外、原文…"; input.setAttribute("aria-label", "搜索规范记录");
    scope.setAttribute("aria-label", "按规范信息类型筛选");
    for (const value of ["core", "manufacturing", "quality", "procurement", "context", "unclassified", "all"]) { const option = el("option", "", scopeNames[value]); option.value = value; scope.append(option); }
    const controls = el("div", "information-controls"), count = el("p", "panel-note"), rows = el("div", "rule-list"); controls.append(scope, input);
    const render = () => { const keyword = input.value.trim().toLocaleLowerCase(), scoped = rules.filter(rule => inScope(rule, scope.value)), filtered = scoped.filter(rule => !keyword || JSON.stringify(rule).toLocaleLowerCase().includes(keyword)); rows.replaceChildren(); count.textContent = `当前：${scopeNames[scope.value]}，显示 ${filtered.length} / ${scoped.length} 条记录。具体是否适用仍由每张图纸分别判断。`; filtered.forEach(rule => rows.append(renderRule(rule, job.id))); if (!filtered.length) rows.append(el("p", "empty-inline", "当前信息类型没有匹配记录，可切换类型或调整关键词。")); };
    input.addEventListener("input", render); scope.addEventListener("change", render); panel.body.append(controls, count, rows); holder.append(panel.node); render();
  }
  async function selectSpec(id) {
    if (state.specId !== id) { state.batchId = null; state.batch = null; state.drawingId = null; state.resultKey = ""; renderBatch(true); }
    state.savedRequest++; state.savedSpecId = id; state.savedBatches = []; state.savedError = ""; state.savedLoading = true;
    state.specId = id; state.specJob = state.specifications.find(spec => spec.id === id) || null; renderSpecList(); $("spec-detail").replaceChildren(el("p", "placeholder", "正在读取规范详情…")); updateUrl(); schedulePoll();
    renderSavedDrawings();
    let job;
    try { job = await fetchSpecJob(id); }
    catch (error) {
      if (state.specId !== id) return;
      state.savedLoading = false; state.savedError = error.message; renderSavedDrawings(); throw error;
    }
    if (state.specId !== id) return;
    state.specJob = job; updateSpecSummary(job); if (job.status === "completed" && !active(state.batch?.status)) $("spec-select").value = id; renderSpec(job); updateControls(); schedulePoll();
    await refreshSavedDrawings(id, { open: true });
  }
  function savedDrawingRows(batches, specificationId) {
    const groups = new Map();
    const sorted = [...list(batches)].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    for (const batch of sorted) {
      if (batch.specificationId !== specificationId) continue;
      for (const drawing of list(batch.drawings)) {
        const key = JSON.stringify([batch.stage, drawing.sourceSha256 ? `file:${drawing.sourceSha256}` : `drawing:${batch.id}/${drawing.id}`]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...drawing, batchId: batch.id, specificationId, stage: batch.stage });
      }
    }
    return [...groups.values()].map(attempts => attempts.find(drawing => drawing.hasResult) || attempts[0]);
  }
  function renderSavedDrawings() {
    const holder = $("saved-drawings-list"), count = $("saved-drawings-count"); holder.replaceChildren();
    $("refresh-drawings").disabled = !state.specId || state.savedLoading;
    if (state.savedLoading) { count.textContent = "读取中"; holder.append(el("p", "placeholder", "正在读取这份规范的已有图纸…")); return; }
    if (state.savedError) { count.textContent = "读取失败"; holder.append(el("p", "review-note", `已有图纸读取失败：${state.savedError}。请点击“刷新已有图纸”，无需重新上传已处理的文件。`)); return; }
    const batches = state.savedBatches.map(batch => batch.id === state.batch?.id ? { ...batch, status: state.batch.status, drawings: list(state.batch.drawings).map(drawing => ({ ...drawing, hasResult: drawing.status === "completed" && list(drawing.result?.requirements).length > 0, partName: drawing.result?.drawing?.name, partNumber: drawing.result?.drawing?.partNumber, requirementCount: list(drawing.result?.requirements).length })) } : batch);
    const rows = savedDrawingRows(batches, state.specId), completed = rows.filter(row => row.hasResult).length;
    count.textContent = `${completed} 张已完成 / 共 ${rows.length} 张`;
    if (!rows.length) { holder.append(el("p", "placeholder", state.specId ? "这份规范还没有图纸结果，可展开下方入口导入对应图纸。" : "先选择一份技术规范，即可查看其已有图纸与结果。")); return; }
    for (const row of rows) {
      const button = el("button", `saved-drawing-item ${row.batchId === state.batchId && row.id === state.drawingId ? "selected" : ""}`), info = el("span", "saved-drawing-info"), meta = el("span", "saved-drawing-meta");
      button.type = "button"; button.setAttribute("aria-pressed", str(row.batchId === state.batchId && row.id === state.drawingId));
      info.append(el("strong", "", row.partName || row.name));
      if (row.partName && row.partName !== row.name) info.append(el("small", "", row.name));
      meta.append(badge(row.status)); if (row.hasResult) meta.append(el("span", "", `${row.requirementCount ?? 0} 项要求`));
      meta.append(el("span", "", stageNames[row.stage] || row.stage));
      button.append(info, meta, el("span", "saved-drawing-action", row.hasResult ? "查看结果 →" : "查看处理状态 →"));
      button.addEventListener("click", () => openSavedDrawing(row, { scroll: true }).catch(error => showAlert(error.message))); holder.append(button);
    }
  }
  async function refreshSavedDrawings(id, { open = false } = {}) {
    if (!id || state.specId !== id) return;
    const request = ++state.savedRequest;
    if (state.savedSpecId !== id || !state.savedBatches.length) state.savedLoading = true;
    state.savedSpecId = id; state.savedError = ""; renderSavedDrawings();
    try {
      const data = await api(`/api/drawing-batches?specificationId=${enc(id)}`);
      if (state.specId !== id || request !== state.savedRequest) return;
      state.savedBatches = list(data.batches).filter(batch => batch.specificationId === id); state.savedLoading = false; renderSavedDrawings();
      const rows = savedDrawingRows(state.savedBatches, id);
      if (open) {
        $("new-drawings").open = !rows.length;
        const requested = state.savedBatches.find(batch => batch.id === state.batchId);
        const row = requested ? { ...(list(requested.drawings).find(drawing => drawing.id === state.drawingId) || list(requested.drawings).find(drawing => drawing.hasResult) || list(requested.drawings)[0]), batchId: requested.id, specificationId: id } : rows.find(drawing => drawing.hasResult) || rows[0];
        if (row?.id) await openSavedDrawing(row);
        else { state.batchId = null; state.batch = null; state.drawingId = null; state.resultKey = ""; renderBatch(true); updateUrl(); }
      }
    } catch (error) {
      if (state.specId !== id || request !== state.savedRequest) return;
      state.savedLoading = false; state.savedError = error.message; renderSavedDrawings();
      if (open && !state.batch) showAlert(error.message);
    } finally { if (state.specId === id && request === state.savedRequest) { updateControls(); schedulePoll(); } }
  }
  async function openSavedDrawing(row, { scroll = false } = {}) {
    if (row.specificationId !== state.specId) return;
    state.batchId = row.batchId; state.drawingId = row.id; state.resultKey = ""; state.filter = "core"; state.search = "";
    if (state.batch?.id !== row.batchId) { state.batch = null; renderBatch(true); }
    renderSavedDrawings();
    await loadBatch(row.batchId, true);
    if (state.specId !== row.specificationId || state.batchId !== row.batchId || state.drawingId !== row.id) return;
    if (scroll) $("results-heading").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderFiles() {
    const holder = $("file-list"); holder.replaceChildren(); holder.hidden = !state.files.length;
    state.files.forEach((file, index) => { const row = el("li", "file-item"), info = el("div", "file-info"), remove = el("button", "icon-button file-remove", "×"); info.append(el("span", "file-name", file.name), el("span", "file-size", file.size < 1048576 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1048576).toFixed(1)} MB`)); remove.type = "button"; remove.setAttribute("aria-label", `移除 ${file.name}`); remove.addEventListener("click", () => { if (!active(state.batch?.status)) { state.files.splice(index, 1); renderFiles(); } }); row.append(el("span", "file-icon", "PDF"), info, remove); holder.append(row); }); updateControls();
  }
  function addFiles(files) {
    if (state.drawingSubmitting || active(state.batch?.status)) return;
    const rejected = []; clearAlert();
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { rejected.push(`${file.name}：仅支持 PDF`); continue; }
      if (!file.size) { rejected.push(`${file.name}：文件为空`); continue; }
      if (state.files.some(item => item.name === file.name)) { rejected.push(`${file.name}：名称重复`); continue; }
      if (state.files.length >= 20) { rejected.push("每批最多20份图纸"); break; }
      state.files.push(file);
    }
    renderFiles(); if (rejected.length) showAlert(rejected.join("；"));
  }
  function renderRequirement(item, ctx) {
    const row = el("tr", "requirement-row"), name = el("th", "requirement-name", item.category), metric = el("td", "requirement-metric"); name.scope = "row";
    metric.append(el("p", "item-text", item.requirement));
    const detail = details(needsReview(item) ? "查看依据与条件 · 待确认" : "查看依据与条件"); detail.node.classList.add("requirement-details");
    const top = el("div", "item-top"); top.append(el("span", "item-id", item.id), informationTag(item), el("span", "origin-tag", originNames[item.origin] || item.origin)); if (needsReview(item)) top.append(el("span", "status-tag warning", "待确认")); detail.body.append(top);
    const classification = classificationExplanation(item); if (classification) detail.body.append(classification); if (item.scope) detail.body.append(el("p", "item-scope", `适用：${item.scope}`));
    const params = parameters(item.parameters); if (params) detail.body.append(params); if (list(item.ruleIds).length) detail.body.append(el("p", "rule-refs", `关联规范规则：${list(item.ruleIds).join("、")}`)); if (item.review_note) detail.body.append(el("p", "review-note", item.review_note)); detail.body.append(evidence(item.sources, ctx)); metric.append(detail.node); row.append(name, metric); return row;
  }
  function dispositionPanel(result, ctx) {
    const boundId = result.specification?.id || state.batch?.specificationId;
    const ruleTypes = state.specJob?.id === boundId ? new Map(list(state.specJob.result?.rules).map(rule => [rule.id, rule.informationType])) : new Map();
    const rows = list(result.dispositions).map(row => ({ ...row, informationType: row.informationType || ruleTypes.get(row.ruleId) })), panel = details("规范适用处置 · 背景另列");
    const controls = el("div", "disposition-controls"), search = el("input"), filter = el("select"), scope = el("select"), holder = el("div", "disposition-list"), counters = el("div"), note = el("p", "panel-note"); search.type = "search"; search.placeholder = "搜索规则编号和处置原因…"; search.setAttribute("aria-label", "搜索规则处置"); filter.setAttribute("aria-label", "按规则处置筛选"); scope.setAttribute("aria-label", "按处置信息类型筛选");
    for (const [value, name] of [["", "全部处置"], ...Object.entries(dispositionNames)]) { const option = el("option", "", name); option.value = value; filter.append(option); }
    for (const value of ["core", "procurement", "context", "unclassified", "all"]) { const option = el("option", "", scopeNames[value]); option.value = value; scope.append(option); }
    const render = () => {
      holder.replaceChildren(); const keyword = search.value.trim().toLocaleLowerCase(), scoped = rows.filter(row => inScope(row, scope.value));
      counters.replaceChildren(stats([["适用", scoped.filter(x => x.status === "applicable").length], ["不适用", scoped.filter(x => x.status === "not_applicable").length], ["图纸覆盖", scoped.filter(x => x.status === "overridden").length], ["待确认", scoped.filter(x => x.status === "needs_confirmation").length]]));
      note.textContent = `当前：${scopeNames[scope.value]}。背景定义和引用导航不要求逐条适用处置；旧背景处置仅作历史说明。处置记录完整不代表判断正确。`;
      const filtered = scoped.filter(row => (!filter.value || row.status === filter.value) && (!keyword || JSON.stringify(row).toLocaleLowerCase().includes(keyword)));
      for (const row of filtered) { const div = el("div", "disposition-row"), head = el("div", "item-top"); head.append(el("span", "item-id", row.ruleId), informationTag(row), el("span", `disposition-status ${Object.hasOwn(dispositionNames, row.status) ? row.status : ""}`, dispositionNames[row.status] || row.status)); div.append(head, el("p", "", row.reason), evidence(row.evidence, ctx)); holder.append(div); }
      if (!filtered.length) holder.append(el("p", "empty-inline", "当前类型没有匹配的规则处置记录。"));
    };
    search.addEventListener("input", render); filter.addEventListener("change", render); scope.addEventListener("change", render); controls.append(search, scope, filter); panel.body.append(counters, note, controls, holder); render(); return panel.node;
  }
  function pendingIssues(result) {
    const values = [...list(result.drawing?.uncertainties).map(str), ...list(result.dispositions).filter(row => row.status === "needs_confirmation").map(row => `${row.ruleId}：${row.reason}`), ...list(result.warnings).map(str)]; return [...new Set(values.filter(Boolean))];
  }
  function retryAction(drawing) {
    if (!["failed", "completed"].includes(drawing.status)) return null;
    const key = `${state.batchId}/${drawing.id}`, button = el("button", drawing.status === "failed" ? "primary-button" : "secondary-button", state.retryingDrawings.has(key) ? "正在提交…" : drawing.status === "failed" ? "重试此零件" : "重新核对本零件");
    button.type = "button"; button.dataset.retryDrawing = drawing.id; button.dataset.retryBatch = state.batchId; button.disabled = state.retryingDrawings.has(key) || !state.configured;
    button.addEventListener("click", () => retryDrawing(drawing.id, button)); return button;
  }
  function updateRetryButtons() {
    document.querySelectorAll("[data-retry-drawing]").forEach(button => {
      const drawing = list(state.batch?.drawings).find(item => item.id === button.dataset.retryDrawing), key = `${button.dataset.retryBatch}/${button.dataset.retryDrawing}`;
      button.hidden = state.batchId !== button.dataset.retryBatch || !drawing || !["failed", "completed"].includes(drawing.status);
      button.disabled = state.retryingDrawings.has(key) || !state.configured;
      button.textContent = state.retryingDrawings.has(key) ? "正在提交…" : drawing?.status === "failed" ? "重试此零件" : "重新核对本零件";
    });
  }
  async function retryDrawing(drawingId, button) {
    const batchId = state.batchId, key = `${batchId}/${drawingId}`, drawing = list(state.batch?.drawings).find(item => item.id === drawingId);
    if (!batchId || !drawing || !["failed", "completed"].includes(drawing.status) || state.retryingDrawings.has(key) || !state.configured) return;
    state.retryingDrawings.add(key); if (button) { button.disabled = true; button.textContent = "正在提交…"; } clearAlert();
    let accepted = false;
    try {
      await api(`/api/drawing-batches/${enc(batchId)}/drawings/${enc(drawingId)}/retry`, { method: "POST" }); accepted = true;
      if (state.batchId === batchId) {
        drawing.status = "queued"; drawing.message = "等待重新核对"; delete drawing.result; delete drawing.error;
        state.batch.status = "queued"; state.batch.message = `重新核对 ${drawing.name || "本零件"}`; state.resultKey = ""; renderBatch(true);
        await loadBatch(batchId, true);
        await refreshSavedDrawings(state.specId);
      }
    } catch (error) {
      showAlert(error.message);
      // A request can be accepted before the connection fails. Read the original
      // batch once before making a retry available; never resubmit automatically.
      if (!accepted && state.batchId === batchId) {
        try { await loadBatch(batchId, true); } catch { /* Keep the visible error. */ }
      }
    } finally {
      state.retryingDrawings.delete(key);
      if (state.batchId === batchId) { updateControls(); schedulePoll(); }
    }
  }
  function renderDrawing(drawing) {
    const holder = $("drawing-result"); holder.replaceChildren(); if (!drawing) return;
    if (!drawing.result) { holder.append(statusBox(drawing)); holder.append(el("p", "notice", drawing.status === "failed" ? "这张图纸未生成可用结果。可沿用原图纸和规范版本，单独重试这个零件。其他已完成零件可分别查看。" : "每个零件独立处理，当前图纸的要求将在完成后显示。")); const retry = retryAction(drawing); if (retry) holder.append(retry); return; }
    const result = drawing.result, profile = result.drawing || {}, ctx = context(result, drawing), items = list(result.requirements);
    list(result.warnings).filter(note => str(note).startsWith("【原图复核】")).forEach(note => holder.append(el("p", "review-note", note)));
    const card = el("div", "profile"); card.append(el("h3", "", profile.name || drawing.name));
    const meta = el("div", "profile-meta"); for (const [label, value] of [["图号", profile.partNumber], ["版本", profile.revision], ["材料", profile.material], ["材料形态", profile.materialForm], ["制造方法", profile.process], ["类别", profile.castingClass], ["气密", ({ required: "有要求", not_required: "明确无要求", unspecified: "未明确" })[profile.airtightness]], ["尺寸状态", ({ before_finish: "表面处理前", after_finish: "表面处理后", unspecified: "未明确" })[profile.dimensionState]]]) { if (value) { const entry = el("span", "", label); entry.append(el("strong", "", value)); meta.append(entry); } } card.append(meta);
    const norm = result.specification || state.batch?.specification || {}; card.append(el("p", "", `使用规范：${uniqueText([norm.number || norm.metadata?.number, norm.version || norm.metadata?.version]).join(" · ") || "选定的规范版本"}；${stageNames[state.batch?.stage] || "保留全部阶段条件"}`));
    if (result.summary) card.append(el("p", "", result.summary));
    const links = el("div", "profile-links"); links.append(sourceLink("打开本零件图纸 ↗", `/api/drawing-batches/${enc(state.batchId)}/drawings/${enc(drawing.id)}/file`)); if (ctx.specId) links.append(sourceLink("打开关联规范 ↗", `/api/specifications/${enc(ctx.specId)}/file`)); const retry = retryAction(drawing); if (retry) links.append(retry); card.append(links);
    if (list(profile.references).length) card.append(el("p", "", `图纸引用：${list(profile.references).join("；")}`));
    if (list(profile.facts).length) { const facts = details(`图纸事实与依据 · ${profile.facts.length} 项`), grid = el("div", "profile-facts"); profile.facts.forEach(fact => { const item = el("div", "profile-fact"); item.append(el("strong", "", fact.name), el("p", "", fact.value), evidence(fact.sources, ctx)); grid.append(item); }); facts.body.append(grid); card.append(facts.node); }
    const typeCounts = informationSummary(items);
    holder.append(card, stats([["直接制造约束", typeCounts.manufacturing], ["质量与检验", typeCounts.quality], ["采购与交付", typeCounts.procurement], ["背景说明", typeCounts.context]]), informationNote(items));
    const cov = coverage(result.sourceCoverage, result.review); if (cov) holder.append(cov); holder.append(dispositionPanel(result, ctx));
    const warn = warnings(result.warnings, "零件提示"); if (warn) holder.append(warn);
    const toolbar = el("div", "result-toolbar"), tabs = el("div", "filter-tabs"), search = el("input", "result-search"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "按要求类型筛选"); search.type = "search"; search.placeholder = "搜索要求、参数、原文…"; search.setAttribute("aria-label", "搜索零件要求"); search.value = state.search;
    const pending = pendingIssues(result), pendingPanel = details(`跨类别条件与引用提示 · ${pending.length} 项`), pendingList = el("ul", "warning-list"); pending.forEach(issue => pendingList.append(el("li", "", issue))); pendingPanel.body.append(el("p", "panel-note", "这里保留完整资料的条件和引用疑点，可能涉及采购、交付或背景；不计入制造与检验待确认条数。"), pendingList);
    const counts = { core: items.filter(core).length, manufacturing: typeCounts.manufacturing, quality: typeCounts.quality, review: items.filter(item => core(item) && needsReview(item)).length, procurement: typeCounts.procurement, context: typeCounts.context, unclassified: typeCounts.unclassified, all: items.length };
    const tableWrap = el("div", "requirements-table-wrap"), table = el("table", "requirements-table"), head = el("thead"), headRow = el("tr"), rowHolder = el("tbody"), caption = el("div", "visible-caption");
    table.setAttribute("aria-label", "零件工艺要求"); for (const title of ["工艺要求的名称", "量化指标"]) { const cell = el("th", "", title); cell.scope = "col"; headRow.append(cell); } head.append(headRow); table.append(head, rowHolder); tableWrap.append(table);
    const render = () => {
      const filtered = filteredRequirements(result), scopedCount = items.filter(item => inScope(item, state.filter)).length;
      rowHolder.replaceChildren(); filtered.forEach(item => rowHolder.append(renderRequirement(item, ctx))); if (!filtered.length) { const row = el("tr"), cell = el("td", "no-results", "当前信息类型没有匹配记录，可调整关键词或切换类型。"); cell.colSpan = 2; row.append(cell); rowHolder.append(row); }
      caption.replaceChildren(el("span", "", `当前：${scopeNames[state.filter] || "制造与检验"}，显示 ${filtered.length} / ${scopedCount} 条记录`), el("span", "", "两列呈现 · 展开查看依据与条件"));
      tabs.querySelectorAll("button").forEach(button => { const chosen = button.dataset.filter === state.filter; button.classList.toggle("active", chosen); button.setAttribute("aria-pressed", str(chosen)); });
      $("export-csv").textContent = "导出当前筛选 CSV";
    };
    for (const [value, label] of [["core", "制造与检验"], ["manufacturing", "制造约束"], ["quality", "质量与检验"], ["review", "核心待确认"], ["procurement", "采购交付"], ["context", "背景说明"], ["all", "全部记录"]]) { const button = el("button", "filter-tab", label); button.type = "button"; button.dataset.filter = value; button.append(el("span", "", counts[value])); button.addEventListener("click", () => { state.filter = value; render(); }); tabs.append(button); }
    search.addEventListener("input", () => { state.search = search.value; render(); }); toolbar.append(tabs, search);
    holder.append(el("p", "information-note", "默认查看直接制造约束和质量、检验要求。性能、缺陷、公差等属于验收目标，不等同于加工操作步骤；采购交付与背景可单独查看。"));
    if (pending.length) holder.append(pendingPanel.node);
    holder.append(toolbar, caption, tableWrap, el("p", "result-footnote", "本页用于核对资料中的制造约束与检验目标，不生成已批准的操作规程或完整工艺路线。请结合原图确认适用条件和疑点；本结果不直接判定产品合格。")); render();
  }
  function renderBatch(force = false) {
    renderSavedDrawings();
    const batch = state.batch; $("batch-content").hidden = !batch; $("empty-state").hidden = Boolean(batch); if (!batch) { updateControls(); return; }
    const drawings = list(batch.drawings); if (!drawings.some(item => item.id === state.drawingId)) state.drawingId = drawings.find(item => item.result)?.id || drawings[0]?.id || null;
    const bar = $("batch-status"); bar.replaceChildren(badge(batch.status)); if (active(batch.status)) bar.append(el("span", "spinner")); const completed = drawings.filter(item => item.status === "completed").length, failed = drawings.filter(item => item.status === "failed").length; bar.append(el("span", "", `${batch.error || batch.message || statusNames[batch.status]} · ${completed} / ${drawings.length} 个零件完成${failed ? `，${failed} 个未完成` : ""}`));
    const nav = $("drawing-list"); nav.replaceChildren(); drawings.forEach((drawing, index) => { const button = el("button", `drawing-item ${drawing.id === state.drawingId ? "selected" : ""}`); button.type = "button"; button.setAttribute("aria-pressed", str(drawing.id === state.drawingId)); button.append(el("strong", "", drawing.result?.drawing?.name || drawing.name || `零件 ${index + 1}`), el("small", "", drawing.result?.drawing?.partNumber || drawing.name || ""), badge(drawing.status)); button.addEventListener("click", () => { state.drawingId = drawing.id; state.filter = "core"; state.search = ""; state.resultKey = ""; renderBatch(true); updateUrl(); }); nav.append(button); });
    const drawing = selectedDrawing(), key = drawing ? `${drawing.id}:${drawing.status}:${drawing.result ? "result" : ""}:${drawing.message || ""}:${drawing.error || ""}` : "empty";
    if (force || key !== state.resultKey) { state.resultKey = key; renderDrawing(drawing); } updateControls(); updateUrl();
  }
  async function loadBatch(id, force = false) {
    const specId = state.specId;
    const batch = await api(`/api/drawing-batches/${enc(id)}`); if (state.batchId !== id || state.specId !== specId || batch.specificationId !== specId) return; state.batch = batch; renderBatch(force); schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(state.pollTimer); if (state.specifications.some(spec => active(spec.status)) || active(state.specJob?.status) || active(state.batch?.status) || state.savedBatches.some(batch => active(batch.status))) state.pollTimer = setTimeout(poll, state.pollErrors ? 5000 : 2000);
  }
  async function poll() {
    if (state.pollRunning) return; state.pollRunning = true;
    try {
      const tasks = [];
      if (state.specifications.some(spec => active(spec.status)) || active(state.specJob?.status)) tasks.push(refreshSpecs());
      if (active(state.specJob?.status)) { const id = state.specId; tasks.push(fetchSpecJob(id).then(job => {
        if (state.specId !== id) return;
        const previous = state.specJob;
        state.specJob = job; updateSpecSummary(job);
        if (job.status !== previous.status || Boolean(job.result) !== Boolean(previous.result)) renderSpec(job);
        else if (job.message !== previous.message || job.error !== previous.error) {
          const current = $("spec-progress-status");
          if (current) { const progress = statusBox(job); progress.id = "spec-progress-status"; current.replaceWith(progress); }
        }
      })); }
      if (active(state.batch?.status)) tasks.push(loadBatch(state.batchId));
      if (state.savedBatches.some(batch => active(batch.status))) tasks.push(refreshSavedDrawings(state.specId));
      const outcomes = await Promise.allSettled(tasks), failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure) throw failure.reason; state.pollErrors = 0;
    } catch (error) { state.pollErrors++; if (state.pollErrors === 3) showAlert(`${error.message} 页面将继续尝试读取状态，请勿重复提交相同任务。`); }
    finally { state.pollRunning = false; updateControls(); schedulePoll(); }
  }
  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_"); a.hidden = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv() {
    const result = currentResult(); if (!result) return;
    const quote = value => { let text = str(value); if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text; return `"${text.replace(/"/g, '""')}"`; };
    const rows = [["工艺要求的名称", "量化指标"], ...filteredRequirements(result).map(item => [item.category, item.requirement])];
    download("\ufeff" + rows.map(row => row.map(quote).join(",")).join("\r\n"), `${result.drawing?.partNumber || "零件"}-${scopeNames[state.filter] || "当前筛选"}.csv`, "text/csv;charset=utf-8");
  }

  $("spec-file").addEventListener("change", updateControls);
  $("spec-form").addEventListener("submit", async event => {
    event.preventDefault(); if (state.specSubmitting || !state.configured) return; const file = $("spec-file").files[0]; if (!file || !/\.pdf$/i.test(file.name) || !file.size) { showAlert("请选择非空的 PDF 技术规范。"); return; }
    clearAlert(); state.specSubmitting = true; updateControls();
    try { const form = new FormData(); form.append("file", file); if ($("spec-label").value.trim()) form.append("label", $("spec-label").value.trim()); const data = await api("/api/specifications", { method: "POST", body: form }); $("spec-file").value = ""; $("spec-label").value = ""; await refreshSpecs(); await selectSpec(data.id); }
    catch (error) { showAlert(error.message); } finally { state.specSubmitting = false; updateControls(); }
  });
  $("spec-select").addEventListener("change", () => { updateControls(); if ($("spec-select").value && $("spec-select").value !== state.specId) selectSpec($("spec-select").value).catch(error => showAlert(error.message)); });
  $("drawing-files").addEventListener("change", event => { addFiles(Array.from(event.target.files)); event.target.value = ""; });
  $("clear-files").addEventListener("click", () => { state.files = []; renderFiles(); });
  const dropzone = $("dropzone"); dropzone.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key) && !$("drawing-files").disabled) { event.preventDefault(); $("drawing-files").click(); } });
  for (const type of ["dragenter", "dragover"]) dropzone.addEventListener(type, event => { event.preventDefault(); if (!$("drawing-files").disabled) dropzone.classList.add("dragover"); });
  for (const type of ["dragleave", "drop"]) dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove("dragover"); if (type === "drop") addFiles(Array.from(event.dataTransfer.files)); });
  $("drawing-form").addEventListener("submit", async event => {
    event.preventDefault(); if ($("start-drawings").disabled) return; state.drawingSubmitting = true; clearAlert(); updateControls();
    try { const specId = $("spec-select").value, stage = $("production-stage").value, form = new FormData(); form.append("specificationId", specId); form.append("stage", stage); state.files.forEach(file => form.append("files", file)); const data = await api("/api/drawing-batches", { method: "POST", body: form }); state.files = []; renderFiles(); if (state.specId !== specId) return; state.batchId = data.id; state.batch = { id: data.id, status: "queued", message: "任务已创建，正在读取状态", specificationId: specId, stage, drawings: [] }; state.drawingId = null; state.resultKey = ""; state.filter = "core"; state.search = ""; renderBatch(true); await loadBatch(data.id, true); await refreshSavedDrawings(specId); $("new-drawings").open = false; $("results-heading").scrollIntoView({ behavior: "smooth", block: "start" }); }
    catch (error) { showAlert(error.message); } finally { state.drawingSubmitting = false; updateControls(); schedulePoll(); }
  });
  $("refresh-health").addEventListener("click", () => { health(); schedulePoll(); });
  $("refresh-drawings").addEventListener("click", () => refreshSavedDrawings(state.specId, { open: !state.batch }).catch(error => showAlert(error.message)));
  $("refresh-specs").addEventListener("click", async () => { try { await refreshSpecs(); if (state.specId) await selectSpec(state.specId); } catch (error) { showAlert(error.message); } });
  $("dismiss-alert").addEventListener("click", clearAlert); $("export-csv").addEventListener("click", exportCsv);
  $("export-json").addEventListener("click", () => { const result = currentResult(); if (result) download(JSON.stringify({ ...result, exportScope: { kind: "all_records", note: "完整资料，含采购交付、背景及待分类记录；以informationType区分，不全部视为工艺要求。" } }, null, 2), `${result.drawing?.partNumber || "零件"}-完整资料.json`, "application/json;charset=utf-8"); });
  const dialog = $("guide-dialog"); $("guide-button").addEventListener("click", () => dialog.showModal()); $("close-guide").addEventListener("click", () => dialog.close()); $("guide-done").addEventListener("click", () => dialog.close()); dialog.addEventListener("click", event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  window.addEventListener("beforeunload", () => clearTimeout(state.pollTimer));
  async function initialize() {
    const params = new URLSearchParams(location.search); state.specId = params.get("spec"); state.batchId = params.get("batch"); state.drawingId = params.get("drawing");
    if (params.has("job")) showAlert("当前页面已升级为两阶段工作台。历史任务仍保留在后端，可通过原任务 API 读取；请选择规范库后创建逐零件任务。");
    await health();
    try { await refreshSpecs(); if (!state.specId && state.batchId) { const batch = await api(`/api/drawing-batches/${enc(state.batchId)}`); state.specId = batch.specificationId; state.batch = batch; } if (!state.specId) state.specId = state.specifications.find(spec => spec.status === "completed")?.id || state.specifications[0]?.id || null; if (state.specId) await selectSpec(state.specId); else { renderSavedDrawings(); $("new-drawings").open = true; } }
    catch (error) { showAlert(error.message); $("spec-list").replaceChildren(el("p", "placeholder", "规范库读取失败，请检查服务后刷新。")); }
    updateControls(); schedulePoll();
  }
  initialize();
})();
