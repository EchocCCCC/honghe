# 鸿禾 · 技术规范与图纸工艺要求工作台

两阶段流程：**技术规范 → 规范规则库；选定规范版本＋单个零件图纸 → 制造要求、检验要求、待确认项**。同一规范可关联多张图纸，每个零件独立处理和导出。

全部模型调用由真实 Pi CLI `-p --mode json` 执行，固定使用 DeepSeek 4.1 Flash（API ID `deepseek-flash`）。2026-10-28官方文档映射为 `DeepSeek-V4.1-Flash-1017`；供应商别名可能升级，不是不可变版本锁。没有Pro入口、其他模型回退或运行时GPT调用。PDF文字层和图像由Poppler读取。

## 本地启动

需要Node.js 24 LTS（最低22.19）、pnpm 11.25及Poppler的pdftotext、pdftoppm、pdfinfo，以及Python 3.10+和requirements-pdf.txt中的表格结构依赖。Windows可在.env填写三个工具的绝对路径；Linux安装poppler-utils。

```powershell
pnpm install --frozen-lockfile
python -m pip install -r requirements-pdf.txt
Copy-Item .env.example .env
# 编辑.env，填入自己的DEEPSEEK_API_KEY；不要覆盖已有有效配置
pnpm doctor
pnpm start
```

打开 http://127.0.0.1:3000 。本地交付目录已按会话授权配置.env（含Python工具路径）；压缩包和Git不含密钥。也可准备.env后执行 `docker compose up --build`，容器构建配置包含Poppler和独立Python表格环境，Compose端口默认仅对本机开放。

## 网页操作

1. 上传一份技术规范，建立规范库。每份规范保留文件哈希、解析Skill哈希、规范编号/版次及独立ID。
2. 默认查看制造约束与质量、检验要求；采购交付和背景说明可单独切换，展开查看条件、例外、覆盖关系、原文依据和分类理由。同一文件与解析版本已存在时复用正在处理或已完成的规范库。
3. 选择已经建立的规范版本，批量导入对应图纸。每批最多20个PDF，每个默认25MB。
4. 按零件切换，查看制造/检验/待确认项和全部规则的适用性处置表；展开证据打开对应规范或图纸物理页。
5. CSV导出当前筛选与关键词范围的“工艺要求的名称”“量化指标”两列；JSON导出完整资料，含分类、身份、要求、规则处置、原文依据和运行记录。

`?spec=ID&batch=ID&drawing=ID`支持恢复指定结果。默认保留所有生产阶段的条件；也可指定样件、试生产、批产。没有输入的属性应保留待确认，不推定材料形态、厚度、类别或生产阶段。

规范可以多页，每个PDF最多100个物理页；初提每批最多12张图片、8个物理页，查漏每批最多2页。正文文字与格线结构合计最多180万字节，超出明确要求拆分。表格候选页在查漏时补充5200像素重叠局部。逐图阶段当前单个零件PDF最多提交12张图像，通常为1—2个物理页（每页整图＋4张局部图＋1张较窄的左下边栏聚焦图）；超过上限明确失败并要求按单零件有效页拆分，绝不静默丢页。图纸局部图从长边5200像素重新渲染并重叠，整图长边2600像素，扫描版竖向图纸同样提供局部图。边栏聚焦图仅补充证据，不预先认定标签与数值的排列方向。

模型任务共享最多2个并发执行槽，队列容量40。每个Pi调用默认超时10分钟，可用PI_TIMEOUT_MS调整。一个零件失败不影响其他零件继续，整批会明确显示部分失败。服务重启前未完成任务会标失败，重新提交可复用已经完成的规范版本。

## 两个Skill与中间契约

- `skills/specification-rule-parser/SKILL.md`：完整解析规范正文、表格和脚注，保留强度、材料/区域/阶段/批次条件、例外、覆盖政策、外部依赖和证据；随后逐页独立查漏，允许有来源地补整条规则。
- `skills/drawing-requirements-matcher/SKILL.md`：识读单张图纸，以选定规则包逐条判断applicable、not_applicable、overridden、needs_confirmation；合并图纸直接要求并独立重读原图复核。复核只返回有证据的新增、替换、移除和处置补丁，后台合并后重新校验完整清单，避免重复生成长清单导致截断。输出制造、检验和待确认清单，不设计工序或编造参数。

