# #718 开发验证与交付

范围：十二类模板文件生成、可核验募集书引用、真实一致性检查、按文件直接生成修订版（无需逐项接受）、保留历史与双 Word 下载。未部署；用户验收未发生。本记录不是统一集成测试 chat 的验收交接。

## 版本与依赖

- 分支：`feat/project-files-e2e-20261021`，基线 `d401be3c`。
- 依赖 #713 → #715 → #717；本批 PR base 为 develop。
- 迁移：`0111_project_file_workspace.sql`、`0112_project_file_update_credits.sql`。仅应用于下述独立本地库及回归克隆库。
- 无新增 npm/Python 外部依赖。使用现有 PostgreSQL、Blob、Codex CLI、python-docx/lxml/PDF 组件。
- 对外 DTO、枚举、文件目录在 contracts；详见 [架构](../../PROJECT-FILES-ARCHITECTURE.md)。

## 自动化验证

- contracts、API、worker、web TypeScript 编译通过，Vite 生产构建通过；有既有的大 bundle 提示。
- contracts：171 个公共合成样例、12 个内部参考库样例、4 个数据生命周期样例通过；issuer binding/OCR 40 测试通过。
- 项目文件 E2E 使用真实 PostgreSQL、Azurite、上传/下载、队列和 Word 修改，**模型提议由测试替身提供**。覆盖模板必填/复用、两文件生成、准确引用、整份文件修订、按文件计费、余额不足、取消释放及重试、原字节保留、目录归档、账号隔离、请求幂等。
- 更新期间并发上传文件和切换募集书，最终用户选择不被覆盖；旧来源不能冒用当前选择修订号；原募集书版本不被关联文件修改。
- Word 成果持久化后、阶段检查点写入前模拟进程中断，恢复复用同一字节引用。
- 最近定向回归：项目文件 E2E、引用证据（含虚构、缺项、跨表格期间、重叠修改）、原 M4 document/QA pipeline 共 6 项通过，0 跳过。
- 先前项目列表/M4 skills/M4 stages/证据/E2E 定向组合 26 通过，1 个 Windows 符号链接用例跳过。该平台差异不冒充 Linux 通过。
- Python `unittest discover -s python/tests -p test_project_files.py -v`：5 项通过，验证存疑事项仅加批注、准确段落、相同金额不同期间不误改、表格定位、修订/批注/清洁版、哈希及重叠保护。
- 前端项目集合模型 6 项通过；包括准确任务链接和直接子文件目录。

## 本批独立本地环境

入口：`http://localhost:5194/#generate`。账号 `integration_user`，密码 `Local-Test-2026!`；这是隔离库中的开发测试账号，余额为合成测试积分。

实例 `files-20261021`；API 3024、PostgreSQL 15444、Azurite 10024。数据目录位于父工作区 `work/local-integration-runtime-files-20261021`；不连接生产数据库，不修改 5193 或其他 chat 的服务。

在本工作区 PowerShell 中：

```powershell
$env:BB_LOCAL_INSTANCE='files-20261021'
node scripts/local-integration/start.mjs
# 无活动任务时停止；数据保留
node scripts/local-integration/stop.mjs
```

真实模型 worker 使用固定 Linux 镜像、现有本机认证和文件沙箱。`configure-generation.mjs` 的真实 Word/沙箱预检已通过；模型为现有授权配置 `gpt-6-sol / copilot_enterprise`。认证留在仓库外，未写入源码或截图。实际业务生成结果在下方单独记录，不用预检代替业务 E2E。

## 页面与设计对照

原型 commit `35da7b8c9bc649abea4aadd66ab59a624be7e7b4`，地址 `http://127.0.0.1:5186/`。对照使用 1440 × 1000 viewport，全页截图因内容高度不同而长度不同。

| 设计稿 | 实现 |
| --- | --- |
| ![设计的文件选择](design-files.jpg) | ![实际文件选择](implementation-files.jpg) |

沿用三步流程、四组十二文件、多选文件包、模板准备区、项目目录与版本记录。实现显示真实账号/余额/任务及错误，替换原型演示数据；2026-10-21 用户最新决定将逐项接受改为整份文件生成修订版，按每份 4,500 积分提示费用；源选择复用真实募集书版本面板，模板窗展示持久化 Word；结果显示后台任务并直接下载。此前用户明确要求的 side-by-side 冲突比较保留为展开的证据面板；专业结论缺项保留人工确认。诚信核查和项目问答是其他开发批次，未在本批接入模拟实现。

## 验收路径

1. 文件生成 → 选择/新建项目 → 添加募集书，设为当前版本。
2. 选择文件，未提供对应模板时不能生成；保存 DOCX 模板后生成，返回页面确认模板复用。
3. 成功后下载文件与编制说明，到项目文件查看目录和 V1。
4. 上传含已知差异的募集书 V2，设为当前，点击检查一致性；查看真实状态、原文对照和建议。
5. 点击更新文件（4,500 积分/份），直接生成全部可确认修改；完成后下载修订/清洁版，检查修订、缺项批注和 V1 历史。
6. 重新检查、切换募集书/上传目标新稿，确认过期检查不能覆盖新版本。

用户已确认检查免费、更新每份 4,500 积分；生成沿用既有费率。更新成功交付才扣费，失败/取消释放预留。合成样本的真实模型测试不代表十二文件/所有市场的专业内容已验收。统一集成、真实业务材料验收及生产发布仍由指定 chat 按用户授权执行。
