# 规范输出协议

仅加载当前模式所需章节。示例文字是字段说明，须替换为本次原文及来源。

## common

只输出一个合法JSON对象，不加围栏或解释；保留所选模式的全部字段。无内容的数组用[]，字符串用""；未知条件在指标和复核说明中具体标明，不用空条件伪装无条件适用。

规则对象字段：
- id、category、requirement、scope为字符串。category是具体要求名称，requirement是指标或要求值；scope保留对象/范围，parameters是{name,value,unit}数组，三个值均为字符串。
- sources至少一个{file,page,section,quote}；page为正整数物理页，file精确用输入原名，quote为该页连续原文。review_required为布尔值，review_note为字符串。
- strength为required/prohibited/recommended/permitted/reference/conditional之一，分别保留必须/禁止/推荐/允许/参考/条件性；conditions、exceptions、externalReferences为字符串数组，overridePolicy为字符串。
- informationType仅为旧接口兼容标签：manufacturing=制造操作/材料状态选择，quality=指标或检验义务，procurement=采购交付管理，context=必要定义/引用背景。它不是行业分类标准，不为归类新增条目；背景不计工艺要求，引用标准的真实制造或检验义务不能归背景。
同一要求的指标、参数、条件与引文必须一致。无需数值时parameters可为[]；推导值须明确标“推导值”并保留原规则，不改quote。

## extract

完整或“分批规范提取”使用本形状。分批只提取负责物理页，其余页用于跨页表头和定义；每项至少一个sources属于负责页。封面、目录、空白或历史页允许rules=[]。id本次唯一，后台分配最终R编号。

```json
{
  "metadata": {"number": "原文规范编号", "title": "正式名称", "version": "原文版次", "scope": "适用范围", "excludedProcesses": [], "priorityPolicy": "原文文件优先关系"},
  "rules": [{
    "id": "RULE-001",
    "category": "抗拉强度（材料及分档条件）",
    "informationType": "quality",
    "requirement": "按原文逐档保留限值；不明处标待确认",
    "scope": "原文适用对象",
    "parameters": [],
    "sources": [{"file": "规范.pdf", "page": 1, "section": "原文条款或表号", "quote": "本页连续原文"}],
    "review_required": true,
    "review_note": "本示例尚无真实材料及分档值",
    "strength": "conditional",
    "conditions": ["原文材料、状态及尺寸区间"],
    "exceptions": [],
    "overridePolicy": "",
    "externalReferences": []
  }],
  "warnings": []
}
```

## audit

先独立阅读负责页，再与完整候选比较遗漏、错配、脚注和错误补齐；表格重新按格线恢复逐行逐列映射，数字曾出现不等于对应正确。候选及诊断不是事实。

```json
{"replacements":[],"additions":[],"warnings":[]}
```

replacements、additions每项均为common规定的完整规则对象。替换只用已有id，新增用本次唯一ADD开头id；每个改动及被替换原项均须属于负责页。只返回有依据的改动，不删条目、不改metadata、不重复正确项。保留已有正确的兼容记录，混合条目有实质义务时不能因背景或交付文字而隐藏它。

## classify

仅“已有条目归类”使用：这是旧数据的兼容操作，不重新读图，不重写要求、数值、来源或编号。输入records的每个id恰好输出一次，无遗漏、重复或新id。

informationType按实际义务取manufacturing（制造操作、材料/状态选择）、quality（产品指标、检测/频次/验收/复验）、procurement（报告证书提交、追溯资料、包装运输贮存）、context（范围、定义、版本/优先关系、纯导航）。检验批定义为背景，检测按标准执行仍是检验义务；仅出现材料或工艺词不决定类别。混合条目保留制造/检验核心，在reason说明“混合条目，需拆分复核”；无法区分制造与质量主次时用manufacturing并说明，不在本模式拆改条目。

```json
{"classifications":[{"id":"输入原id","informationType":"quality","reason":"规定产品指标或检验行为"}]}
```

只输出此对象；reason须为实际归类依据，不能为空。归类不提高旧记录的技术正确性或适用性。
