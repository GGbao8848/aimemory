'use strict';

/**
 * 设备身份：让每条归档数据自述"来自哪台机器"。
 *
 * 为什么必须有：一台员工机器有多个 agent、一个员工有多台机器。只按 agent 归类
 * 无法回答"另一台机器做了什么"——必须让数据携带 (设备码, 设备信息, agent) 三元组。
 *
 * 设备码 = 稳定标识（`dev_` + 8 hex），首次运行生成后落盘到状态目录，之后不变。
 * 即使主机名改了、IP 换了，仍是同一台设备（反之换机器必然换码，不会混淆）。
 * label 默认取主机名，可用 AIMEMORY_DEVICE_LABEL 改成人类可读的名字（如"我的笔记本"）。
 *
 * 注意：设备码不绑定密钥。同一台机器换 Token 重装后仍是同一设备码（只要状态目录还在），
 * 这样历史归档不会因为换密钥而被割裂成两台设备。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEVICE_FILE = 'device.json';
const COLLECTOR_VERSION = '1.0.0';

function deviceFilePath(stateDir) {
  return path.join(stateDir, DEVICE_FILE);
}

/** 采集设备静态信息（用于服务端归类与排查，不含任何凭据） */
function collectDeviceInfo() {
  let username = '';
  try { username = os.userInfo().username; } catch { /* 容器内可能取不到 */ }
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    os_release: os.release(),
    node: process.version,
    cpus: os.cpus() ? os.cpus().length : null,
    mem_gb: Math.round(os.totalmem() / 1024 ** 3),
    user: username,
    collector_version: COLLECTOR_VERSION,
  };
}

/**
 * 读取（或首次生成）设备身份。
 * @returns {{code:string, label:string, first_seen:string, info:object}}
 */
function loadOrCreateDevice(stateDir, { deviceCode, deviceLabel } = {}) {
  const file = deviceFilePath(stateDir);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }

  const code = deviceCode || (saved && saved.code) || `dev_${crypto.randomBytes(4).toString('hex')}`;
  const label = deviceLabel || (saved && saved.label) || os.hostname();
  const firstSeen = (saved && saved.first_seen) || new Date().toISOString();

  const device = { code, label, first_seen: firstSeen, info: collectDeviceInfo() };

  // 落盘（含 label 覆盖时也要写回，便于 --status 显示）
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(device, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 状态目录不可写时仍可用（设备码本次运行有效，重启会重新生成 → 记为不同设备）
  }
  return device;
}

module.exports = { loadOrCreateDevice, collectDeviceInfo, deviceFilePath, DEVICE_FILE, COLLECTOR_VERSION };
