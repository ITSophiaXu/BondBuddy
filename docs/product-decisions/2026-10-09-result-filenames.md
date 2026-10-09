# 成果下载命名（#629，2026-10-09 用户反馈）

所有任务成果统一使用 `{项目名}_{成果类型}_V{版本}_{生成日期}.{扩展名}`。生成日期固定为北京时间 YYYYMMDD，不能使用本次下载时间；类型区分募集书修订版、清洁版、基线版、复核报告、原文批注版、材料正文及编制说明。项目名从任务不可变输入读取，项目改名不会改变旧成果下载名称。新复核和材料任务将项目名锁入输入；旧任务缺名称时依次使用冻结的发行人、项目成果，缺日期如实显示“日期未记录”。

版本取复核次数、材料修订稿次或编制输入版本；技术 artifact_version 仍用于准确文件校验，不替换成显示版本。保留中文，清除路径、控制与双向文本控制字符，限制 UTF-8 字节数，扩展名取实际交付 MIME。

公共 ArtifactResponse 增加可选 filename、display_version，兼容旧客户端；M4 输入增加可选 project_name，兼容旧快照。成果页、项目列表、助手、复核及材料下载均采用服务端名称，字节下载同时提供 UTF-8 Content-Disposition。既有材料原件下载继续使用原文件名。不改写历史输入、登记记录或成果字节，无数据库迁移。

原型：product-prototype/public/result-filenames.html（现有成果页下载卡片），material-results.html（材料成果名称）。已迁移页面：artifact-page.ts、project-browser.ts、project-assistant.ts、review-workspace.ts、review-history.ts、material-workspace.ts。用户当日要求确认命名变更；既有导航、摘要和操作保持原页面。
