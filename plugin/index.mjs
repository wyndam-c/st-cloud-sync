/**
 * ST Cloud Sync — SillyTavern 服务端插件 (v2: 双向 / 多用户)
 *
 * 作用：在「云端酒馆」和「本地酒馆」之间**双向**同步整个 data 目录
 *      （多用户：data/ 下所有用户目录一并覆盖）。
 * 引擎：Unison over SSH（rsync 无法安全双向）。
 * 零第三方运行时依赖（node 内置模块 + 系统 unison/ssh）。
 *
 * 路由（挂载在 /api/plugins/st-cloud-sync 下）：
 *   GET  /status   状态 + 配置 + 用户列表 + 日志
 *   GET  /config   读取配置
 *   POST /config   保存配置（同时重写 unison profile）
 *   POST /test     测试 SSH + 远端 unison
 *   POST /sync     开始同步  body: { }
 *   POST /abort    中止
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'st-cloud-sync',
    name: 'ST Cloud Sync',
    description: 'Bidirectional sync of the whole SillyTavern data dir (all users) between this instance and a remote one, via Unison over SSH.',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'last-sync.log');

const DEFAULT_CONFIG = {
    enabled: true,
    profile: 'st-cloud-sync',                                   // unison profile 名
    unicmd: 'unison',
    localDataRoot: '/root/SillyTavern/data',
    remoteUser: 'root',
    remoteHost: '',                                          // 必填：远端 IP / 域名
    remotePort: 22,
    remoteDataRoot: '/root/SillyTavern/data',
    sshKey: '/root/.ssh/cloud_sync_ed25519',
    direction: 'both',          // both | to_local | to_remote
    prefer: 'newer',            // newer | local | remote
    excludes: ['cookie-secret.txt', 'access.log', 'content.log', '_cache', '_css', '_webpack', '_errors', '_storage', 'node_modules', 'backups', 'extensions'],
    autoSyncMinutes: 10,
};

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function persistConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

let config = loadConfig();

const state = {
    running: false,
    proc: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    log: [],
    timer: null,
};

function logLine(line) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    state.log.push(`[${ts}] ${line}`);
    if (state.log.length > 3000) state.log.splice(0, state.log.length - 3000);
    try { fs.appendFileSync(LOG_PATH, `[${ts}] ${line}\n`); } catch { /* ignore */ }
}

function profilePath() {
    return path.join(os.homedir(), '.unison', `${config.profile}.prf`);
}

function remoteRoot() {
    const rp = String(config.remoteDataRoot).replace(/^\/+/, '');   // 去掉前导斜杠避免出现三个斜杠
    return `ssh://${config.remoteUser}@${config.remoteHost}//${rp}`;
}

/** 依据配置生成 unison profile；未配置远端主机则返回 null */
function writeProfile() {
    if (!config.remoteHost) {
        logLine('未配置远端主机，跳过生成 profile。请在面板填写「远端主机」后保存。');
        return null;
    }
    const lines = [];
    lines.push('# 由 ST Cloud Sync 插件自动生成，勿手改（改配置会覆盖）');
    lines.push(`root = ${config.localDataRoot}`);
    lines.push(`root = ${remoteRoot()}`);
    lines.push(`sshargs = -i ${config.sshKey} -p ${config.remotePort} -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new`);
    lines.push('batch = true');
    lines.push('auto = true');
    lines.push('log = false');
    lines.push('copyonconflict = true');
    lines.push('backup = Name *');

    if (config.prefer === 'local') {
        lines.push(`prefer = ${config.localDataRoot}`);
    } else if (config.prefer === 'remote') {
        lines.push(`prefer = ${remoteRoot()}`);
    } else {
        lines.push('prefer = newer');
    }

    if (config.direction === 'to_local') {
        lines.push(`force = ${remoteRoot()}`);   // 远端为准 → 单向到本地
    } else if (config.direction === 'to_remote') {
        lines.push(`force = ${config.localDataRoot}`);
    }

    for (const ex of (config.excludes || [])) {
        const e = String(ex).trim();
        if (e) lines.push(`ignore = Name ${e}`);
    }
    lines.push('ignore = Name .unison');
    lines.push('ignore = Name *.tmp');

    const p = profilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 });
    return p;
}

