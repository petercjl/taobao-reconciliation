# 淘宝对账

应用包 `@petercjl/taobao-reconciliation` 分析淘宝店铺的收入与费用，以独立账户余额、资金流水和平台账单检查理解是否完整。底层采集依赖支持 finance v1 的 `@petercjl/tbcli`。

给 Agent 的使用提示词：

> 用淘宝对账分析这个店铺上个月的账单，先核对余额，再分析收入和费用。

Agent 运行时加载包中唯一源码 Skill。财务流水保存在用户指定的私有数据目录。报告为资金收支分析，商品成本、平台外费用和推广账户未纳入时不能称为完整利润。

开发参考：`taobao-reconciliation capabilities --json` 发现命令，`doctor --json` 检查依赖；`skill source/status/install/update` 管理安装。`analyze --input PLAN.json --out NEW_DIR --json` 读取 tbcli 分片 manifest 与独立余额文件，生成 HTML、JSON 和证据索引。按月运行使用collect-month采集、month核对与交付；前月state.json可传给--previous，私有修订目录可用--state-dir。输入见Skill中的monthly-contract.md及input-schema.json。

当前为本地开发版本。macOS/Codex 主流程验证结果记录在开发验收记录；SealSeek 与 Windows 尚待运行验证。发布使用仓库内 Trusted Publishing 流程，本地安装不代表 npm 已发布。
