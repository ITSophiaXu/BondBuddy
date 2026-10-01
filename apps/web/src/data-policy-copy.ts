import type { DataPolicy } from '@bondbuddy/contracts';

// #6 product copy. Every number comes from GET /api/v1/data-policy (server config shared with the purge
// jobs); an unconfigured window is stated as unconfigured, never guessed. Never claim browser-only storage.
const window = (value: number | null, unit: string, unset: string) => value === null ? unset : `${value} ${unit}`;

export function dataPolicyCopy(policy: DataPolicy) {
  const purge = policy.purge_enabled
    ? `删除后立即无法访问，原件以及解析证据、OCR 结果、Word 成果和提示词快照等衍生内容会在 ${window(policy.deleted_content_purge_days, '天', '')}内从平台存储中清理`
    : '删除后立即无法访问；自动清理时限尚未配置，配置后会在这里显示';
  const backup = policy.backup_retention_days === null
    ? '备份保留期尚未配置，配置前不对备份删除时限作出承诺。'
    : `平台备份最长保留 ${policy.backup_retention_days} 天，过期自动删除；从备份恢复时会重新执行删除记录，已删除的内容不会重新出现。`;
  return {
    processing: '你上传的文件会传到平台服务器，保存在账号隔离的私有云存储中，并在服务端完成类型与完整性校验、内容解析、必要的 OCR 以及你发起的任务。完成任务所需的内容会由服务器发送给平台配置的模型服务商处理。模型密钥只保存在服务器，不会进入浏览器；私人材料不会默认加入共享参考库。浏览器中的文件不是唯一副本。',
    retention: `材料、解析结果和成果会一直保留，直到你删除材料、删除项目或注销账号。未完成保存的临时上传${window(policy.orphan_upload_purge_hours, '小时', '（清理时限尚未配置）')}后清理。任务日志中的提示词和模型返回内容最长保留 ${policy.log_content_retention_days} 天。`,
    deletion: `在项目页的“项目材料”中点“删除”可删除单份材料；点页面右上方的“删除项目”可删除整个项目及其全部材料和成果；在“账号设置”中可注销账号。${purge}。仍在执行中的任务正在读取的材料，会在任务结束后再清理；有任务执行时不能删除项目。为了审计和费用核对，平台会保留文件哈希与大小、任务状态、模型调用次数与用量等不含文件内容的记录。你已下载到本机的文件不受平台删除影响。`,
    backup
  };
}
