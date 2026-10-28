# 鸿禾 · 工艺要求提取工作台

上传 PDF → 后端抽取分页文本/渲染图纸及局部放大 → **启动真实 Pi CLI `-p --mode json`** → 加载本项目 skill → 调用 DeepSeek → 独立核对图纸候选结果 → 校验结构和引文 → 网页筛选、定位原文与导出。

项目不把 API 直连伪装成 Pi，也不把预先整理的参考答案作为网页提取结果。`evaluation/gold.json` 仅用于离线评估，不进入运行提示。

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

1. 添加采购技术条件及对应工程图 PDF，每次最多10个，每个默认25MB、100页。
2. 选择模型并点击“开始提取”。默认 `deepseek-flash` 支持图文，适合工程图和扫描页。`deepseek-v4-pro` 在本实现中明确按纯文本模式运行，图纸和扫描内容会提示复核。
3. 完成后按分类、关键字、待复核筛选；展开证据查看文件、物理页码与原文，并可打开对应 PDF。
4. 导出 JSON 保留所有字段；CSV 用于清单复核。结果是要求提取，不是批准投产的工艺卡。

复杂资料需要几分钟。默认一个任务运行、最多五个排队，每次Pi调用超时为10分钟，可用 `PI_TIMEOUT_MS` 调整。失败任务明确返回错误，不用空表或示例结果表示成功。刷新浏览器可恢复最近一个任务，`?job=任务ID` 可直接打开任务，服务重启前未完成的任务需重新提交。

Flash 对工程图默认进行第二遍独立核对：用同一原始资料和图像，只给图纸与检验频次候选条目，要求输出有证据的替换补丁。补丁只能替换已有候选ID，不能新增或删除条目；再次通过相同结构和来源校验。复核器看的是子集，因此它的自由文本全局提示不会自动合并进最终warnings，避免把“本轮未提供”误报成“全量遗漏”；不确定性通过具体条目的review_note呈现，原始复核输出仍留存。该步骤仍通过 `pi -p` 调用，会增加时间和API用量；`PI_AUTO_REVIEW=0` 可关闭。校对失败时任务明确失败，原始中间结果留在任务目录，不把未完成校对的结果当作完成。

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

每个任务有隔离的 `runtime/jobs/<UUID>/pi-config/models.json`，`apiKey` 使用 `$DEEPSEEK_API_KEY` 环境插值；源密钥只在服务端。stdout 按 UTF-8 + LF 严格解析 JSONL，检查最终 assistant 正常结束、完整 JSON、字段结构和引用位置，不用正则“修补”缺失的模型数据。

## 真集和真实评估

- `evaluation/gold.json`：两份资料的148项 GPT复核参考要求，含物理页码、适用性、关键项与源文件SHA256。
- `evaluation/GOLD_NOTES.md`：复核范围、原文歧义和评分边界。该参考集尚未经铸造工程师签认。
- `evaluation/REPORT.md`：实际运行的版本、结果、问题和修正。
- `evaluation/skills/`：保留参与对比的 skill 版本；最终版本在 `skills/`。

原始资料、真集、逐条审查和实际提取样例随本地完整交付包提供；公开Git仓库只保存通用代码、skill及评估工具，不上传客户文件或其详细技术清单。

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

官方依赖依据：[Pi仓库](https://github.com/earendil-works/pi)、[Pi CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)、[DeepSeek API](https://api-docs.deepseek.com/)。
