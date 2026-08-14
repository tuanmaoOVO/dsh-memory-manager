---
id: "m_example_composite"
title: "示例：产品规划汇总（组合记忆）"
impressions: ["汇总","组合记忆","示例"]
links: []
composedOf: ["m_example_planning", "m_example_meeting"]
sourceSession: null
createdAt: 1750007200000
updatedAt: 1750007200000
revision: 1
---

## 快照

### 汇总
本条为**组合记忆**：通过 `composedOf` 非破坏性聚合两条记忆，不复制原文。

- 规划（m_example_planning）：三方向 + 里程碑
- 评审（m_example_meeting）：范围收敛 + 新指标口径

需要细节时用 `memory_recall` 读原记忆全文。

<!-- mem:notes -->

组合记忆演示：composedOf 列表中的 id 会被渲染为链接，可跳转回原始记忆。
