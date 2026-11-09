# Codex 原文件编制容器

当前固定 Codex 0.167.0 的命名权限需要 bubblewrap。Docker 默认 seccomp 禁止创建 user namespace，默认 AppArmor 禁止 mount；不能用只读材料 MCP 或完整访问替代本次所需的原生文件编制。

`codex-seccomp.json` 基于 Moby 官方 `moby/profiles@2ceae35d351c156cb5a8efc0fdc4a08cf94569d8` 的 `seccomp/default.json`（Apache-2.0），只追加非特权 user namespace 的 clone 和 unshare/mount/umount2/pivot_root/chroot/sethostname/setdomainname/setns。保留其余默认系统调用规则，clone3 仍保持原默认 ENOSYS。

`codex-apparmor.profile` 来自同一版本 `apparmor/template.go`（Apache-2.0），展开标准 imports/profile 字段；将禁止所有 mount 改为允许 mount/pivot_root，以便 bubblewrap 在新的非特权 user namespace 内搭建只读运行环境。其余 /proc、/sys、网络族等禁止规则保留。容器仍 **cap_drop ALL、no-new-privileges、只读根目录**，没有宿主 Docker socket，未启用 privileged/unconfined。宿主 namespace 的挂载仍受内核 capability 检查拒绝。

部署前由管理员加载：`sudo apparmor_parser -r deploy/m1/security/codex-apparmor.profile`。生产 Compose 只给 worker 使用此 profile，API/ops 等不变。持久安装时将该准确版本置于 `/etc/apparmor.d/bondbuddy-codex-v1`，保留旧文件用于回滚。权限 profile 不存在时 Docker 启动失败，不能默默取消它。

Codex 内部权限进一步限定到本次任务的原件只读及 scratch/output 可写，禁用命令网络，隐藏其他目录及 /proc。每次实际供应商调用前跑相同权限的真实读写/网络拒绝探针，失败不调用模型。原始输入、知识及成果 hash 另外检查。验证须包括原件不能写、同容器相邻目录与凭据不能读、网络不能访问、可读材料和可写输出、取消终止整个进程组；仅检查配置文本不算通过。

这只改变受限文件工具运行环境，不改变模型/供应商、支付、业务事实或 Word 质量门禁。
