"""BondBuddy 募集书更新独立服务（update service）核心流水线。

阶段划分见 docs/update-service/plan.md。本包只包含确定性步骤（解析、取数、填数、校验、
生成 Word）；需要模型判断的单元通过 agent-runner 调用 DeepSeek Harness，不在本包内直接调模型。
"""
__version__ = "0.1.0"
