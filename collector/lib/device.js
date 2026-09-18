'use strict';

/**
 * 设备身份：让每条归档数据自述"来自哪台机器"，并让同一台机器在重装/换 Token 后
 * 仍是同一个设备（这是"统一设备"的核心诉求）。
 *
 * 两级标识，各司其职：
 *   1. **设备码 device_code**（`dev_xxxxxxxx`）：归档路径与归类的主键，不透明。
 *   2. **机器指纹 fingerprint**（`fp_xxxxxxxxxxxxxxxx`）：从机器固有属性推导，用于
 *      把"同一台机器"认回来——即使状态目录被删、设备码重新随机生成，服务端凭指纹
 *      仍能把它归到原设备，不会重复建一台。
 *
 * 指纹取值优先级（越靠前越稳）：
 *   1. OS 安装标识 —— Linux `/etc/machine-id`、macOS `IOPlatformUUID`、Windows `MachineGuid`。
 *      与网卡无关，插拔网线/切换 WiFi 都不变。
 *   2. 物理网卡 MAC —— 排序后取第一个，排除虚拟接口（docker/veth/br-/virbr/tun/tap/vmnet…）
 *      与全零/组播/本地管理地址。
 *   3. 主机名 —— 最弱，仅当上面都拿不到。
 *   4. 随机 —— 兜底，退化成"每次重装都是新设备"。
 *
 * 为什么不单用 MAC：多网卡时顺序不固定、笔记本 WiFi/有线切换会换 MAC、容器与虚拟机的
 * MAC 常被重置、MAC 也可被改。machine-id 更稳，故为首选；MAC 作为跨平台兜底。
 *
 * 隐私：**原始 MAC / machine-id 绝不外传**，出机器前先加盐哈希（pseudonymization）。
 * 服务端只见到 `fp_` 开头的哈希，不持有机器硬件标识本身。
 *
 * ⚠️ 已知边界：克隆的虚拟机镜像可能 machine-id 与主机名都相同 → 会被认成同一台设备。
 * 此时用 AIMEMORY_DEVICE_CODE 显式指定设备码来区分。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DEVICE_FILE = 'device.json';
const COLLECTOR_VERSION = '1.1.0';

// 加盐哈希：防止用彩虹表反推 MAC（MAC 空间不大）。此盐非密钥，
// 目的是"不存可被直接使用的硬件标识"，属假名化而非加密。
const FP_SALT = 'aimemory-l0-device-v1';

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

// ===== 机器固有标识 =====

/** OS 安装标识（最稳）：Linux /etc/machine-id、macOS IOPlatformUUID、Windows MachineGuid */
function readOsMachineId() {
  const platform = process.platform;
  try {
    if (platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        const v = fs.readFileSync(p, 'utf8').trim();
        if (v) return v;
      }
    } else if (platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 3000, encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m && m[1]) return m[1];
    } else if (platform === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        timeout: 3000, encoding: 'utf8',
      });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m && m[1]) return m[1];
    }
  } catch { /* 权限/命令缺失 → 交给下一级兜底 */ }
  return null;
}

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|utun|awdl|llw|bridge|zt|tailscale)/i;

/** 全零、组播、本地管理地址都不适合作为机器的稳定标识 */
function isUsableMac(mac) {
  if (!mac || mac === '00:00:00:00:00:00') return false;
  const first = parseInt(mac.slice(0, 2), 16);
  if (Number.isNaN(first)) return false;
  if (first & 0x01) return false; // 组播位
  if (first & 0x02) return false; // 本地管理位（随机化 MAC 常置此位）
  return true;
}

/**
 * 物理网卡 MAC：排序后取第一个，保证多次运行结果一致（不受接口枚举顺序影响）。
 *
 * 注意 `os.networkInterfaces()` **不列出已 down 的接口**——只从它取会让"换根网线
 * （活动网卡变了）"改变指纹。Linux 上补扫 `/sys/class/net`（含 down 接口与物理网卡
 * 判定），拿全所有候选再排序取第一个，指纹才稳定。
 */
