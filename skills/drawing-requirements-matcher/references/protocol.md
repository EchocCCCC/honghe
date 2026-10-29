# 图纸输出协议

仅加载当前模式所需章节。示例用于说明字段，须换成本零件的真实资料。

## common

只输出一个合法JSON对象，不加围栏或解释。保留该模式全部字段；无内容数组用[]，字符串用""。sources/evidence至少一个{file,page,section,quote}，page为从1起物理页，quote为该页连续原文。提供S1/D1映射时file只能原样用这两个代号；否则精确使用输入原文件名，不猜缩写。

要求对象字段为id、category、informationType、requirement、scope、parameters、sources、review_required、review_note、origin、ruleIds。id唯一；category为具体要求名称，requirement为指标/要求值，scope为适用条件，parameters是{name,value,unit}字符串对象数组，review_required是布尔值，其余说明为字符串。无数值parameters可为[]；正文、参数与复核说明的不确定性须一致。
informationType仅为旧接口兼容标签：manufacturing=制造操作/材料状态选择，quality=指标或检验义务，procurement=采购交付管理；不输出context要求，不为分类新增条目，也不把这套标签当作行业理论。

drawing字段：partNumber、name、revision、material、materialForm、process、castingClass为字符串；airtightness为required/not_required/unspecified，dimensionState为before_finish/after_finish/unspecified；references、uncertainties为字符串数组；facts为{name,value,sources}数组，仅用当前图纸证据。summary为字符串。

每个非context规则恰有一个disposition：{ruleId,status,reason,evidence}。status为applicable（满足条件）、not_applicable（有依据不符）、overridden（有授权被专用要求覆盖）、needs_confirmation（条件/事实不足）。有效或待确认要求的链接规则如下：
- applicable、overridden、needs_confirmation各至少关联一个requirements.ruleIds；not_applicable不得进入有效要求。context仅供理解，不输出处置，也不能进入ruleIds；不能用“其余按规范”代替逐条判断。
- 每个ruleIds编号均须在该要求sources中有该规则原始sources的同file+page证据；多规则逐个满足。origin=specification时ruleIds非空且有规范来源；drawing时ruleIds=[]且有本图来源；combined时ruleIds非空且有双方来源。
- overridden处置的evidence同样须有规范与本图双方证据。drawing.facts只能来自本图。未知规则、跨零件来源、越界页码、重复处置或缺链接均不可接受，不能靠改origin、删规则或伪造引文绕过。
- needs_confirmation及关联规则的原有疑点传递到要求，review_required=true，指标保留具体前提或“待确认”，不能输出无条件确定值。
- 通用规则因图纸否定声明而not_applicable时，仍将该声明作为图纸独有项保留：origin=drawing、ruleIds=[]；不把否定声明误当成应删除的通用检验要求。

## match

逐图匹配输出完整结果。以下示例假设调用方提供S1/D1及非背景R001，实际应处理全部输入非背景规则并引用各自所在页：

```json
{
  "drawing": {"partNumber": "图内图号", "name": "零件名称", "revision": "图内版次", "material": "图内牌号与状态", "materialForm": "", "process": "", "castingClass": "", "airtightness": "unspecified", "dimensionState": "unspecified", "references": [], "facts": [], "uncertainties": ["待确认的具体属性"]},
  "summary": "零件识别及适用关系摘要",
  "requirements": [{
    "id": "REQ-001",
    "category": "内部质量验收等级（受检区域）",
    "informationType": "quality",
    "requirement": "区域壁厚未确认，按原规范分档条件待确认",
    "scope": "原规范指定材料及受检区域",
    "parameters": [],
    "sources": [
      {"file": "S1", "page": 1, "section": "规则原始条款", "quote": "规则原始所在页连续原文"},
      {"file": "D1", "page": 1, "section": "受检区域", "quote": "本图该页连续原文"}
    ],
    "review_required": true,
    "review_note": "缺少受检区域壁厚依据，不能用总高代替",
    "origin": "combined",
    "ruleIds": ["R001"]
  }],
  "dispositions": [{
    "ruleId": "R001",
    "status": "needs_confirmation",
    "reason": "受检区域的适用分档条件尚未确认",
    "evidence": [
      {"file": "S1", "page": 1, "section": "规则原始条款", "quote": "规则原始所在页连续原文"},
      {"file": "D1", "page": 1, "section": "受检区域", "quote": "本图该页连续原文"}
    ]
  }],
  "warnings": []
}
```

## audit

先从全图独立查漏，再核对候选及诊断；候选可能尚未通过结构检查，诊断只是线索。复核范围仍覆盖整个零件，检查所有同类问题；只返回有原文依据的改动，不能复制完整requirements/dispositions或未改变条目。也须核对两列的行粒度和图纸明确否定声明：不同指标混在一条时拆分，用原id替换其中一项，其余用ADD新增；保留全部原值和必要规则链接，不能仅因数值正确就保留合并条目。

```json
{
  "drawing": {"partNumber": "", "name": "", "revision": "", "material": "", "materialForm": "", "process": "", "castingClass": "", "airtightness": "unspecified", "dimensionState": "unspecified", "references": [], "facts": [], "uncertainties": []},
  "summary": "",
  "replacements": [],
  "additions": [],
  "removals": [],
  "dispositionReplacements": [],
  "warnings": []
}
```

drawing和summary是完整替换，须保留候选中未变的正确事实，不能照抄空示例；其余数组仅包含改动：
- replacements为common的完整要求对象，id只能用候选已有编号；additions同形状，用本次唯一ADD开头id，不能重复已有内容。
- removals每项为{id,reason,evidence}，id须已有且本轮不能同时替换，须有原文依据。删项不能使仍适用/覆盖/待确认的规则失去链接；必要时同步修正处置，背景只保留解释信息。
- dispositionReplacements每项为完整{ruleId,status,reason,evidence}，只用规范已有的非context编号，可补漏处置；覆盖仍须双方证据，未变处置不返回。
把补丁视作合并后，重新检查common的全部来源、角色、逐规则所在页、唯一处置及链接约束；不得静默丢弃已有正确的兼容记录。剩余疑点落实到指标、review_note或drawing.uncertainties，不只加全局warnings。
