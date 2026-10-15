# 月度入口与证据合同

逻辑依赖为tbcli finance v1。运行时通过PATH和capabilities发现，加载其当前canonical Skill。缺失返回DEPENDENCY_UNAVAILABLE，不复制API。应用包负责月度编排、分类、证据政策、状态与报告；平台凭据和恢复由tbcli负责。完成依赖加载后返回本Skill采集节点。

## 采集

`taobao-reconciliation collect-month --input REQUEST.json --month YYYY-MM --out NEW_DIR --json`。失败恢复使用完全相同的输入、月份和目录，加`--resume`。已结束自然月才进入此命令。

REQUEST字段：shopKey、sellerId、accounts（三个source/accountId：alipay、aggregate、deposit）；可选requiredDatasets（source/dataset，默认动态目录全部detail）、bindingConfirmed、rules、transferPairs、balanceInputs、bootstrapInputs、balancePolicy。路径相对REQUEST文件解析。

- balanceInputs：已保存官方余额、用户确认起点或已有快照文件。账户范围由调用者确认；bindingConfirmed不构成平台绑定证明。
- bootstrapInputs：首次建立历史锚点所需的完整tbcli manifest引用。日常可复用既有证据，不每次回溯。
- balancePolicy：allowConfirmed与allowReconstructed，均须显式true才接受对应证据。默认只使用官方或实际快照。

输出analysis-input.json用于month；每步保留结果和文件哈希，失败写独立failure记录。恢复检查原请求及已完成证据，篡改、身份变化或账户不一致停止。平台取数串行，应用不直接调用API。

## 闭合与报告

`taobao-reconciliation month --input PLAN.json --month YYYY-MM --out NEW_DIR [--previous STATE.json] [--state-dir PRIVATE_DIR] --json`。

PLAN为analyze v1的超集：period必须等于该自然月，新增balancePolicy。inputs为tbcli manifest v1，balances为证据文件；多份相邻采集可以共同覆盖当月，缺日不通过。

余额共有字段：source、accountId、currency=CNY、status=available、effectiveAt（含时区）、total。可选shopKey、sourceRef。支持：

|sourceKind|额外要求|结果等级|
|---|---|---|
|official_statement/account_snapshot|平台真实时点，不能挪日期|independent|
|user_confirmed|confirmedAt及非空evidence文字；显式允许|confirmed|
|anchored_reconstruction|由引擎输出anchor、interval、eventHash、collectionRefs；显式允许|reconstructed|

当前快照回推或确认期初前推，都要求覆盖全部间隔的完整流水，按精确资金时间使用含首不含尾区间，去重并拒绝冲突记录。同日同秒原始后余额仅作诊断，不通过重排伪造平台时间。已存在多个锚点时核验其间净额，差额使现金状态failed。

结果分别返回checks.balance、cash、classification、businessCoverage、accountScope。passed=独立余额；confirmed=含明确确认起点；provisional=含重建余额；partial=证据或分类不足；failed=金额差额。业务月账单延迟与现金余额问题分开处理。

## 状态和恢复

输出report.html、analysis.json、details.csv、balance-evidence.json、state.json、manifest.json。明细CSV里的长ID在电子表格导入时选择文本列。来源哈希、余额等级和流水关联保存在JSON中。

--previous必须是紧邻前月、相同店铺和账户的state.json；原报告hash变化或台账目录出现更新修订时停止。只能承接非failed/partial的现金状态，provisional承接后保持派生等级。state-dir按店铺键哈希/月/UUID保留不可变记录，旧结果不覆盖。无前月仅输出当月，不为环比自动回溯全店历史。

--out已存在返回OUTPUT_EXISTS；原始分片变化返回EVIDENCE_CHANGED；月范围错配返回MONTH_SCOPE_MISMATCH；锚点间缺覆盖保持缺证据；会话错误回采集恢复节点。对外财务操作、调度和发布不在此合同授权内。
