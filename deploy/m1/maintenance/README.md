# 每日安全磁盘维护

Refs #1304。维护资产独立安装，不更换应用镜像、配置或数据库。系统 timer 每日北京时间 03:20 执行一次，低 CPU/IO 优先级；程序总限时100秒、systemd 服务上限120秒。错过时间不补跑。

默认只删除 APT archives 中的普通单链接 `.deb` 下载缓存，以及最后真实日志记录超过30天的已归档 journal。保留 active journal、近30天日志和其他审计目录。APT 使用与包管理器相同的 POSIX 下载缓存锁。目录各层拒绝软链，文件发生替换或出现硬链接时保留。

不遍历或删除业务材料、数据库、对象存储、成果、备份、任务临时目录、恢复检查点、模型会话、代码工作区、Docker 卷与容器。不截断活动容器日志，不清理归属不明的构建缓存。不按任务目录时间判断是否可删。

## 安装与执行

将 `deploy/m1/maintenance/` 交付到运维目录，以 `policy.example.json` 为起点准备 root 所有、不可被普通用户写入的私有 policy。

```sh
sudo python3 disk-maintenance.py --policy /etc/bondbuddy-maintenance/policy.json
sudo python3 disk-maintenance.py --policy /etc/bondbuddy-maintenance/policy.json --apply
sudo python3 install-maintenance.py --policy /etc/bondbuddy-maintenance/policy.json
systemctl list-timers bondbuddy-disk-maintenance.timer
```

`--apply` 缺省时为 dry-run，输出候选或保留原因。输出只包含维护元数据，不含认证、业务文件内容或环境变量。空余变化是前后文件系统实测的净值，可能包含同期其他活动；镜像逻辑大小不能等同于实际回收量。

## 可选的准确旧镜像候选

镜像默认不开启自动发现或删除。仅将人工核实归属的**完整不可变 image ID**和预期标签加入 `image_candidates`，不使用 tag、dangling 或时间判断归属。完整保护集合应包含所有容器引用，以及 current、previous、pending、rollback 和其他明确保留的镜像。未知一律保护。

镜像删除还要求 `protection_inventory_complete=true`、非空 `protected_images`、部署锁（配置锁在前、部署锁在后）和 `guards`。文件 guard 校验准确 SHA256；目录 guard 校验完整直接子项清单；不存在项以 absent guard 保护。发布记录、组件 pending／回滚记录、保护清单必须覆盖，不能只登记当前镜像。源记录或目录变化即跳过镜像清理，重新核验后才能更换 root policy。

持锁后逐候选重新校验保护记录和所有容器，包括已停止容器。仅调用 `docker image rm <完整ID>`，不 force、不 prune；若并发出现新引用或 Docker 拒绝则保留。候选清单用完后每日继续安全的 APT／journal 维护，不自动扩大到新镜像。

## 停用与恢复

```sh
sudo python3 install-maintenance.py --disable
```

停用只关闭未来 timer；正在执行的维护仍按自身限时收尾。安装前像保存在 `/var/lib/bondbuddy-maintenance/install-backups/`，保留原字节、权限和不存在事实。需要恢复资产时先停用 timer，按 `before.json` 恢复准确文件（原来不存在的仅移除本次维护资产），再 `systemctl daemon-reload`；应用无需重启。已删除的缓存无需恢复，旧镜像必须先确认可重建或有可靠镜像归档，不能把业务备份当缓存。

## 验证

```sh
python3 -m unittest discover -s deploy/m1/maintenance/tests -v
```

回归覆盖真实进程间锁、软链／硬链及替换、dry-run／幂等、容器与回滚镜像保护、清单读取失败、未知归属、发布漂移与新增引用、准确非 force 删除，以及按日志真实记录时间保留。生产验收另核 timer enabled／下次执行时间、一次 apply 的前后余量和全部保护资源一致。
