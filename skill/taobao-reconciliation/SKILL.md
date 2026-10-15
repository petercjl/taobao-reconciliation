---
name: taobao-reconciliation
description: 按自然月分析淘宝或天猫店铺的收入与费用。先用支付宝、聚合结算、现金保证金的余额验证明细，再解释货款、退款、费用和现金变化；适用于淘宝对账、店铺月度账单、财务账单还原。
---

# 淘宝对账

目标是解释店铺的收入、费用及资金去向。第一步闭合账单，第二步分析账单。应用负责月度范围、分类、关联、余额证据政策、前月承接和报告；`tbcli` 负责会话、平台取数、分页、校验与真实余额证据。

## 输入、策略与输出

I：店铺与YYYY-MM，可选费用关注、已确认账户范围、余额锚点和前月state.json。月份缺省采用最近已结束自然月并说明。人民币、Asia/Shanghai；其他币种返回FEATURE_UNSUPPORTED。明确的非整月分析沿用analyze，标注截至时点。

S：确定范围 → 发现身份和目录 → 明确采集清单 → 取得流水、业务明细和独立余额 → 分类和关联 → 账户/月度/合并自检 → 解释收入费用 → 交付。

O：report.html、analysis.json、details.csv、balance-evidence.json、state.json、manifest.json及原始采集manifest。分别披露现金闭合、分类、业务账单覆盖、账户范围与余额证据等级。净现金变化与利润分别表述。

## 运行依赖与责任

1. 识别当前 Agent，加载对应 `adapters/PLATFORM.json`，检查 `capabilities.json` 的必需能力。状态 unresolved 返回 CAPABILITY_UNAVAILABLE，保留可复用输入；不临时猜测适配方式。
2. 从 PATH 发现 `tbcli` 与 `taobao-reconciliation`，检查版本、capabilities --json 和 doctor --json。依赖契约为 tbcli finance v1，要求 identity/catalog/fetch/balances 四个命令及 manifest schemaVersion 1；版本号相同不保证功能存在。
3. 通过 `tbcli skill source --json` 解析逻辑 Skill `tbcli` 的唯一源码，完整读取其 SKILL.md，并在财务节点按其路由加载 finance 契约。此依赖输入为明确命令与范围，输出为账单/余额文件；缺失时返回 DEPENDENCY_UNAVAILABLE，要求按该 CLI 的安装流程处理。完成后返回本 Skill 的“采集”节点，不复制底层接口实现。
4. 配置、登录和业务数据归用户；本包仅保存公共方法。调用权限限平台只读和创建新的本地文件。外部财务操作、数据库写入、调度和发布分别需要明确授权。

## 主线与节点

### 范围

常规月度任务先读取[月度合同](references/monthly-contract.md)。以月初00:00至次月月初00:00为边界，结束时点不包含。优先使用前月台账或当月官方余额；仅首次建立锚点或中间缺口时进入最小历史补取。普通任务不重新获取开店以来全部订单。

确认当前浏览器中的店铺，避免套用项目默认店铺。记录三个资金账户：支付宝、聚合结算账户、现金保证金。把身份、账期、含首尾日/不含结束时点、账户归属和币种写入新 plan.json。共享支付宝需确认哪些流水属于本店；无法证明时保持 partial。

进入第一个知识依赖节点时，按需批量读取 references/SCHEMA.md、index.md、log.md，再走 [账户与取数路由](references/queries/collect.md)。输出明确采集清单和范围；返回采集节点。此时延迟加载后续分析与维护知识。

### 采集

月度入口：先将已明确店铺、卖家ID、三个账户、账单选择和既有证据写到新的REQUEST.json，执行 `taobao-reconciliation collect-month --input REQUEST.json --month YYYY-MM --out NEW_DIR --json`。应用编排只调用tbcli，不实现平台私有API。没有特殊账单选择时由实时目录发现全部detail。完成后进入第一步闭合。

登录/验证中断保留目录；用户处理后，以相同输入、月份、目录加 `--resume` 恢复。重用成功步骤的哈希并仅续取缺失部分。`collect-month`只处理已结束月份；当月需求使用明确日期范围和当时快照，不赋予完整月标签。

执行 tbcli auth status --json、finance identity、各来源 finance catalog。

涉及订单全集、供应商表完整性或待结算解释时，以千牛“已卖出宝贝”为订单主账。先从 tbcli 当前能力目录确认 orders list，再读取其订单主账契约；用户要求全历史时执行 `tbcli orders list --all-history --shop-key KEY --out NEW_DIR --json`，两个分区都核验终点。供应商表为发货/退货事实，不替代平台订单全集；只用其实际存在的字段。支付宝 trades 作为辅助交易状态，按创建时间采集，微信等渠道可能不在其中。订单状态和页面实收款展示值不直接增加现金收入。
按当前目录选择全部相关收入/费用明细及月日汇总，另取支付宝 ledger、聚合 ledger/withdrawals/freezes/months、保证金 cash/insurance。调用者指定账单、店铺键、账户 ID 和日期；每次使用新的输出目录。

