# 鸿禾 · 技术规范与图纸工艺要求工作台

两阶段流程：**解析技术规范 → 选择对应规范并输入图纸 → 输出“图纸要求＋规范检验要求”的逐件工艺列表**。同一规范可关联多张图纸，每个零件独立处理和导出。主表为“工艺要求的名称、量化指标、阶段”三列；阶段沿用现有工艺分类：铸造、机加、热处理、表面处理、刻字、检验、焊接、其他，材料牌号归其他。

所有大模型调用由真实 Pi CLI `-p --mode json` 执行，固定使用 DeepSeek 4.1 Flash（API ID `deepseek-flash`）。2026-10-28官方文档映射为 `DeepSeek-V4.1-Flash-1017`；供应商别名可能升级，不是不可变版本锁。没有Pro入口、其他大模型回退或运行时GPT调用。Poppler读取PDF文字层与图像；本地RapidOCR专用识读模型提供候选文字和位置，不负责工艺判断，也不能替代原图。

## 本地启动

需要Node.js 24 LTS（最低22.19）、pnpm 11.25及Poppler的pdftotext、pdftoppm、pdfinfo，以及Python 3.11+和requirements-pdf.txt中的表格/OCR依赖。Windows可在.env填写三个工具的绝对路径；Linux安装poppler-utils。基础PDF脚本仍兼容Python 3.10，完整OCR流程所锁定的ONNX Runtime需要3.11+。

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

1. 技术规范库只用于导入技术规范；每份PDF在“已有规范”中显示一条。同文件的重复解析、调试和失败尝试保存在内部，不能按尝试次数累计为多份规范；不同文件内容仍分别保留。
2. 新规范区分用于逐件补充的检验要求（inspection）和仅用于冲突对照的非检验技术条款（comparison）。同一文件与解析版本已存在时复用正在处理或已完成的规范库；对照条款不会自动进入最终工艺列表。
3. 到“图纸要求提取”选择对应的技术规范，直接查看“已处理图纸与结果”。已有结果无需重新上传或重新提取；只有新增图纸时才展开上传区。每份规范默认提供最新成功解析结果；打开历史结果时保留原解析ID，同一规范的再次解析不改变已有图纸批次的绑定。每批新增最多20个PDF，每个默认25MB。
4. 在已有图纸中点“查看结果”，按八类、待复核或冲突/覆盖筛选；展开证据打开规范或图纸物理页。真实冲突红色突出，图纸覆盖黄色说明，并列保留图纸执行值、规范规定及原因。查看和切换已有结果只读取保存的数据，不调用模型。
5. CSV导出当前筛选与关键词范围的“工艺要求的名称”“量化指标”“阶段”三列；JSON导出完整资料，含分类、身份、要求、规则处置、原文依据和运行记录。

`?spec=ID&batch=ID&drawing=ID`支持恢复指定结果。默认保留所有生产阶段的条件；也可指定样件、试生产、批产。没有输入的属性应保留待确认，不推定材料形态、厚度、类别或生产阶段。

规范可以多页，每个PDF最多100个物理页；初提每批最多12张图片、8个物理页，查漏每批最多2页。正文文字与格线结构合计最多180万字节，超出明确要求拆分。表格候选页在查漏时补充5200像素2×2重叠局部。逐图阶段单件最多12张证据图：单物理页为整图＋3×3重叠局部＋1张左下完整身份链聚焦图，共11张；两物理页仍每页整图＋2×2重叠局部＋聚焦图，共12张。超过上限明确失败，不静默丢页。策略只按物理页数选择，不依赖文件名或待识读答案。整图长边2600像素，局部图从5200像素直接重叠渲染；单页网格每片长边约1900像素，减少大图缩小造成的小字损失，不增加原始像素密度。聚焦图截取页面x=0—9%、y=70%—100%的连续值格与标签格，从最长边不超过7800像素的页面直接渲染；竖页按比例降低渲染尺度，确保聚焦图长边不超过2000像素。所有局部与聚焦图只提供原件像素，不预填字段答案；其他字段仍从整图及局部图识读，须核实标签与值的格线关系。