规范解析先用pdfplumber读取向量格线及单元格矩形，按真实矩形覆盖展开合并值；空格不按邻格填充。结构候选与原图共同交给Flash，扫描表格仍依赖视觉识读；不可见/裁字不能因文字层存在而当确定要求。原结构保存在table-structure.json。

规则包保存metadata、rules、warnings及来源覆盖/运行记录。两列交付口径复用现有字段：category为具体的“工艺要求的名称”，requirement为“量化指标”；后者可包含数值、比较符、单位、牌号、状态、禁止项及明确的待确认条件。不增加重复的name/value字段。来源、适用条件、例外与规则关联仍保留在内部，用于核对。

每个Skill只保留一个入口和一份按模式分节的 `references/protocol.md`。后端按规范提取、图纸匹配、复核或旧记录归类选择所需协议章节，与入口组成不可变提示快照；未使用模式不进入本次提示。Pi继续使用--no-tools。输出结构验证在 `server/two-stage-schema.js`。本轮优化Skill及加载，网页仍使用现有详细结果视图。

informationType保留为旧接口兼容字段，其四个值是本项目的展示标记，不是行业工艺分类标准，也不是提取的业务目标。是否提取一条内容，取决于它是否提出有原文依据的制造或检验要求；无数值的禁限、牌号和状态不能漏掉。解释性背景用于理解，采购管理不混入工艺主清单。

逐图传输使用固定来源代号S1/D1，后端精确恢复原文件名后验证；不按相似文件名猜测来源。用户选定的规范版本保持绑定，外部未注日期引用规则不会自动升级当前规范库。

逐图结果每个非背景R编号必须恰好一条处置。背景定义、批次定义、文件优先关系和纯导航只供理解，不强制生成处置，也不能进入新模型的有效要求数组。适用、覆盖、待确认规则必须关联至少一个要求；不适用规则不能进入有效清单。图纸独有要求保留空ruleIds。后端拒绝未知规则、重复处置、漏处置、越界页码及其他零件来源。相同文字但条件、强度、参数不同的规则不会合并。

内部质量按受检区域局部壁厚分档时，此版不自动把总高、台阶高、槽尺寸等当壁厚。缺少人工确认的区域壁厚时，程序将相关复合条目拆回原规范条件和完整分档，处置为待确认；机器原选档候选保留，变更有记录。这是保守约束，不能视为已经确认了壁厚或某个验收档。原材料公称厚度/直径同样尚无人工确认入口，成品局部尺寸不能直接选力学性能档；保留原规范完整条件待确认。耐压/爆破/水压不自动替代气密试验压力。图面标准号缺少精确文字证据时只标候选，不猜测改号；模型引文自身也可能误读，仍需按原图核对。

这些结构检查能拦截特定错误，不能证明材料/区域识别、适用性判断或提取语义正确。规范解析中的疑点会传递到关联要求；一处规范误读可能影响多张图，需回到原文核对。外部标准仅见引用而未提供全文时，不宣称已经解析其细则。

## 信息范围与计数

四类信息与原有技术类别分别记录：

|informationType|用途|默认主清单|
|---|---|---|
|manufacturing|材料选择、成形/热处理操作、修补限制、生产资质和过程控制|显示|
|quality|化学/力学指标、尺寸/缺陷验收、检测方法、频次及复验|显示|
|procurement|报告和证书提交、追溯资料、包装交付、运输贮存|单独查看|
|context|适用范围、定义、批次定义、引用版本/优先关系、纯表格导航|单独查看，不计可执行数|

“直接制造约束”与“质量验收目标”分开统计，资料总记录数不叫工艺条数。“按某标准进行检测”仍是检验义务，不能因为含标准号归背景。新提取遇到多种义务应合理拆分；已有混合记录归类时保留制造/检验核心，并标注需拆分复核，不能隐藏其中的真实义务。热处理状态仅作为性能表适用条件时随指标归质量，直接要求工件采用某状态时归制造。

已有规则库和零件结果可增加独立分类索引，保留原始文本、数值、来源和冻结比较不变：

