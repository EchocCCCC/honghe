# 规范输出协议

只加载当前模式；示例字段说明须换成真实内容。

## common

只输出合法JSON对象，无围栏。无内容用[]或""，不编造未知条件。每条规则具有：
- id、category（具体要求名称）、requirement（具体指标/要求值）、scope：字符串；parameters为{name,value,unit}字符串数组，可为空，不必重复每个正文数字。
- usage：inspection或comparison，含义见入口，不按章节名判断。规范阶段不要求processCategory；工艺分类在逐件输出完成。
- sources：至少一个{file,page,section,quote}，page为正整数PDF物理页，file精确使用输入文件名，quote为本页连续原文。
- review_required：布尔；review_note：具体疑点，无疑点用""。来源是图片、无文字层、条件性或推荐性本身不构成疑点。
- strength：required/prohibited/recommended/permitted/reference/conditional；conditions、exceptions、externalReferences为字符串数组；overridePolicy为字符串。scope/conditions仅保存整条共有前提；局部列条件随该列指标写入requirement及对应parameter名称，或拆为独立规则，不扩大到其他列。保留语气、前提与例外。
- informationType仅供旧接口兼容：制造操作用manufacturing，产品指标或检验义务用quality；新技术条款不输出procurement/context。它不替代最终八类工艺分类。

## extract

分批仅输出负责物理页的条款，每条至少一个source位于负责页；其他页仅供理解引用与续表。封面/目录/空白页可rules=[]，本次id唯一，后端分配最终R编号。

```json
{
  "metadata":{"number":"规范编号","title":"正式标题","version":"版次","scope":"适用范围","excludedProcesses":[],"priorityPolicy":"原文优先关系"},
  "rules":[{
    "id":"RULE-001","category":"检验项目及其分档","requirement":"本页原文具体限值、方法或频次","scope":"对象及适用条件",
    "usage":"inspection","informationType":"quality","parameters":[],
    "sources":[{"file":"规范.pdf","page":1,"section":"条款或表号","quote":"本页连续原文"}],
    "review_required":false,"review_note":"","strength":"required","conditions":[],"exceptions":[],"overridePolicy":"","externalReferences":[]
  }],"warnings":[]
}
```

## audit

先独立读负责页原图，再检查候选漏项、错配、表格/脚注及usage，尤其剔除inspection中的纯定义、报告管理、生产工艺或批准义务。混合项以原id替换为检验实项，制造对照用ADD新增，管理句不输出。纯定义已被单列时可将其改为comparison。候选不是事实，不能只检查已有数字是否出现。返回：

```json
{"replacements":[],"additions":[],"warnings":[]}
```

每个替换/新增都是common完整规则。替换仅用已有id且新旧均属于负责页；新增用唯一ADD开头id，不重复已有要求。不得修改其他批次条款、metadata或无依据删除技术义务。非检验条款仅改为comparison，不为减少最终列表而丢失冲突对照。

## classify

仅用于旧四类信息标签兼容，不重新提取、改写数值或伪造八类/usage。每个输入record id恰好输出一次：

```json
{"classifications":[{"id":"原id","informationType":"quality","reason":"根据原文实际义务说明"}]}
```

informationType取manufacturing/quality/procurement/context。无法确定时保留具体疑点，不把旧分类转换当作按新范围重跑。
