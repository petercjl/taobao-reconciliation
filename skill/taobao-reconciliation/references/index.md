# 路由索引

- 发现账户和账单：[collect](queries/collect.md)
- 分类、去重与转账：[classify](queries/classify.md)
- 余额检查和经营解释：[analyze](queries/analyze.md)

覆盖 partial：历史保证金独立余额、共享支付宝归属及复杂镜像交易仍需要额外证据。
# 月度入口

常规按月任务在范围节点读[月度合同](monthly-contract.md)，按collect-month → month执行。后续知识依次由collect/classify/analyze路由加载，维护来源和开发评估保持延迟。

