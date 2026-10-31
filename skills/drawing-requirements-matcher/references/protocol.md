# 图纸输出协议

仅加载当前模式，示例须换成本图真实资料。

## common

只输出合法JSON对象，无围栏。保留当前模式全部字段；无内容用[]、""或规定的null，不编造未知事实。sources、facts中sources、dispositions中evidence、removals中evidence均为数组，即使只有一条也必须用[{...}]，不能写成单个对象。

如有OCR_CANDIDATE_DATA，它是本地OCR的未校核文字候选，不是PDF原文字层。置信度不代表正确率；旋转方向和框坐标只用于定位，像素坐标不是工艺尺寸。须逐字符对照原图，不能按最高分替换读数、把堆叠偏差改成±或补入原图没有的符号。

每个要求包含：
- id唯一，category为具体名称，requirement为完整执行指标，包含数值、符号及对应前提，不能把执行信息只放scope或parameters。scope保留全部适用条件。parameters默认[]，无需重复抄写正文已有的指标；仅后续处理确需结构化定位时填写{name,value,unit}字符串数组。
- processCategory仅取铸造/机加/热处理/表面处理/刻字/检验/焊接/其他。informationType仅供旧接口兼容，制造操作用manufacturing，指标或检验义务用quality；不输出procurement/context。
- sources至少一个{file,page,section,quote}，page为正整数物理页，quote为该页连续原文。若提供S1/D1映射，file只能用这些代号；否则精确用输入原名。
- review_required为布尔，review_note写具体疑点；清晰图像、无文字层、明确条件性及有授权的图纸覆盖本身不标复核。
- origin为drawing/specification/combined，ruleIds为规范原id数组。drawing：ruleIds=[]且有本图证据；specification：只允许关联usage=inspection规则，并有规范原始所在页证据；combined：有本图及每个链接规则原始所在页证据，comparison不能借combined名义补出图纸未给的制造要求。
- conflict为null，或{kind,specificationRequirement,reason}。kind仅conflict/drawing_override；specificationRequirement保留与图纸不同的规范值/规定，requirement保留图纸执行值，reason说明同对象条件及取舍。冲突项必须combined、关联对照ruleIds且sources有双方原文；需同时满足的要求/依据矛盾标review_required=true，已授权专用覆盖不强制复核。默认标准号不同仍可属授权覆盖，不能仅凭编号不同制造冲突；不同试验用途/阶段及无条件不适用也不是冲突。

drawing字段仅用于read和audit：partNumber/name/revision/material/materialForm/process/castingClass为字符串；airtightness取required/not_required/unspecified；dimensionState取before_finish/after_finish/unspecified；references/uncertainties为字符串数组；facts为{name,value,sources}数组，仅来自本图。summary为字符串。materialForm只填写原文明示的原材料形态，须有同名“原材料形态”fact；否则为空。原料专用facts.name只用“原材料形态”“原材料公称厚度”“原材料公称直径”，值及单位照原文，不能把成品几何、零件整体形状或相近尺寸改称原材料事实。

图面核对：主尺寸、上偏差、下偏差为同一组，不能把堆叠偏差的小数尾数另立为一个主尺寸。逐字保留正负号、小数点、直径及形位符号，原件没有的符号不补；角度须结合角弧端点、视图位置与★/▲逐项核对，数值和检验重要性同步修正。清晰的制图符号可按其名称记录，不要求再有文字注名，不能把“未用文字说明”当作识读不清。粗糙度数值必须跟对应表面符号读取，不能从附近尺寸或常见等级推定。重叠局部中的同一标注按源位置去重，不新增不存在的尺寸。标题栏facts同样不得推定单位或互换格值。

主视、剖视、向视和局部视图分别清点孔组，数量、直径、螺纹与均布标注成组核对；不同位置的同径孔组不能互相替代。粗糙度沿引线追到实际受控线或面，区分水平槽底、台阶面与竖直孔壁，不按最近的孔命名。堆叠偏差分上、下两行独立读取；单行仅为0时保留0，不从另一行复制小数变成双边偏差。未带★/▲但明确给出专用公差的尺寸也须保留。

条件核对：not_required必须有图纸明确否定原文；未写气密性为unspecified，不能把“未标注”改写成“明确无要求”。规范受气密性约束的检验在该前提未明时保留条件及待确认，除非有其他明确排除依据。复验依附于本件实际适用的检验项目；同条有通用复验与某专项试验判定时，只保留本件适用部分，不能因有通用句而带入不适用的专项试验。

验收边界核对：许可、豁免和局部例外也要交付。指定/非指定、加工/非加工等并列分支分别核对，不能只保留第一支的例外，或用更严指标代替原件允许范围。

两列完整性核对：图示“全部尺寸均为某表面处理前/后尺寸”等全局制造约束也须成行或写入相关requirement，不能只放在drawing、scope或sources中而使两列清单丢失执行条件。确认存在的基础依据矛盾须落实conflict及双方来源，不能只在review_note声称有冲突却让conflict=null。

match及最终合并结果中，每个inspection规则恰有一个disposition={ruleId,status,reason,evidence}，status为applicable/not_applicable/overridden/needs_confirmation。applicable/overridden/needs_confirmation必须有要求关联；not_applicable不得进入有效要求。comparison不强制处置或生成行，允许在实际图纸对照中关联。evidence同source形状；覆盖需双方原文，未知规则/重复处置/漏检验处置/越界页码/别件来源不能接受。needs_confirmation及上游具体疑点传给关联要求，保留条件或待确认，不能为过校验填空、删义务或编引文。

## read

