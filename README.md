# 鸿禾 · 工艺要求提取工作台

上传 PDF → 逐物理页提取文字并渲染图像 → 每批最多12张图分批 **启动真实 Pi CLI `-p --mode json`** → DeepSeek 4.1 Flash提取 → 对全部负责页逐页查漏及修正 → 校验结构和引文 → 网页筛选、定位原文与导出。

项目不把 API 直连伪装成 Pi，也不把预先整理的参考答案作为网页提取结果。`evaluation/gold.json` 仅用于离线评估，不进入运行提示。

所有模型阶段固定使用 **DeepSeek 4.1 Flash**。官方API标识为 `deepseek-flash`，2026-10-28文档对应 `DeepSeek-V4.1-Flash-1017`；没有Pro入口或其他模型回退。供应商API别名可能升级，它不是不可变版本锁。PDF解码/渲染仍由Poppler等确定性工具执行，运行时不调用GPT。

## 本地启动

需要 **Node.js 24 LTS（最低22.19）**、pnpm 11.25，以及 Poppler 的 `pdftotext`、`pdftoppm`、`pdfinfo`。Windows 可安装 Poppler 并把其 `Library/bin` 加入 PATH，或在 `.env` 配置三个可执行文件的绝对路径。Linux 可安装 `poppler-utils`。建议使用下方 Docker 方式避免本机依赖差异。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# 编辑 .env，填入自己的 DEEPSEEK_API_KEY
pnpm doctor
pnpm start
```

打开 http://127.0.0.1:3000 。当前交付目录的本地 `.env` 已按会话中的授权配置；不要用示例覆盖已有配置。密钥不会提交 Git，也不包含在交付压缩包中。

`pnpm doctor` 只检查本地依赖；`node scripts/doctor.js --api` 才访问模型列表。若系统中有多个 Node，必须使用满足最低版本的 Node 启动服务，Pi 子进程继承同一解释器。

## Docker

```text
docker compose up --build
```

先准备 `.env` 中的密钥。Compose 默认只把端口暴露给本机，上传资料和结果保存于命名卷。Docker 环境内已安装 Poppler，无需填写 Windows 可执行文件路径。

## 使用

1. 添加采购技术条件及对应工程图 PDF，每次最多10个，每个默认25MB、100页，合计最多200个物理页。
2. 点击“开始提取”，全部提取和核对固定使用 `deepseek-flash`（4.1 Flash）图文模式。
3. 完成后按分类、关键字、待复核筛选；展开证据查看文件、物理页码与原文，并可打开对应 PDF。
4. 导出 JSON 保留所有字段；CSV 用于清单复核。结果是要求提取，不是批准投产的工艺卡。

复杂资料需要几分钟。默认一个任务运行、最多五个排队，每次Pi调用超时为10分钟，可用 `PI_TIMEOUT_MS` 调整。失败任务明确返回错误，不用空表或示例结果表示成功。刷新浏览器可恢复最近一个任务，`?job=任务ID` 可直接打开任务，服务重启前未完成的任务需重新提交。

文字层不能证明页面没有图形内容，因此每个物理页都渲染，不再仅选横向页或有表标题的页。横向工程图额外提供四个局部放大图，末尾空白物理页也保留。图像按页打包分批，单次最多12张、8个物理页，整页与其局部图不会拆散；达到单批上限会新建批次，不丢弃后续页面。

第二阶段对每个批次的负责页逐条查漏，读取完整当前结果作为上下文：既可修正已有条目，也可用本批原文证据补回完全漏掉的独立要求。新增条目必须有真实文件/物理页来源，不能用外部标准或常识补工艺。语句相同但范围/材料状态/参数不同的要求不会被去重；仅完全等价的技术事实合并。新增条目和不确定标注仍需人工确认。

查漏阶段只处理负责页，不能推断其他页遗漏；自由文本提示不会自动覆盖第一次提取的全局warnings。该阶段同样通过 `pi -p` 调用Flash，会增加API用量；`PI_AUTO_REVIEW=0` 可关闭并明确显示复核未执行。失败任务不展示为完整成功。

网页“原文覆盖与复核范围”显示物理页、已提交图像页、失败页和提取/核对批次。覆盖数字证明已提交到模型，**不证明识读正确、语义完整或与GPT完全一致**。

程序另对横向图纸做独立小数检查：比较文字层的小数与同页要求/参数，排除原文引文和字母数字型号，提示疑似未覆盖值；不自动编造其工程含义。同一个值出现在别的特征里也可能造成假覆盖，所以这个检查只能提示复核。

## Skill 与后端调用

主文件：`skills/manufacturing-requirements-extractor/SKILL.md`。它包含输入资料边界、逐页/表格/工程图抽取、参数忠实性、图纸优先关系、外部引用缺失处理与 JSON 契约。

后端 `server/pi.js` 用参数数组运行锁定版本 `@earendil-works/pi-coding-agent@1.4.0`，效果等同：

```text
pi -p --mode json --provider deepseek-extract --model deepseek-flash
  --thinking high --no-session --no-extensions --no-mcp --no-skills
  --no-prompt-templates --no-context-files --no-approve --no-tools
  --skill /absolute/skills/manufacturing-requirements-extractor
  --system-prompt /absolute/skills/manufacturing-requirements-extractor/SKILL.md
  @/absolute/job/source.txt @/absolute/job/doc-1-page-1.png
  "提取所附全部资料的工艺要求……只输出契约 JSON。"
