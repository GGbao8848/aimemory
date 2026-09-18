'use strict';

/**
 * aimemory L0 采集器 · pm2 部署配置。
 *
 * 用法（在仓库根目录）：
 *   pm2 start collector/ecosystem.config.js --only aimemory-collector && pm2 save
 *   pm2 logs aimemory-collector
 *   pm2 delete aimemory-collector
 *
 * 与主服务的关系：本进程只采集「agent 原始会话」并上传到 aimemory 服务端，
 * 不参与 LLM 提炼与 embedding，也不依赖主服务的进程/数据库。
 *
 * 配置来源优先级：本文件 env > 环境变量 > ~/.aimemory-collector/config.json
 * 只需按需修改下面 env 里的 TOKEN / SERVER_URL；其余保持默认即可。
 */
module.exports = {
  apps: [
    {
      name: 'aimemory-collector',
      script: 'collector/index.js',
      cwd: require('path').join(__dirname, '..'),
      instances: 1,
      autorestart: true,
      // 采集器稳态内存很小（队列为空时不驻留大对象）
      max_memory_restart: '300M',
      time: true,
      // 崩溃重启太快会反复失败刷日志，退避 5 秒
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        // ===== 必填 =====
        // 服务端地址（L0 接收端点所在服务）
        AIMEMORY_SERVER_URL: process.env.AIMEMORY_SERVER_URL || 'http://10.10.10.169:18543',
        // 本机令牌：在 Web「接入 Token」页为这台机器单独签发一枚（命名如 collector-<主机名>）
        AIMEMORY_TOKEN: process.env.AIMEMORY_TOKEN || '',
        // ===== 可选 =====
        // 设备可读名（默认取主机名）。多台机器时建议设为"谁的机器"，便于在界面里分辨。
        AIMEMORY_DEVICE_LABEL: process.env.AIMEMORY_DEVICE_LABEL || '',
        // 设备码：缺省自动生成并落盘到状态目录（重启不变）。仅重装且需保持同一身份时才显式固定。
        AIMEMORY_DEVICE_CODE: process.env.AIMEMORY_DEVICE_CODE || '',
        // 要采集哪些 agent（逗号分隔；本机没装的会自动跳过）
        AIMEMORY_COLLECTOR_AGENTS: process.env.AIMEMORY_COLLECTOR_AGENTS || 'codex,claude,zcode',
        // 采集间隔
        AIMEMORY_POLL_MS: process.env.AIMEMORY_POLL_MS || '15000',
        // 是否保留每条的原始数据（L0 作为事实源，建议保留；关掉约省一半体积）
        AIMEMORY_KEEP_RAW: process.env.AIMEMORY_KEEP_RAW || '1',
      },
    },
  ],
};
