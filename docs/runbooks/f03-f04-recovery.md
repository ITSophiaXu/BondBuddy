# F03/F04 故障恢复与发布核对

本轮只修代码，不部署、不操作原四个任务、不发真实模型调用。发布提交、镜像、模板、实际部署与用户验收分开登记。

## 发布准备

固定`BB_FILE_AUTHORING_WORK_ROOT=/var/lib/bondbuddy/authoring-work`，宿主同路径RW bind、`create_host_path:false`，保留只读rootfs。受控adapter先建root所有且不可被其他用户写的父目录，叶目录1000:1000/0700，拒symlink且保留旧内容。每节点authoring只运行一个Node进程（可用既有并发槽），不同role/进程不能共享root。bootstrap必须携带authoring-workspace.mjs并通过hash和16KiB门禁。仓库更新不会自动更新现有节点。部署前先只读盘点旧容器原工作目录并备份候选；新持久root为空不能证明旧/tmp或其他旧路径没有待保全文件。旧容器盘点及持久副本核验完成前不得重建或删除。

## 候选保全待处置

1. 从`file_authoring_candidate_retained`日志及retention.json读取run_id、call_id、logical_call_id、reason、capture_failure、attempt_dir。marker是私有诊断，不是恢复授权；marker写失败仍可能有有效候选。
2. ready=false、unpersisted_results>0、不能finished是保护行为。停止该服务接新模型任务，保留宿主与磁盘；不要强制terminate云实例或删目录获取drain proof。
3. 只读核对原输入版本/hash、run归属、当前租约/终态、模型调用观察、既有私有snapshot/checkpoint。unknown保持unknown，measured保持原值；不要新发模型“检查恢复”。
4. 先为留存的cwd（原输入、scratch、output、operations）做独立持久备份和逐文件SHA-256清单，回读核验。不要把home/codex-home凭据目录混入成果快照，不执行模型写入的脚本。
5. 已有完整snapshot/checkpoint时，走原有可信恢复资格及当前授权。只有本地副本时，先通过有效租约下的可信登记流程核对输入/候选；不得复用旧StageContext或手工伪造checkpoint、provider成功、质量凭据。completed result-store失败有副本不等于已发布正式成果。
6. 持久副本、归属核验、获授权的恢复或明确取消/终止处置都有审计后，才可移出确切的该次attempt目录，禁止批量清空root。inventory归零后再查ready、drain、调用次数、用量、预留和任务终态。

本轮不新增通用离线导入器或失效lease后台flush。受控登记尚不可执行时，保留副本及节点阻断并登记工具待办，不能用删除副本换节点回收。明确用户取消也不自动赋予上传或续跑权限。

## 渲染与下载

`word_renderer_preflight_failed`在intent前记录run/logical call与受控原因。区分缺renderer、native失败、/proc限制、权限/依赖、缺PDF、坏PDF与超时。用宿主已安装包和合成稿复验，不开放宿主/proc给模型，不把缓存Pages当实测。最终正文总量和真实页数70%门禁继续执行。

下载按download_id、run_id、artifact_id、version和metadata/binary request ID关联API，查看phase、received_bytes、elapsed_ms、completed与timeout类别。EOF、hash完成和交给浏览器分开；最后者不证明磁盘落盘。没有旧客户端记录时不反推原下载精确停点。

重试下载读取既有成果，不重新生成。缓存每次命中仍校验授权和可信ETag+size；HEAD失败、版本变化或hash不符保持拒绝。浏览器未自动保存可点击已验证字节的显式保存链接；过期后重新申请下载。