```text
node scripts/classify-existing.js --runtime /absolute/project/runtime
```

此命令通过真实Pi/Flash对已提取记录归类，并独立复核拟放入采购/背景的条目，会消耗API额度；这不是重新读取PDF或修复旧数值。索引位于 `runtime/information-profiles/`，严格绑定原始结果哈希、全部ID、模型和Skill快照。缺失或无效索引时，旧类别仅作临时展示并标待归类，未知条目保留在默认视图，不假定都属制造；旧库未完成归类时不能用于新匹配。每条分类可查看理由。

API增加 `informationSummary`：total为完整资料记录，core为制造＋质量，actionable为制造＋质量＋采购，context不计入后两者。旧JSON完整导出可能保留背景记录，并明确标记all_records；新模型的requirements仅允许manufacturing、quality、procurement。规范规则包继续保留背景供图纸匹配理解条件。

## Skill附带PDF脚本

两个Skill的预处理脚本全部使用Python，随Skill交付；网站后端启动同一套Python脚本，命令行也可单独运行：

~~~text
skills/
  specification-rule-parser/
    SKILL.md
    scripts/
      prepare_pdf.py        规范入口：文字、整图、表格结构
      pdf_core.py           通用文字与图像处理
      table_structure.py    按格线展开合并单元格
      process.py            外部工具执行
      cli.py                命令行参数及输出
      bridge.py             网站调用的JSON接口
      requirements.txt      Python表格依赖
  drawing-requirements-matcher/
    SKILL.md
    scripts/
      prepare_pdf.py        图纸入口：整图及5200像素局部
~~~

两份完整Skill须并列安装；图纸脚本复用规范Skill中的通用引擎。复制这两个目录即可离开网站运行，不依赖Node.js、server、node_modules、项目package.json或API密钥；需要Python 3.10+和Poppler，规范表格另外需要附带requirements.txt中的包。图纸预处理仅使用Python标准库。独立脚本只读取进程环境，不自动加载网站.env，可配置PDFINFO_PATH、PDFTOTEXT_PATH、PDFTOPPM_PATH；网站用PYTHON_PATH选择解释器。网站服务和Pi CLI仍使用Node.js。

~~~text
python skills/specification-rule-parser/scripts/prepare_pdf.py --input "/data/规范.pdf" --output "/data/规范预处理" --audit-details
python skills/drawing-requirements-matcher/scripts/prepare_pdf.py --input "/data/零件.pdf" --output "/data/图纸预处理"
~~~

输出目录必须为新目录或空目录。输出prepared.json、source.txt、coverage.json和图片；规范还输出table-structure.json。--audit-details补充表格候选/无文字页的高分辨率证据；网站在初提后、查漏前调用同一增强函数。输出是模型输入证据，不能视为已提取的制造要求。

执行分工为“后端或调用方执行Python Skill脚本 → Pi加载Skill和预处理证据 → Flash提取与复核 → 后端校验并展示”。当前Pi使用--no-tools，加载Skill本身不会自动执行脚本。Skill规定识读、条件、分类和输出，脚本负责确定性的文件处理；语言迁移不重新调用模型或改写历史提取结果。

## Pi执行与记录

`server/pi.js`以参数数组、关闭shell执行锁定版本 `@earendil-works/pi-coding-agent@1.4.0`。两阶段都使用：

```text
pi -p --mode json --provider deepseek-extract --model deepseek-flash
  --thinking high --no-session --no-extensions --no-mcp --no-skills
  --no-prompt-templates --no-context-files --no-approve --no-tools
  --skill /absolute/selected-skill --system-prompt /absolute/run/skill-used.md
  @/absolute/run/input.txt @/absolute/run/page.png "任务模式与JSON契约……"
```

系统提示使用Skill快照，客户资料只作为待分析数据。Pi无命令/文件/MCP工具；stdin立即关闭，stdout严格按UTF-8及LF解析JSONL，并检查正常结束及完整JSON。每次保存Skill哈希、调用模型、用量及附件数。自定义供应商未配置计价，Pi用量中的cost=0不代表没有API费用，实际费用以供应商账单为准。apiKey只通过子进程环境传入，生成配置使用环境变量引用。