每个账户查询期初和期末官方余额；支付宝、聚合支持已结束月边界，保证金历史不可用时保持unavailable/null。已有用户确认起点和完整历史流水时，可显式启用balancePolicy建立锚点重建证据。重建值保留sourceKind和区间/流水哈希，不能作为独立官方余额。月末后快照只有覆盖全部间隔流水时才能回推，并保留派生等级。费用月账单需完整自然月；空结果不能单独证明尚未发布的账单金额为零。

成功分页不证明历史可用范围齐全。检查平台日期限制、空页、全量计数、月份跨度及更新时点。遇登录/验证停止该来源，保留 partial 及 runId；用户处理后以原范围恢复。其他来源可以继续。恢复后返回分类节点。

### 分类与关联

到此节点读取 [分类路由](references/queries/classify.md) 和 input-schema.json。以三个账户的实际资金流水为现金主线，平台费用/收入明细为业务解释证据。使用包内 `analyze` 的整数分计算、ID 去重、精确订单金额匹配和账户桥接；命令将未证明的归属保留 unknown。

规则只基于平台业务码、已确认语义或可追溯证据。自定义规则写在 plan.rules 并说明依据。对内部转账提出候选，用两个账户的真实流水与关联凭据形成 transferPairs。相等金额和相近时间只够提出候选，不足以自动抵销。保证金退款、补款及支付宝镜像要分别识别；补款不是费用。

消费积分、月日汇总、开票和税务资料可能重复描述已有资金事件。用辅助证据解释，不直接叠加金额。逐笔关联无法唯一完成时保留 unmatchedSupporting，返回自检节点。

### 自检与分析

到此节点读取[自检与解释路由](references/queries/analyze.md)。第一步运行 `taobao-reconciliation month --input PLAN.json --month YYYY-MM --out NEW_DIR [--previous STATE.json] [--state-dir PRIVATE_DIR] --json`。PLAN由collect-month生成，或引用已有完整平台采集。传统明确日期任务仍可运行analyze。

每账户期初＋入账－出账＝期末；合并抵销已证明内部转账。余额证据依次为independent、confirmed、reconstructed、unavailable。现金状态passed表示独立验证，confirmed包含明确确认起点，provisional含锚点重建，partial为缺证据/分类，failed表示真实金额差额。任一账户非零差额不能与其他账户相抵消。锚点之间复核失败同样阻止通过。

检查analysis.checks，将余额/现金、分类、业务覆盖和账户确认分别解释。未知等额收支、未关联转账、分段缺日、来源冲突和哈希变化都保留为缺口。有差额时交付差异；证据不足时只输出带范围限制的分析，不通过凑数修复。

第二步解释货款、退款和各项费用，查看feeDetails的扣费、返还、净费用。通式是货款－退款－费用＋外部注资－外部提现＝净现金变化；无外部资金时呈现简式。现金发生日决定主报告月份，业务账期保留用于关联；跨月退款不挪回原订单月。比较前月时必须同账户、同政策、且有可承接台账；证据等级不同明确披露。

保存月报和state.json，前月期末承接次月期初且证据等级不升级。--previous验证原报告哈希和修订；state-dir保存不可变修订。前月被修改或出现更新修订时，复核承接后再运行。个人支付宝账户范围确认只表示用户指定的分析范围，不等于平台绑定或所有收支均为本店业务。

passed 条件：三个账户范围和归属确认、所有必需账单覆盖、同币种独立余额时点吻合、每桥接差额为零、分类与关联无缺口。partial 时给出已覆盖范围的分析与缺口；failed 时先检查取数、时间、单位、重复和归属，列出未解决差额。零差额不能抵销 unknown 或其他自检缺口。

报告解释货款、退款、渠道、基础软件费、消费者体验费、营销托管费、赔付、物流及有证据的其他费用。费率分母为货款，货款零时为null。可靠订单/商品映射存在时才下钻。常规月报不依赖供应商对账；品牌新享在当前财务范围，万相台为后续范围。

报告 HTML 为可交付现金分析；Agent 应结合 analysis.json 补充关键业务发现与待处理项，不凭空生成成本或完整利润。检查所有文件存在、非空、输入哈希和状态一致；未经浏览器检查不宣称视觉验收。

## 分支、QA 与演进

- 任一能力缺失：列出逻辑能力与所需字段，保留计划，返回依赖节点；不得用截图代替底层账单。
- 结构变化、单位不明、同ID不同数据或哈希变化：停止相关计算，返回采集核查；保持已有文件。
- 分类语义缺失：unknown → 调查实际业务凭证 → 用户确认或可追溯规则 → 重新分析；不靠凑平余额分配差额。
- 所有输出路径先检查存在与元数据，使用新路径；已存在内容需先保留可恢复备份。Skill 安装通过包的 skill 生命周期，遇本地修改停止覆盖。
- 新增服务集成归 tbcli；业务规则归本应用。协议不兼容返回 CONTRACT_UNSUPPORTED，分别迁移后返回依赖节点。
- 开发测试和标准答案留在包外的 development/test；干净回归需要用户接受标准结果并明确要求后再执行。
