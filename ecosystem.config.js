'use strict';

/**
 * pm2 部署配置
 * 用法: pm2 start ecosystem.config.js && pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'aimemory-mcp',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