规范文件在 `runtime/specifications/ID/`；图纸批次在 `runtime/drawing-batches/ID/零件ID/`。规范受理时将SKILL.md与references/protocol.md一起冻结为parser-bundle.json；规则库按原PDF哈希＋这两文件的联合哈希＋PIPELINE_VERSION复用。初提与复核分别编译，运行记录保留各自的提示哈希、完整资料包哈希及实际加载章节；不能把两个阶段不同的提示哈希当成缓存错误。修改影响解析的代码时仍须更新管线版本。已完成规范版本不被后续任务覆盖，换规范必须选择新版本重跑图纸。

规范查漏每批最多2个物理页、12张证据图，减少密集表格一次输出过长的问题。规范初提、规范查漏及图纸最终复核返回完整JSON但未通过结构、来源或规则关联检查时，将原资料、失败JSON和诊断交回同一模型，最多纠正一次；失败输出与两次调用记录均保留。纠正后仍须通过全部检查，不通过则该任务失败。网络错误或截断输出不会自动重试，也不通过代码填补要求或改写指标；格式无效的原始输出另行留档。

## API

- `GET /api/specifications`：规范库列表。
- `POST /api/specifications`：multipart单文件file，可选label；返回id与cached。
- `GET /api/specifications/:id`：进度和完整规则库；`/file`返回原PDF。
- `POST /api/drawing-batches`：multipart字段specificationId、files、stage（all/sample/trial/batch）。
- `GET /api/drawing-batches/:id`：批次进度、各零件独立结果。
- `GET /api/drawing-batches/:id/drawings/:drawingId`：单零件结果；`/file`返回该图纸PDF。
- `POST /api/drawing-batches/:id/drawings/:drawingId/retry`：只重新核对该零件。正常结束的完整初次JSON可复用，截断初次输出不复用；原结果和失败运行均保留。

项目仅保留规范解析、图纸匹配两个Skill。旧综合提取Skill、旧执行管线和评估入口已删除；旧 /api/jobs 接口返回410退役提示。现有两阶段流程固定执行规范查漏和逐图复核，已保存的历史资料不删除。

## 验证与评估

```text
pnpm test
node scripts/evaluate-two-stage.js --manifest /absolute/private/manifest.json --output /absolute/private/results --stage specs
node scripts/evaluate-two-stage.js --manifest /absolute/private/manifest.json --output /absolute/private/results --stage representatives
node scripts/evaluate-two-stage.js --manifest /absolute/private/manifest.json --output /absolute/private/results --stage remaining
```

manifest为JSON数组，每项包含series（组标识）、kind（spec或drawing）、source（PDF绝对路径）。代表图为每组第一张，余下图纸可作为未参与调试的验证样本。评估脚本通过工作台HTTP API调用实际Pi任务，会消耗DeepSeek额度；参考答案不会进入模型提示。

私有 `evaluation/two-stage-20261028/` 保存原图独立核对的有限事实集、冻结哈希、实际结果和比较记录。历史gold与comparison只保留为迭代记录，其中已有参考勘误，不能当绝对真值。公开Git只存通用代码、两个Skill和评估工具，不上传客户资料、详细事实清单、原图截图或运行结果。

原图抽查中确认的差异可在现有warnings中以“【原图复核】”注明核对者、依据和影响，网页会在零件资料上方直接显示。此类离线复核提示与模型输出分开留档，不静默改写机器字段；两列CSV仍是当前筛选的机器要求，完整JSON另保留复核提示。

网页页面覆盖与规则处置数只是输入及处理记录，不是正确率。小数检查是文字层遗漏提示，不能识别扫描图全部数值，也不能证明符号与对象对应正确。

## 数据边界

默认只监听本机，拒绝跨站POST和不允许的主机。原PDF、图像、规则与结果保存在runtime并被Git忽略；上传资料按用户操作发送至已配置DeepSeek接口。该应用需要操作系统子进程和Poppler，适合本机、虚拟机或Docker；多人对外部署需另配认证、HTTPS与访问权限。

官方依赖依据：[Pi仓库](https://github.com/earendil-works/pi)、[CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)、[DeepSeek模型映射](https://api-docs.deepseek.com/quick_start/pricing/)。