```

`--system-prompt` 确保完整 skill 确实进入模型上下文：Pi 会把 `@文件` 文本放在消息最前面，单靠消息末尾 `/skill:` 快捷命令可能不展开。后端同时关闭文档内容可利用的命令执行、文件读取、MCP及自动扩展。子进程的标准输入会立即关闭，以避免 print 模式等待输入。

每个任务的 `extraction/Bxx/pi-config` 和 `coverage-review/Bxx/pi-config` 都隔离配置；`apiKey` 使用 `$DEEPSEEK_API_KEY` 环境插值，源密钥只在服务端。每次调用留存skill快照/哈希、模型标识和用量。stdout按UTF-8＋LF严格解析JSONL，检查正常结束、完整JSON、字段结构及来源，不用正则修补缺失数据。

## 真集和真实评估

- `evaluation/gold.json`：历史148项GPT参考要求；参考集也可能有判读错误，不能当成未经核实的绝对真值。
- `evaluation/GOLD_NOTES.md`：复核范围、原文歧义和评分边界。该参考集尚未经铸造工程师签认。
- `evaluation/REPORT.md`：实际运行的版本、结果、问题和修正。
- `evaluation/skills/`：保留参与对比的 skill 版本；最终版本在 `skills/`。
- `evaluation/comparison-20261028/`：本轮GPT先独立读原始PDF、冻结事实，再对比旧栈和全Flash逐页输出；原图证据、参考纠错及逐项差异仅随本地包提供。

参考集、逐条审查和实际提取样例随本地完整交付包提供，原PDF由使用者保留；公开Git仓库只保存通用代码、skill及评估工具，不上传客户文件或其详细技术清单。

把原PDF分别复制到 `evaluation/fixtures/specification.pdf` 和 `drawing.pdf`，然后：

```text
pnpm evaluate --label local-run --model deepseek-flash
node scripts/score.js evaluation/runs/local-run/result.json
pnpm test
```

评估调用会产生 DeepSeek API 费用。`score.js` 只是页码与关键词候选定位器，输出 `UNREVIEWED` 核对表，不能把它当成事实准确率。完整语义判断须核对数值、前提、遗漏、矛盾和新增要求。两份资料是调优开发集，不构成未知图纸的泛化证明。

## 文件和部署边界

默认只监听本机；请求不跨域开放。API密钥、原PDF、任务目录和原始评估运行记录均被 `.gitignore` 排除。上传资料会发送给所选 DeepSeek 服务用于分析；本机原件、渲染图和结果保存在 `runtime/`，由使用者按需要清理。

本项目需要操作系统子进程及 Poppler，因此面向本机、虚拟机或 Docker 服务器。对外多人部署时请在反向代理中配置登录、HTTPS和访问权限，再将服务置于其后。

官方依赖依据：[Pi仓库](https://github.com/earendil-works/pi)、[Pi CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)、[DeepSeek模型映射](https://api-docs.deepseek.com/quick_start/pricing/)。