function readPhysicalMac() {
  const macs = [];

  // Linux：/sys/class/net 列出全部接口（含 down），且有 device 软链可判物理网卡
  if (process.platform === 'linux') {
    try {
      for (const name of fs.readdirSync('/sys/class/net')) {
        if (VIRTUAL_IFACE.test(name)) continue;
        // 无 device 软链 = 虚拟接口（bridge/veth 等），跳过
        if (!fs.existsSync(`/sys/class/net/${name}/device`)) continue;
        const mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim().toLowerCase();
        if (isUsableMac(mac)) macs.push(mac);
      }
    } catch { /* 权限/平台差异 → 落到下面的通用路径 */ }
  }

  // 通用兜底：os.networkInterfaces()（非 Linux 平台的主要来源）
  if (!macs.length) {
    try {
      const ifaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces || {})) {
        if (VIRTUAL_IFACE.test(name)) continue;
        for (const a of addrs || []) {
          if (a.internal) continue;
          if (!a.mac || !isUsableMac(a.mac)) continue;
          macs.push(a.mac.toLowerCase());
        }
      }
    } catch { /* 忽略 */ }
  }

  if (!macs.length) return null;
  return [...new Set(macs)].sort()[0];
}

/**
 * 机器指纹：返回 { source, hash }。
 * source 记录来源（machine-id / mac / hostname / random），便于排查与说明；
 * hash 为 `fp_` + 16 hex，可安全外传。
 */
function machineFingerprint() {
  const machineId = readOsMachineId();
  if (machineId) {
    return { source: 'machine-id', hash: hashFingerprint('machine-id', machineId) };
  }
  const mac = readPhysicalMac();
  if (mac) {
    return { source: 'mac', hash: hashFingerprint('mac', mac) };
  }
  const host = os.hostname();
  if (host) {
    return { source: 'hostname', hash: hashFingerprint('hostname', host) };
  }
  return { source: 'random', hash: hashFingerprint('random', crypto.randomBytes(16).toString('hex')) };
}

function hashFingerprint(source, value) {
  return `fp_${crypto.createHash('sha256').update(`${FP_SALT}|${source}|${value}`).digest('hex').slice(0, 16)}`;
}

/**
 * 读取（或首次生成）本机设备身份。
 * @returns {{code:string, label:string, first_seen:string, info:object, fingerprint:string, fingerprint_source:string}}
 */
function loadOrCreateDevice(stateDir, { deviceCode, deviceLabel } = {}) {
  const file = deviceFilePath(stateDir);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }

  const code = deviceCode || (saved && saved.code) || `dev_${crypto.randomBytes(4).toString('hex')}`;
  const label = deviceLabel || (saved && saved.label) || os.hostname();
  const firstSeen = (saved && saved.first_seen) || new Date().toISOString();

  // 指纹每次实时计算（机器固有属性，不缓存）——缓存会让硬件/系统变更后无法察觉
  const fp = machineFingerprint();

  const device = {
    code,
    label,
    first_seen: firstSeen,
    fingerprint: fp.hash,
    fingerprint_source: fp.source,
    info: collectDeviceInfo(),
  };

  persist(stateDir, device);
  return device;
}

/** 记住服务端认回来的权威设备码（指纹命中已有设备时，本地要跟着对齐） */
function adoptDeviceCode(stateDir, code) {
  const file = deviceFilePath(stateDir);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 无文件 */ }
  if (!saved || saved.code === code) return false;
  saved.code = code;
  persist(stateDir, saved);
  return true;
}

function persist(stateDir, device) {
  const file = deviceFilePath(stateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(device, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 状态目录不可写时仍可用（本次运行有效，重启会重算指纹 → 靠指纹仍能认回同一设备）
  }
}

module.exports = {
  loadOrCreateDevice,
  adoptDeviceCode,
  machineFingerprint,
  readOsMachineId,
  readPhysicalMac,
  isUsableMac,
  collectDeviceInfo,
  deviceFilePath,
  DEVICE_FILE,
  COLLECTOR_VERSION,
};
