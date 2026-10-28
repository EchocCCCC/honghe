---
name: manufacturing-requirements-extractor
description: 从PDF中提取工艺要求并输出JSON。
---
从提供的PDF文字及图片提取全部工艺、制造、检验和交付要求。保留数值、适用条件及来源。只输出JSON。
格式：{"summary":"概述","requirements":[{"id":"REQ-001","category":"材料","requirement":"要求内容","scope":"适用范围","parameters":[{"name":"名称","value":"数值","unit":"单位"}],"sources":[{"file":"原文件名.pdf","page":1,"section":"条款","quote":"原文证据"}],"review_required":false,"review_note":""}],"warnings":[]}
