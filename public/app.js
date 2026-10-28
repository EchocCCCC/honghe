"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { files: [], busy: false, configured: false, jobId: null, result: null, filter: "all", startedAt: 0, timer: null, pollTimer: null, pollErrors: 0 };
  const stages = ["queued", "extracting", "running", "validating"];
  const modelNames = { "deepseek-flash": "DeepSeek Flash", "deepseek-v4-pro": "DeepSeek V4 Pro" };

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }
  function string(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  function alert(message) {
    $("alert-text").textContent = message;
    $("global-alert").hidden = false;
  }
  function clearAlert() { $("global-alert").hidden = true; }
  function readableSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  function updateStart() {
    $("start-button").disabled = state.busy || !state.configured || state.files.length === 0;
    $("model-select").disabled = state.busy;
    $("file-input").disabled = state.busy;
    $("dropzone").classList.toggle("disabled", state.busy);
    $("clear-files").hidden = state.files.length === 0 || state.busy;
    $("start-label").textContent = state.busy ? "正在提取…" : "开始提取";
    $("start-hint").textContent = state.busy ? "复杂资料可能需要几分钟" : !state.configured ? "等待后端服务与模型配置就绪" : state.files.length ? `已准备 ${state.files.length} 份资料` : "添加文件后即可开始";
    document.querySelectorAll(".file-remove").forEach((button) => { button.disabled = state.busy; });
  }

  async function fetchJson(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const contentType = response.headers.get("content-type") || "";
      let data;
      if (contentType.includes("application/json")) data = await response.json();
      else throw new Error(`服务返回了无法识别的响应（HTTP ${response.status}）。请检查后端是否正常启动。`);
      if (!response.ok) throw new Error(string(data.error || data.message, `请求失败（HTTP ${response.status}）`));
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("服务响应超时，请检查服务状态后重试。");
      if (error instanceof TypeError) throw new Error("无法连接到后端服务，请确认服务已启动。");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function checkHealth() {
    $("refresh-health").disabled = true;
    try {
      const data = await fetchJson("/api/health");
      state.configured = Boolean(data.ok && data.configured);
      $("connection-dot").className = `status-dot ${state.configured ? "connected" : "error"}`;
      $("connection-text").textContent = state.configured ? "服务已就绪" : data.ok ? "请配置模型 API 密钥" : "服务尚未就绪";
      $("connection-text").title = data.piVersion ? `Pi ${data.piVersion}` : "";
      if (Array.isArray(data.models) && data.models.length) {
        const selected = $("model-select").value;
        $("model-select").replaceChildren();
        for (const model of data.models) {
          const id = typeof model === "string" ? model : string(model.id || model.name);
          if (!id) continue;
          const option = element("option", "", modelNames[id] || id);
          option.value = id;
          $("model-select").append(option);
        }
        if ([...$("model-select").options].some((option) => option.value === selected)) $("model-select").value = selected;
        else if (data.model) $("model-select").value = data.model;
        updateModelHint();
      }
    } catch (error) {
      state.configured = false;
      $("connection-dot").className = "status-dot error";
      $("connection-text").textContent = "服务未连接";
      $("connection-text").title = error.message;
    } finally { $("refresh-health").disabled = false; updateStart(); }
  }

  function updateModelHint() {
    $("model-hint").textContent = $("model-select").value.includes("pro") ? "当前仅分析文字；图纸和扫描区域需人工复核。" : "支持文字与图像，推荐用于图纸和扫描件。";
  }

  function renderFiles() {
    $("file-list").replaceChildren();
    state.files.forEach((file, index) => {
      const row = element("li", "file-item");
      row.append(element("span", "file-icon", "PDF"));
      const info = element("div", "file-info");
      const name = element("span", "file-name", file.name);
      name.title = file.name;
      info.append(name, element("span", "file-size", readableSize(file.size)));
      const remove = element("button", "icon-button file-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${file.name}`);
      remove.addEventListener("click", () => { if (!state.busy) { state.files.splice(index, 1); renderFiles(); } });
      row.append(info, remove);
      $("file-list").append(row);
    });
    $("file-list").hidden = !state.files.length;
    updateStart();
  }

  function addFiles(files) {
    if (state.busy) return;
    clearAlert();
    const rejected = [];
    const additions = [];
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { rejected.push(`${file.name}：仅支持 PDF 文件`); continue; }
      if (file.size === 0) { rejected.push(`${file.name}：文件内容为空`); continue; }
      if (state.files.some((item) => item.name === file.name && item.size === file.size) || additions.some((item) => item.name === file.name && item.size === file.size)) continue;
      if (state.files.length + additions.length >= 10) { rejected.push("每次最多上传 10 份资料"); break; }
      additions.push(file);
    }
    state.files.push(...additions);
    renderFiles();
    if (rejected.length) alert(rejected.join("；"));
  }

  function elapsed() {
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    $("elapsed-time").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function updateProgress(job) {
    const isComplete = job.status === "completed";
    const isFailed = job.status === "failed";
    let current = stages.indexOf(job.status);
    if (isComplete) current = stages.length;
    if (current === -1) current = 0;
    $("progress-title").textContent = isComplete ? "提取已完成" : isFailed ? "提取未完成" : "正在处理资料";
    $("working-indicator").className = `working-indicator${isComplete ? " finished" : isFailed ? " failed" : ""}`;
    $("progress-message").textContent = string(job.message, isComplete ? "结果已生成，请结合原文逐条复核。" : isFailed ? "请检查提示后重试。" : "任务执行中，请稍候…");
    document.querySelectorAll(".progress-steps li").forEach((step, index) => {
      step.classList.toggle("done", index < current);
      step.classList.toggle("current", index === current && !isFailed);
      step.querySelector("span").textContent = index < current ? "✓" : String(index + 1);
      if (index === current && !isFailed) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
    });
  }
  function finishJob() {
    state.busy = false;
    clearInterval(state.timer);
    clearTimeout(state.pollTimer);
    elapsed();
    updateStart();
  }

  async function pollJob() {
    if (!state.jobId || !state.busy) return;
    try {
      const job = await fetchJson(`/api/jobs/${encodeURIComponent(state.jobId)}`);
      state.pollErrors = 0;
      updateProgress(job);
      if (job.status === "completed") {
        finishJob();
        if (!job.result || !Array.isArray(job.result.requirements)) {
          alert("任务已结束，但返回的结果格式不完整。请检查后端日志后重试。");
          return;
        }
        state.result = job.result;
        renderResult();
        $("results-title").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (job.status === "failed") {
        finishJob();
        alert(string(job.error || job.message, "提取失败，请查看后端日志并重试。"));
        return;
      }
    } catch (error) {
      state.pollErrors += 1;
      $("progress-message").textContent = `暂时无法获取任务状态，正在自动重连（${state.pollErrors}）… ${error.message}`;
      if (state.pollErrors >= 12) {
        finishJob();
        alert("与服务的连接已中断，后台任务可能仍在运行。恢复服务后刷新页面，可继续查看最近任务。");
        return;
      }
    }
    state.pollTimer = setTimeout(pollJob, Math.min(1600 + state.pollErrors * 1800, 10000));
  }

  async function startJob() {
    if (state.busy || !state.files.length || !state.configured) return;
    clearAlert();
    state.busy = true;
    state.result = null;
    state.jobId = null;
    state.startedAt = Date.now();
    state.pollErrors = 0;
    $("result-content").hidden = true;
    $("empty-state").hidden = false;
    $("export-actions").hidden = true;
    $("progress-section").hidden = false;
    updateStart();
    updateProgress({ status: "queued", message: "正在上传文件并创建提取任务…" });
    elapsed();
    clearInterval(state.timer);
    state.timer = setInterval(elapsed, 1000);
    const form = new FormData();
    state.files.forEach((file) => form.append("files", file));
    form.append("model", $("model-select").value);
    try {
      const job = await fetchJson("/api/jobs", { method: "POST", body: form }, 120000);
      if (!job.id) throw new Error("后端未返回任务编号，请检查服务日志。");
      state.jobId = String(job.id);
      try { localStorage.setItem("honghe-latest-job", state.jobId); } catch (_) { /* Storage may be unavailable. */ }
      updateJobUrl(state.jobId);
      await pollJob();
    } catch (error) {
      finishJob();
      updateProgress({ status: "failed", message: "未能创建任务，请检查服务与文件后重试。" });
      alert(error.message);
    }
  }

  function getRequirements() { return Array.isArray(state.result?.requirements) ? state.result.requirements : []; }
  function needsReview(item) { return item.review_required === true || item.review_required === "true" || Boolean(item.review_note); }
  function itemSources(item) { return Array.isArray(item.sources) ? item.sources : []; }
  function itemParameters(item) { return Array.isArray(item.parameters) ? item.parameters : []; }
  function renderSummary() {
    const requirements = getRequirements();
    const documents = Array.isArray(state.result.documents) ? state.result.documents : [];
    const pages = documents.reduce((sum, doc) => sum + (Number(doc.pages) || 0), 0);
    const stats = [
      [requirements.length, "条", "工艺要求"],
      [new Set(requirements.map((item) => string(item.category, "未分类"))).size, "类", "工艺分类"],
      [requirements.filter(needsReview).length, "条", "需要人工复核"],
      [documents.length || state.files.length, "份", pages ? `资料 · 共 ${pages} 页` : "来源资料"],
    ];
    $("result-summary").replaceChildren();
    for (const [value, unit, label] of stats) {
      const stat = element("div", "summary-stat");
      const number = element("strong", "", value);
      number.append(element("span", "", unit));
      stat.append(number, element("label", "", label));
      $("result-summary").append(stat);
    }
    $("all-count").textContent = String(requirements.length);
    $("review-count").textContent = String(requirements.filter(needsReview).length);
    $("results-caption").textContent = "提取完成 · 点击原文依据查看来源";
    $("quality-notice").textContent = string(state.result.summary);
    $("quality-notice").hidden = !state.result.summary;
  }

  function renderWarnings() {
    const warnings = Array.isArray(state.result.warnings) ? state.result.warnings : [];
    $("warnings-panel").hidden = !warnings.length;
    $("warnings-label").textContent = `${warnings.length} 项提取提示，建议核对`;
    $("warnings-list").replaceChildren();
    warnings.forEach((warning) => $("warnings-list").append(element("li", "", string(warning))));
    $("warnings-list").hidden = true;
    $("warnings-toggle").setAttribute("aria-expanded", "false");
  }

  function sourceDocumentIndex(file) {
    const docs = Array.isArray(state.result?.documents) ? state.result.documents : [];
    return docs.findIndex((doc) => string(doc.name) === file || string(doc.filename) === file);
  }

  function renderRequirement(item, index) {
    const card = element("article", "requirement-card");
    const top = element("div", "requirement-top");
    top.append(element("span", "requirement-number", string(item.id, `REQ-${String(index + 1).padStart(3, "0")}`)), element("span", "tag category-tag", string(item.category, "未分类")));
    if (needsReview(item)) top.append(element("span", "tag review-tag", "待复核"));
    if (item.scope) {
      const scope = element("span", "scope-label", `适用：${string(item.scope)}`);
      scope.title = string(item.scope);
      top.append(scope);
    }
    card.append(top, element("p", "requirement-text", string(item.requirement, "（要求内容为空，请核对结果）")));
    const parameters = itemParameters(item);
    if (parameters.length) {
      const list = element("ul", "parameter-list");
      parameters.forEach((parameter) => {
        const chip = element("li", "parameter-chip");
        chip.append(element("span", "parameter-name", string(parameter.name, "参数")), element("span", "parameter-value", `${string(parameter.value)}${parameter.unit ? ` ${string(parameter.unit)}` : ""}`));
        list.append(chip);
      });
      card.append(list);
    }
    if (item.review_note) {
      const note = element("p", "review-note");
      note.append(element("span", "", "!"), element("span", "", string(item.review_note)));
      card.append(note);
    }
    const sources = itemSources(item);
    const details = element("details", "evidence-details");
    const summary = element("summary", "", "原文依据");
    summary.append(element("span", "", `${sources.length} 处来源`));
    details.append(summary);
    if (!sources.length) details.append(element("div", "source-missing", "未提供可追溯的原文来源，请人工复核。"));
    else {
      const sourceList = element("div", "evidence-sources");
      sources.forEach((source) => {
        const sourceItem = element("div", "source-item");
        const header = element("div", "source-header");
        const file = string(source.file, "来源未标明");
        const documentIndex = sourceDocumentIndex(file);
        let sourceName;
        if (documentIndex >= 0 && state.jobId) {
          sourceName = element("a", "source-file link", file);
          const page = Number(source.page);
          sourceName.href = `/api/jobs/${encodeURIComponent(state.jobId)}/files/${documentIndex}${Number.isInteger(page) && page > 0 ? `#page=${page}` : ""}`;
          sourceName.target = "_blank";
          sourceName.rel = "noopener";
          sourceName.title = "在新窗口中查看原始 PDF";
        } else sourceName = element("span", "source-file", file);
        header.append(sourceName, element("span", "page-tag", source.page !== undefined && source.page !== null ? `第 ${string(source.page)} 页` : "页码待核对"));
        sourceItem.append(header, element("blockquote", "", string(source.quote, "（无原文摘录，请核对原始资料）")));
        if (source.section) sourceItem.append(element("div", "source-section", `条款：${string(source.section)}`));
        sourceList.append(sourceItem);
      });
      details.append(sourceList);
    }
    card.append(details);
    return card;
  }

  function renderList() {
    const requirements = getRequirements();
    const category = $("category-filter").value;
    const search = $("search-input").value.trim().toLocaleLowerCase();
    const visible = requirements.map((item, index) => ({ item, index })).filter(({ item }) => {
      if (state.filter === "review" && !needsReview(item)) return false;
      if (category && string(item.category, "未分类") !== category) return false;
      if (search) {
        const haystack = [item.requirement, item.category, item.scope, item.review_note, ...itemParameters(item).flatMap((p) => [p.name, p.value, p.unit]), ...itemSources(item).flatMap((s) => [s.file, s.quote, s.section])].map((value) => string(value)).join(" ").toLocaleLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    $("requirements-list").replaceChildren(...visible.map(({ item, index }) => renderRequirement(item, index)));
    $("visible-count").textContent = `显示 ${visible.length} / ${requirements.length} 条要求`;
    $("no-results").hidden = visible.length > 0;
    if (!requirements.length) {
      $("no-results").querySelector("strong").textContent = "资料中未提取到工艺要求";
      $("no-results").querySelector("p").textContent = "请核对原始资料与上方提取提示，必要时重新运行。";
      $("reset-filters").hidden = true;
    } else {
      $("no-results").querySelector("strong").textContent = "未找到匹配的要求";
      $("no-results").querySelector("p").textContent = "试试其他关键词，或调整筛选条件。";
      $("reset-filters").hidden = false;
    }
  }
  function setFilter(value) {
    state.filter = value;
    document.querySelectorAll(".filter-tab").forEach((button) => {
      const active = button.dataset.filter === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderList();
  }
  function resetFilters() { $("category-filter").value = ""; $("search-input").value = ""; setFilter("all"); }
  function renderResult() {
    $("empty-state").hidden = true;
    $("result-content").hidden = false;
    $("export-actions").hidden = false;
    renderSummary();
    renderWarnings();
    $("category-filter").replaceChildren();
    const all = element("option", "", "全部类别");
    all.value = "";
    $("category-filter").append(all);
    for (const category of [...new Set(getRequirements().map((item) => string(item.category, "未分类")))]) {
      const option = element("option", "", category);
      option.value = category;
      $("category-filter").append(option);
    }
    resetFilters();
  }

  function download(content, type, extension) {
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = `工艺要求提取-${stamp}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(value) {
    let text = string(value);
    // Prevent spreadsheet programs from interpreting source text as formulas.
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function exportCsv() {
    if (!state.result) return;
    const rows = [["编号", "工艺类别", "工艺要求", "关键参数", "适用范围", "待复核", "复核说明", "来源文件", "来源页码", "原文摘录", "条款"]];
    getRequirements().forEach((item, index) => {
      const sources = itemSources(item);
      rows.push([string(item.id, `REQ-${String(index + 1).padStart(3, "0")}`), item.category, item.requirement, itemParameters(item).map((p) => `${string(p.name)}：${string(p.value)}${p.unit ? ` ${string(p.unit)}` : ""}`).join("；"), item.scope, needsReview(item) ? "是" : "否", item.review_note, sources.map((s) => string(s.file)).join("\n"), sources.map((s) => string(s.page)).join("\n"), sources.map((s) => string(s.quote)).join("\n\n"), sources.map((s) => string(s.section)).join("\n")]);
    });
    download("\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8", "csv");
  }

  function updateJobUrl(id) {
    try {
      const url = new URL(location.href);
      url.searchParams.set("job", id);
      history.replaceState(null, "", url);
    } catch (_) { /* Job restoration remains available without URL updates. */ }
  }

  async function restoreLatestJob() {
    let id;
    const requestedId = new URLSearchParams(location.search).get("job");
    if (requestedId) id = requestedId;
    else { try { id = localStorage.getItem("honghe-latest-job"); } catch (_) { return; } }
    if (!id) return;
    try {
      const job = await fetchJson(`/api/jobs/${encodeURIComponent(id)}`);
      if (state.busy || state.files.length) return;
      state.jobId = id;
      updateJobUrl(id);
      if (job.status === "completed" && job.result && Array.isArray(job.result.requirements)) {
        state.result = job.result;
        renderResult();
      } else if (job.status === "failed" && requestedId) {
        $("progress-section").hidden = false;
        updateProgress(job);
        alert(string(job.error || job.message, "此任务提取失败，请检查资料后重新运行。"));
      } else if (stages.includes(job.status)) {
        state.busy = true;
        state.startedAt = Date.parse(job.createdAt) || Date.now();
        $("progress-section").hidden = false;
        updateProgress(job);
        updateStart();
        elapsed();
        state.timer = setInterval(elapsed, 1000);
        pollJob();
      }
    } catch (error) { if (requestedId) alert(`无法打开此提取任务：${error.message}`); }
  }

  $("file-input").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
  $("dropzone").addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !state.busy) { event.preventDefault(); $("file-input").click(); } });
  for (const eventName of ["dragenter", "dragover"]) $("dropzone").addEventListener(eventName, (event) => { event.preventDefault(); if (!state.busy) $("dropzone").classList.add("drag-over"); });
  for (const eventName of ["dragleave", "drop"]) $("dropzone").addEventListener(eventName, (event) => { event.preventDefault(); $("dropzone").classList.remove("drag-over"); });
  $("dropzone").addEventListener("drop", (event) => { if (event.dataTransfer?.files) addFiles(event.dataTransfer.files); });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
  $("clear-files").addEventListener("click", () => { if (!state.busy) { state.files = []; renderFiles(); clearAlert(); } });
  $("start-button").addEventListener("click", startJob);
  $("model-select").addEventListener("change", updateModelHint);
  $("refresh-health").addEventListener("click", checkHealth);
  $("dismiss-alert").addEventListener("click", clearAlert);
  $("category-filter").addEventListener("change", renderList);
  $("search-input").addEventListener("input", renderList);
  document.querySelectorAll(".filter-tab").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
  $("reset-filters").addEventListener("click", resetFilters);
  $("warnings-toggle").addEventListener("click", () => { const expanded = $("warnings-toggle").getAttribute("aria-expanded") === "true"; $("warnings-toggle").setAttribute("aria-expanded", String(!expanded)); $("warnings-list").hidden = expanded; });
  $("export-json").addEventListener("click", () => { if (state.result) download(JSON.stringify(state.result, null, 2), "application/json;charset=utf-8", "json"); });
  $("export-csv").addEventListener("click", exportCsv);
  $("guide-button").addEventListener("click", () => $("guide-dialog").showModal());
  $("close-guide").addEventListener("click", () => $("guide-dialog").close());
  $("guide-done").addEventListener("click", () => $("guide-dialog").close());
  $("guide-dialog").addEventListener("click", (event) => { if (event.target === $("guide-dialog")) { const rect = $("guide-dialog").getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $("guide-dialog").close(); } });
  window.addEventListener("beforeunload", (event) => { if (state.busy && !state.jobId) { event.preventDefault(); event.returnValue = ""; } });
  checkHealth();
  restoreLatestJob();
})();