function listUsers() {
    try {
        return fs.readdirSync(config.localDataRoot, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
            .map(d => d.name)
            .sort();
    } catch {
        return [];
    }
}

function sanitize(line) {
    const t = String(line).replace(/\r/g, '').trim();
    if (!t) return null;
    if (/^\d+%/.test(t)) return null;              // 进度条
    if (/ETA$/.test(t) && /\d+%/.test(t)) return null;
    if (/^Starting\.\.\.$/.test(t)) return null;
    return t;
}

function startSync() {
    if (state.running) throw new Error('已有同步任务在进行中');
    if (!config.remoteHost) throw new Error('请先在面板配置「远端主机」');
    const prf = writeProfile();
    const args = [config.profile, '-batch'];
    logLine(`开始双向同步 (profile=${config.profile}, prefer=${config.prefer}, direction=${config.direction})`);
    logLine(`profile: ${prf}`);

    state.running = true;
    state.startedAt = new Date().toISOString();
    state.endedAt = null;
    state.exitCode = null;

    const child = spawn(config.unicmd, args, { cwd: os.homedir(), env: process.env });
    state.proc = child;

    const handle = (buf) => {
        for (const raw of buf.toString().split(/\r|\n/)) {
            const line = sanitize(raw);
            if (line) logLine(line);
        }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
        logLine(`启动 unison 失败: ${err.message}`);
        state.running = false; state.proc = null;
        state.endedAt = new Date().toISOString(); state.exitCode = -1;
    });
    child.on('close', (code) => {
        state.running = false; state.proc = null;
        state.endedAt = new Date().toISOString(); state.exitCode = code;
        logLine(code === 0 ? '✅ 同步完成' : `⚠️ 同步结束，退出码 ${code}`);
    });

    return { started: true, profile: prf, args };
}

function scheduleAutoSync() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    const minutes = Number(config.autoSyncMinutes) || 0;
    if (minutes > 0 && config.enabled) {
        state.timer = setInterval(() => {
            if (state.running) return;
            try { startSync(); } catch (e) { logLine(`自动同步跳过: ${e.message}`); }
        }, minutes * 60 * 1000);
        logLine(`已开启定时自动同步：每 ${minutes} 分钟`);
    }
}

function testConnection() {
    const target = `${config.remoteUser}@${config.remoteHost}`;
    const sshArgs = ['-i', config.sshKey, '-p', String(config.remotePort),
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new'];
    const r = spawnSync('ssh', [...sshArgs, target, 'hostname; unison -version'], { encoding: 'utf8', timeout: 30000 });
    const local = spawnSync(config.unicmd, ['-version'], { encoding: 'utf8', timeout: 10000 });
    return {
        ok: r.status === 0,
        status: r.status,
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || '').trim(),
        localUnison: (local.stdout || '').trim(),
    };
}

export async function init(router) {
    router.use(express.json({ limit: '1mb' }));
    logLine('插件已加载 (v2 双向/多用户)');
    if (!fs.existsSync(CONFIG_PATH)) { try { persistConfig(); } catch { /* ignore */ } }
    try { writeProfile(); } catch (e) { logLine(`写 profile 失败: ${e.message}`); }
    scheduleAutoSync();

    router.get('/status', (_req, res) => {
        res.json({
            ok: true,
            running: state.running,
            startedAt: state.startedAt,
            endedAt: state.endedAt,
            exitCode: state.exitCode,
            users: listUsers(),
            config,
            log: state.log.slice(-300),
        });
    });

    router.get('/config', (_req, res) => res.json({ ok: true, config }));

    router.post('/config', (req, res) => {
        const body = req.body || {};
        const next = { ...config };
        for (const key of Object.keys(DEFAULT_CONFIG)) {
            if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = body[key];
        }
        next.remotePort = Number(next.remotePort) || 22;
        next.autoSyncMinutes = Number(next.autoSyncMinutes) || 0;
        if (!Array.isArray(next.excludes)) {
            next.excludes = String(next.excludes || '').split('\n').map(s => s.trim()).filter(Boolean);
        }
        config = next;
        persistConfig();
        let prf = '';
        try { prf = writeProfile(); } catch (e) { logLine(`写 profile 失败: ${e.message}`); }
        scheduleAutoSync();
        logLine('配置已更新');
        res.json({ ok: true, config, profile: prf });
    });

    router.post('/test', (_req, res) => {
        const result = testConnection();
        logLine(`测试连接: ${result.ok ? 'OK' : '失败'} ${result.stdout || result.stderr}`);
        res.json(result);
    });

    router.post('/sync', (_req, res) => {
        try {
            res.json({ ok: true, ...startSync() });
        } catch (e) {
            res.status(409).json({ ok: false, error: e.message });
        }
    });

    router.post('/abort', (_req, res) => {
        if (state.proc) {
            try { state.proc.kill('SIGTERM'); } catch { /* ignore */ }
            logLine('已请求中止同步');
            res.json({ ok: true, aborted: true });
        } else {
            res.json({ ok: true, aborted: false });
        }
    });
}

export function exit() {
    if (state.timer) clearInterval(state.timer);
    if (state.proc) { try { state.proc.kill('SIGTERM'); } catch { /* ignore */ } }
}