已锁定的Pi 1.4.0默认将图片缩至最多2000×2000像素；单页约1900像素切片可避免该次再次缩小。[DeepSeek视觉接口](https://api-docs.deepseek.com/zh-cn/guides/vision/)还会在模型处理前按面积缩放图像，不能把本地切片像素数当作模型实际看到的分辨率。版框聚焦是固定位置的辅助裁切，并不保证所有版式都正好覆盖同一字段及标签；字段归属仍须结合完整局部与整图核实。

模型任务共享最多2个并发执行槽，队列容量40。每个Pi调用默认超时10分钟，可用PI_TIMEOUT_MS调整。一个零件失败不影响其他零件继续，整批会明确显示部分失败。服务重启前未完成任务会标失败，重新提交可复用已经完成的规范版本。

## 两个Skill与中间契约

- `skills/specification-rule-parser/SKILL.md`：解析规范正文、表格与脚注。检验项目、方法、取样、频次、验收限值和复验判定标inspection；其他技术条款标comparison仅供图纸对照。检验验收依据可能位于技术要求章，不能只按章节标题筛选。保留适用条件、语气、来源，逐页查漏。
- `skills/drawing-requirements-matcher/SKILL.md`：先独立识读图纸，再按明确条件匹配规范检验，最后原图复核。匹配只能新增规范检验或绑定冲突依据，不能重写图纸原文/参数；普通成品尺寸不进入原材料选档输入。comparison不自动补出制造清单。仍按八类输出，不设计工序或编造参数。

规范解析先用pdfplumber读取向量格线及单元格矩形，按真实矩形覆盖展开合并值；空格不按邻格填充。结构候选与原图共同交给Flash，扫描表格仍依赖视觉识读；不可见/裁字不能因文字层存在而当确定要求。原结构保存在table-structure.json。

规则包保存metadata、rules、warnings及来源覆盖/运行记录。三列复用现有字段：category为“工艺要求的名称”，requirement为“量化指标”，processCategory为“阶段”。指标可包含数值、比较符、单位、牌号、状态、禁止项及待确认条件。不新增stage或重复的name/value字段；上传时的生产阶段筛选job.stage与工艺分类列含义不同。来源、适用条件、例外与规则关联继续保留。

每个Skill只保留一个入口和一份按模式分节的 `references/protocol.md`。规范按extract/audit加载，图纸按read/match/audit分别加载，旧记录归类才加载classify；未使用模式不进入提示。每次与入口组成不可变快照，Pi继续使用--no-tools。网页操作仍是导入规范、关联图纸两步；内部调用次数不新增用户工作区或Skill。结构验证在 `server/two-stage-schema.js`。

图纸read只接收本图原文、图片和独立OCR候选；match不带图或完整规范原文，只接收紧凑规则包、明确原料事实和工艺条件。代码保留已识读的D行，匹配仅追加规范检验及来源/冲突关联。audit重新看原图和完整依据，检查合并结果。条件变化时最多重新匹配一次；无法安全重基或第二次仍变化时，保留来源合法的清单，对受影响要求及旧、新规范关联逐项标待复核，不再整张隐藏。匹配或审计失败但已有合法内容时显示部分提取，明确缺少步骤；没有合法读图结果才整件失败。非法来源、越界页或未知规则仍不进入清单。原始输入、输出及哈希保留，不为过校验恢复旧事实或猜拆技术正文。显式重试仍从原图开始，在新的attempt目录执行。

已有合法read/matched/audited可通过同一retainDrawingCandidate重新整理，并记录run.processingMode=reprocess_existing、modelInvoked=false及原artifact哈希；这不表示模型重新识读，也不等同于使用更新后Skill重跑。原模型Skill版本和记录应保留，旧文件不覆盖。review.pendingRuleIds中的原“不适用”也要重新确认，不能计入已确认覆盖数。程序提取完成不代表人工验收。

OCR JSON和紧凑文字与PDF原文字层分开保存，保留四个旋转方向、置信度和定位框；不同读数不会按最高分择值。像素框不是工艺尺寸，OCR引文也不自动成为text_match。它由[RapidOCR](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/)在本地执行，候选仍须由Flash对照原图；识读明确时不因使用图像或OCR而自动标复核。

新结果带scopePolicy=drawing-plus-inspection-v1。processCategory是八类工艺，category仍是具体要求名称，不能把两者混用。informationType仅保留旧接口兼容，不再决定新主清单的范围；商业与纯资料管理不进入新工艺主表。

逐图传输使用固定来源代号S1/D1，后端精确恢复原文件名后验证；不按相似文件名猜测来源。用户选定的规范版本保持绑定，外部未注日期引用规则不会自动升级当前规范库。

发送模型前移除来源上的后端`verification`标记，保留原文件、页码、引文和全部技术字段，避免内部字段被照抄进严格输出而耗掉纠正机会。保存的原始模型结果及后端校验记录保留不变；模型额外输出该字段仍按原契约拒绝，不自动补齐缺失来源。

逐图结果每个inspection规则必须恰好一条处置。适用、图纸覆盖、待确认的检验规则必须关联要求；不适用规则不能进入有效清单。comparison无需强制处置或生成行，可在图纸对照中引用。图纸独有要求保留空ruleIds；纯规范最终行只能关联inspection。后端拒绝未知规则、重复/漏检验处置、越界页码及其他零件来源，不按文本相似度猜来源。

受检区域壁厚、原材料形态及公称尺寸缺失时保留具体选档前提，不把成品总高、台阶或沉孔直接当作依据。新口径guards只保留模型已有的对象和数值并追加真实条件，不会将其他材料的整表分支重新灌入最终行。耐压/爆破/水压与气密分别保留用途，图面标准号不凭常识改号。

每条可带conflict={kind,specificationRequirement,reason}，沿用sources和ruleIds保存双方依据。kind=conflict是需突出核对的矛盾或编号不一致；drawing_override是图纸专用规定覆盖规范通用/默认值，按图纸执行而不自动标复核。不同用途、阶段或条件不满足不当作冲突，仍须保留具体条件。

“待复核”只标记具体疑点：识读不清、标注对应不明、图文冲突、适用条件不足、证据无法定位且无图像、视觉覆盖缺失等。清晰整图或局部图的数值识读、缺少文字层，以及明确的条件性本身不触发标记；来源仍记录为visual_review供追溯。上游具体疑点传递到关联要求，说明文字本身不等于复核标记，也不表示已经人工签认。

这些结构检查能拦截特定错误，不能证明材料/区域识别、适用性判断或提取语义正确。规范解析中的疑点会传递到关联要求；一处规范误读可能影响多张图，需回到原文核对。外部标准仅见引用而未提供全文时，不宣称已经解析其细则。

## 旧结果兼容

以下四类仅用于读取旧结果，不能用它代替八类或把旧结果直接当作新口径重跑：

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

旧API的informationSummary与分类索引继续保留。新规范另外给inspectionCount/comparisonCount；新ruleCoverage仅统计inspection必需处置。修改Skill/范围需要重新解析对应规范和图纸，不能只给历史行贴八类标签后宣称已按新口径处理。

## 静态报告

```powershell
python scripts/export_static.py --state-file work/run-row-review-20261031/state.json --base-url http://127.0.0.1:3000 --output work/static-report/工艺要求-静态报告.html
```

state显式绑定规范ID和图纸批次；导出只读取已有结果，不调用模型。合法的待复核、部分提取清单正常展示；原始待复核标记和规范关联一并保留。无可展示结果时默认拒绝，显式添加`--allow-incomplete`可导出其状态和原因，不捞取任意原始候选或回退旧成功。单文件支持离线八类筛选、冲突对照、来源与三列CSV，不含密钥、提示词或原PDF。它是保存结果的快照，不能替代后端新解析。

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
      ocr_candidates.py     本地旋转OCR候选；不改PDF文字层
      requirements.txt      OCR依赖
~~~

两份完整Skill须并列安装；图纸脚本复用规范Skill中的通用引擎。复制两个目录即可离开网站运行，PDF/OCR脚本不依赖Node.js、server、node_modules或API密钥。基础PDF处理需Python 3.10+及Poppler；完整流程需Python 3.11+并安装两份scripts/requirements.txt。独立脚本只读取进程环境，不自动加载网站.env；可配置PDFINFO_PATH、PDFTOTEXT_PATH、PDFTOPPM_PATH，网站用PYTHON_PATH选择解释器。若OCR依赖单独安装，可用DRAWING_OCR_PYTHONPATH仅向OCR子进程提供包目录，不修改通用PDF或模型进程。网站与Pi CLI仍使用Node.js。

~~~text
python skills/specification-rule-parser/scripts/prepare_pdf.py --input "/data/规范.pdf" --output "/data/规范预处理" --audit-details
python skills/drawing-requirements-matcher/scripts/prepare_pdf.py --input "/data/零件.pdf" --output "/data/图纸预处理"
python skills/drawing-requirements-matcher/scripts/ocr_candidates.py --prepared "/data/图纸预处理/prepared.json" --output "/data/OCR候选/ocr-candidates.json"
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

规范查漏每批最多2个物理页、12张证据图。完整JSON未通过结构、来源或规则关联检查时，最多向同一模型纠正一次，原输出与调用记录保留。规范提取仍须通过全部检查；图纸后续匹配或复核未通过时，仅保留此前合法内容并明确标部分提取，不应用非法补丁。没有合法读图结果时才整件失败。网络错误或截断不会自动重试，不通过代码填补技术要求或改写指标。

## API

- `GET /api/specifications`：规范库列表。
- `POST /api/specifications`：multipart单文件file，可选label；返回id与cached。
- `GET /api/specifications/:id`：进度和完整规则库；`/file`返回原PDF。
- `POST /api/drawing-batches`：multipart字段specificationId、files、stage（all/sample/trial/batch）。
- `GET /api/drawing-batches?specificationId=ID`：发现该精确规范解析ID下的已有批次和图纸摘要；不包含文件路径、提示词或完整要求正文，不执行模型任务。
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

原图抽查差异可在warnings中以“【原图复核】”注明核对者、依据和影响，并对准确行号追加review_required/review_note；无对应行的缺项保留全局提示，不猜造新要求。原模型技术值及文件保持不变；三列CSV仍是当前筛选的机器要求，完整JSON保留复核依据。

网页页面覆盖与规则处置数只是输入及处理记录，不是正确率。小数检查是文字层遗漏提示，不能识别扫描图全部数值，也不能证明符号与对象对应正确。

## 数据边界

默认只监听本机，拒绝跨站POST和不允许的主机。原PDF、图像、规则与结果保存在runtime并被Git忽略；上传资料按用户操作发送至已配置DeepSeek接口。该应用需要操作系统子进程和Poppler，适合本机、虚拟机或Docker；多人对外部署需另配认证、HTTPS与访问权限。

官方依赖依据：[Pi仓库](https://github.com/earendil-works/pi)、[CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)、[DeepSeek模型映射](https://api-docs.deepseek.com/quick_start/pricing/)。
