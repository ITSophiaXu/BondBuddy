# 定价与成本模型最小复算快照

来源为本机研究目录`C:/Users/lezhai/Downloads/Bondbuddy/pricing-redesign-20261027/pricing-first-model/`，于2026-10-28复制`inputs.json`、`rate-card.json`、`calculate.mjs`及`reported-update-cost-sensitivity.mjs`。输入、13项价格、需求假设及所有计算公式保持原样；脚本仅调整生成报告的路径和当前实现状态表述。

在仓库根目录依次运行：

```powershell
node evidence/commercial-billing-20261028/pricing-model/calculate.mjs
node evidence/commercial-billing-20261028/pricing-model/reported-update-cost-sensitivity.mjs
```

第一步生成本目录的`24个月条件测算.md`和`results.json`；第二步生成父目录的`用户实测更新成本-定价与盈利复核.md`及本目录的`reported-update-cost-results.json`。两份完整结果JSON供本地逐月复算，由局部`.gitignore`忽略，不提交Git。两份Markdown保留供审阅。运行只使用本地Node及内置模块，不调用模型、API或支付渠道。

原报告引用的合成工作日历、`projection-build/audit-config.json`、市场与竞品背景仍位于上面的研究目录之父目录；旧报告原文`用户实测更新成本-定价与盈利复核.md`也保留在那里。最小快照不复制这些历史背景；当前复算使用的分类、任务量、转化及税费假设已完整固定在`inputs.json`，不依赖这些外部原文件。

所有需求路径均为未验证条件，真实完整成本及实际利润仍为unknown。用户自报的更新API费用“几元”是已有观察；3／5／8元是敏感点，不是新增实测。249元更新的部分成本余额不能当作公司毛利或净利。原模型的其他动态成本10%另计支付、VAT附加和评估；在所得税25%、固定预算33,100元/月等原条件下，60%税后净利门槛约38.35万元月净收入，评估支出另加。生产收费开关默认关闭，本快照不授权收费或证明盈利。

校验基准：原主模型30条路径、720个月度记录；用户更新成本敏感性27条路径、648个月度记录。主模型基准24月条件净利为−520,731.574927802元；仅替换更新API为5元、更新非API余项为0元时为−513,473.1999166528元。后者是部分成本诊断，不是新盈利预测。
