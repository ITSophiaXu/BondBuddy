# 历史／参考募集书必填与材料区调整

依据：用户于 2026-11-05 提供的三张截图及明确要求。基线为 `develop` 的 `3bb7baf1`；本目录截图对应本次 PR 实现和同步原型。用户尚未验收，尚未部署。

## 行为与界面

- 参考募集书标为必填。财务材料不能替代参考稿；已采用原稿还须填写对应版本的原稿信息。
- 原稿信息与格式排在财务材料之前。删除首次准备区重复说明、“填写补充要求（选填）”与“先提供发行人材料”跳转按钮；保留页末补充要求及续改底稿选择。
- 后端在输入锁定、报价和新任务提交时校验。独立 PostgreSQL 回归确认无原稿时返回明确的 `INPUT_REQUIRED`，不创建输入、报价、任务或积分预留。
- 合法上一轮成果仍可续改。已有任务按原不可变输入运行，幂等请求先返回原任务。

## 验证

- 全仓 `npm run build` 通过；最终修改后 API TypeScript、web TypeScript 与 Vite 构建再次通过。
- `npm run check:contracts` 通过。
- `required-source.pg.test`、`source-format.pg.test`、`unified-authoring.test`：9/9 通过。数据库为本次单独创建的本地 PostgreSQL 容器，合成数据，不连接生产。
- web `api.test`：25/25 通过。
- Playwright：`required-reference`、`prospectus-panel`、`source-format-template`、`authoring-source-guide`、`authoring-onboarding`：最终整组 52/52 通过。
- `project-execution`：82 项覆盖通过，包含更新旧选填断言后的定向复跑；1 项可选旧设计截图因未设置输出目录跳过。覆盖上传自动采用、并发与失败恢复、正常提交、续改、任务幂等、暂停与计费显示。
- `git diff --check`、改动原型脚本语法检查通过。

浏览器使用 Edge，真实页面及 API client 配合合成 HTTP 响应；不代表真实模型生成或生产账务验证。本次未运行依赖 Azurite 的完整上传存储 E2E。没有数据库迁移、依赖变化或生产服务操作。

## 截图

- `workspace-1440.png` / `workspace-390.png`：完整工作区，原稿信息在财务材料之前。
- `panel/implementation-*` 与同尺寸 `panel/prototype-*`：上传区未上传和已上传状态，1440 / 390 / 320 像素。
- `panel/implementation-multiple-*`：多个上传版本与生成稿历史，1440 / 900 / 390 / 320 像素。

同尺寸对照保持原上传控件与交互样式，变化仅为用户明确要求的必填文案、区域顺序及冗余内容移除。截图均为合成项目，不包含用户实际募集书。