只有D1，不加载规范、不推定规范义务。先独立识读整图和局部，输出本图明示的直接要求及事实。每条origin=drawing、ruleIds=[]、conflict=null、sources仅D1；dispositions=[]。材料状态、加工/表面处理前后、品牌认证、明确否定、焊缝/涂装区域、图内标准与等级均保留；标准依据与具体等级分别记录，便于后续分别关联。原料事实未明则留空，不从成品形状或尺寸推定。返回完整对象：

```json
{
  "drawing":{"partNumber":"图内图号","name":"图内名称","revision":"图内版次","material":"图内材料/状态","materialForm":"","process":"","castingClass":"","airtightness":"unspecified","dimensionState":"unspecified","references":[],"facts":[],"uncertainties":[]},
  "summary":"本图直接要求",
  "requirements":[{
    "id":"D001","category":"具体图纸要求名称","requirement":"图内具体值及其前提","scope":"本图受控对象",
    "processCategory":"机加","informationType":"manufacturing","parameters":[],
    "sources":[{"file":"D1","page":1,"section":"技术要求/视图位置","quote":"该页连续原文"}],
    "review_required":false,"review_note":"","origin":"drawing","ruleIds":[],"conflict":null
  }],
  "dispositions":[],"warnings":[]
}
```

## match

输入是已识读图纸中的匹配条件和规范规则，本模式不看图、不重新生成drawing，也不重抄D行。只返回差量：

```json
{
  "additions":[{
    "id":"N001","category":"适用规范检验","requirement":"本材料对应具体限值、方法及全部条件","scope":"适用条件",
    "processCategory":"检验","informationType":"quality","parameters":[],
    "sources":[{"file":"S1","page":1,"section":"规则原始条款","quote":"本页连续原文"}],
    "review_required":false,"review_note":"","origin":"specification","ruleIds":["R001"],"conflict":null
  }],
  "bindings":[{
    "id":"D001","ruleIds":["R002"],
    "sources":[{"file":"S1","page":2,"section":"规范对照条款","quote":"本页连续原文"}],
    "conflict":{"kind":"drawing_override","specificationRequirement":"规范默认值或规定","reason":"图纸已明确专用规定，采用D001原指标"},
    "review_required":false,"review_note":""
  }],
  "dispositions":[{"ruleId":"R001","status":"applicable","reason":"原文适用条件符合本件","evidence":[{"file":"S1","page":1,"section":"规则原始条款","quote":"本页连续原文"}]}],
  "warnings":[]
}
```

示例假设R001为inspection、R002为comparison且D001真实存在，须替换为输入实际id。additions为common完整要求，仅origin=specification、inspection ruleIds、S1来源、conflict=null；不新增图纸事实或规范制造条款。bindings每个已有D行最多一次，只能含示例六个字段；sources只补S1，不能含category/requirement/scope/parameters/drawing等改写字段。调用方保留D原文、参数及本图来源，并入规范来源后设combined；绑定不能清除原先具体疑点。

同义依据、图纸覆盖或真实冲突可绑定D行；新增检验方法、频次、分档等义务必须在additions写足，不能只挂ruleId交差。全部inspection仍逐条处置，comparison仅对照。只用明确材料与原料事实选档；输入unknown就是未明，不能用零件名称、普通成品尺寸或常见生产方式补齐。若某原规则仅定义/管理而无本件独立检验义务，not_applicable并说明原因，不能凑行。图纸笼统引用不展开未提供的标准正文。

## audit

先独立重读当前整图与局部，再对候选和诊断查漏纠错。检查：图纸直接要求是否漏掉；是否混入comparison制造条款；每个inspection处置与分档是否有依据；八类是否合理；冲突是否同对象同条件且保留双方值。逐格重新核实标题栏字段配对、尺寸受控对象及同一材料跨档共有值；不要因初稿已填且未被结构校验报错而照抄。同一图示的requirement、parameters与sources.quote逐符号反查，若正负号、直径符号或读数互不一致，须回原图确认，不能任选一处覆盖另一处。候选及诊断不是事实。已由原件确认的错误必须返回相应完整替换/新增和相关处置修正，不能只在warnings指出却保留错误字段；规范规则包与原文条件不一致时保留原文依据，不能盲从索引的错误范围。

```json
{
  "drawing":{"partNumber":"","name":"","revision":"","material":"","materialForm":"","process":"","castingClass":"","airtightness":"unspecified","dimensionState":"unspecified","references":[],"facts":[],"uncertainties":[]},
  "summary":"","replacements":[],"additions":[],"removals":[],"dispositionReplacements":[],"warnings":[]
}
```

drawing、summary为完整替换，须保留正确事实。其余只返回有原文依据的改动：replacements为common完整要求，id必须已有；additions同形状，用唯一ADD开头id；removals={id,reason,evidence}且不得同时替换；dispositionReplacements为完整处置，只用规范已有id。允许移除越过最终范围的comparison制造项，但不得使适用inspection失去关联。不能复制整张正确清单或为减条数丢义务。

纠正D行针对原图的读数、受控对象和实际图示义务；新增的规范检验方法、频次和默认判据保留在规范行，不为合并规范而重写正确的D指标、parameters或scope。若只补充规范来源，沿用D原有范围；规范行即使补入本图引用成为combined，也不变成新的图纸直接条件。原图确有错误则照实修正，不能为了保持匹配状态而隐瞒。

合并后重查全部来源、八类、冲突双证据与inspection唯一处置。疑点落实到指标、review_note或drawing.uncertainties，不只笼统放warnings；parameters和正文的确定性保持一致。

若原图确认材料、原料、气密性、标准等用于匹配的条件与候选不同，仍须照实纠错并在warnings说明需重新匹配；不能为沿用旧处置而恢复错误事实。调用方会阻止发布未经重新匹配的条件变化结果。
