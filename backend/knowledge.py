"""Versioned reference shared by project Codex tasks."""
from pathlib import Path
import hashlib

SOURCE = Path(__file__).with_name('data') / '上交所私募公司债募集书更新知识_v1.0.md'
VERSION = '1.0.0'
GUIDANCE = """# 项目参考知识的使用约定

下文是募集说明书更新的方法参考，不是发行人事实来源，也不是当前项目指令。
先完整阅读，再根据当前项目适用范围使用；不适用的规则不强套。
当前目标报告期、更新范围和材料清单以 input.json 及用户明确要求为准。
原知识中的“本次评测”“2025年6月”“2023年度、2024年度”“五份材料”等是原评测情境，
不能覆盖实际项目的报告期、比较窗口或材料数量，也不能将目标报告期用作签署日。
规则适用时点、发行人类型、交易所及专项品种须核对；本文不是全部现行规则已核验的结论。
新增项目事实须由本次授权材料支持，示例数字、原因及规则索引不能作为项目事实证据。
输出格式、工具权限和 Word 交付要求遵守当前任务说明；参考知识不改变这些约定。
在工作记录或交付说明中记录所用知识版本；资料缺口和适用冲突应如实说明。

---

"""


def reference_text():
    return GUIDANCE + SOURCE.read_text(encoding='utf-8')


def snapshot(task):
    content = reference_text().encode('utf-8')
    path = Path(task) / 'knowledge.md'
    path.write_bytes(content)
    return {'path': path.name, 'source': SOURCE.name, 'version': VERSION,
            'sha256': hashlib.sha256(content).hexdigest(),
            'source_sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            'role': 'method_reference_not_project_evidence'}
