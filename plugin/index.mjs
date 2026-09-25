/**
 * ST Cloud Sync — SillyTavern 服务端插件 (v3: 增量选项 / 定向同步 / 进度上报)
 *
 * 作用：在「云端酒馆」和「本地酒馆」之间**双向**同步整个 data 目录
 *      （多用户：data/ 下所有用户目录一并覆盖）。
 * 引擎：Unison over SSH（rsync 无法安全双向）。
 * 零第三方运行时依赖（node 内置模块 + 系统 unison/ssh）。
 *
 * 路由（挂在 /api/plugins/st-cloud-sync 下）：
 *   GET  /status   状态 + 配置 + 用户列表 + 日志 + 进度
 *   GET  /config   读取配置
 *   POST /config   保存配置（同时重写 unison profile）
 *   POST /test     测试 SSH + 远端 unison
 *   POST /sync     开始同步  body: { direction?: 'both'|'to_local'|'to_remote' }
 *                  direction 为「一次性方向覆盖」：本次同步按它走，不改动保存的配置，
 *                  跑完会把 profile 恢复成配置里的方向。
 *   POST /abort    中止
 *
 * 配置项新增：
 *   incremental (bool)  增量同步：true=按「大小+时间」快速判断，只传变化（默认，快）；
 *                       false=关掉 fastcheck，按内容校验做全量比对（慢但最保险）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 安装布局兼容：
 *  A) 普通安装 —— 只有 index.mjs 被复制到 <ST>/plugins/st-cloud-sync/（不是 git 仓库，不能自更新）
 *  B) --git 安装 —— 整个仓库 clone 到 <ST>/plugins/st-cloud-sync/，
 *     根目录带一个未跟踪的 index.mjs 转发壳（酒馆入口），本文件位于 <PLUG>/plugin/index.mjs，
 *     config.json / last-sync.log 也跟着住在 plugin/ 下（仓库 .gitignore 已排除）。
 */
/** 找到 git 仓库根（可能是本目录，也可能是上一层；没有则返回空串）。每次现算，避免加载时定死。 */
function repoDir() {
    try {
        if (fs.existsSync(path.join(__dirname, '.git'))) return __dirname;
        const up = path.dirname(__dirname);
        if (fs.existsSync(path.join(up, '.git'))) return up;
    } catch { /* ignore */ }
    return '';
}

/** extension/ 三件套的源目录（优先仓库里的那份） */
function extSrcDir() {
    const repo = repoDir();
    if (repo && fs.existsSync(path.join(repo, 'extension'))) return path.join(repo, 'extension');
    return path.join(__dirname, 'extension');
}

export const info = {
    id: 'st-cloud-sync',
    name: 'ST Cloud Sync',
    version: '1.2.0',
    description: 'Bidirectional sync of the whole SillyTavern data dir (all users) between this instance and a remote one, via Unison over SSH.',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'last-sync.log');
const LOG_MAX_BYTES = 4 * 1024 * 1024;   // last-sync.log 超出后只保留尾部，避免无限膨胀

const DIRECTIONS = ['both', 'to_local', 'to_remote'];

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
    incremental: true,          // true=快速增量判断 / false=全量内容校验
    updateBranch: 'main',       // 从哪个分支拉插件新版本
    autoUpdateCheckMinutes: 0,  // 0=关；>0 = 每隔 N 分钟检查一次插件更新
    autoUpdate: false,          // true=发现新版自动 git pull（仍需重启酒馆生效）
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

/** 进度快照（给前端弹窗用） */
const progress = {
    active: false,
    phase: 'idle',          // idle | spawn | reconcile | transfer | finalize | done | error
    direction: 'both',
    current: '',
    itemPercent: null,      // 当前文件百分比（0-100）
    started: 0,             // [BGN] 计数
    finished: 0,            // [END] 计数
    expected: 0,            // 比对阶段数出来的「预期项目数」（用于估算总进度）
    transferred: null,
    skipped: null,
    failed: null,
    inUse: 0,               // 因「文件正在被酒馆使用」而跳过的项（不算真失败）
    inUseFiles: [],
    error: '',
    beganAt: null,
    endedAt: null,
};

function resetProgress(direction) {
    progress.active = true;
    progress.phase = 'spawn';
    progress.direction = direction || config.direction || 'both';
    progress.current = '';
    progress.itemPercent = null;
    progress.started = 0;
    progress.finished = 0;
    progress.expected = 0;
    progress.transferred = null;
    progress.skipped = null;
    progress.failed = null;
    progress.inUse = 0;
    progress.inUseFiles = [];
    progress.error = '';
    progress.beganAt = new Date().toISOString();
    progress.endedAt = null;
}

function logLine(line) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    state.log.push(`[${ts}] ${line}`);
    if (state.log.length > 3000) state.log.splice(0, state.log.length - 3000);
    try {
        fs.appendFileSync(LOG_PATH, `[${ts}] ${line}\n`);
        const st = fs.statSync(LOG_PATH);
        if (st.size > LOG_MAX_BYTES) {
            const fd = fs.openSync(LOG_PATH, 'r');
            const keep = 512 * 1024;
            const buf = Buffer.alloc(keep);
            fs.readSync(fd, buf, 0, keep, st.size - keep);
            fs.closeSync(fd);
            fs.writeFileSync(LOG_PATH, '……（日志超过 4MB，已截断保留末尾）\n' + buf.toString('utf8'));
        }
    } catch { /* ignore */ }
    return undefined;
}

function profilePath() {
    return path.join(os.homedir(), '.unison', `${config.profile}.prf`);
}

function remoteRoot() {
    const rp = String(config.remoteDataRoot).replace(/^\/+/, '');   // 去掉前导斜杠避免出现三个斜杠
    return `ssh://${config.remoteUser}@${config.remoteHost}//${rp}`;
}

/**
 * 依据配置生成 unison profile 内容（纯函数，便于测试）。
 * directionOverride：本次运行的方向覆盖（可选，不写回配置）
 */
function buildProfileText(directionOverride) {
    if (!config.remoteHost) return null;
    const direction = DIRECTIONS.includes(directionOverride) ? directionOverride : config.direction;
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

    // 增量开关：fastcheck=true 只比大小+时间（快）；false 走内容校验（慢但稳）
    lines.push(`fastcheck = ${config.incremental === false ? 'false' : 'true'}`);

    if (direction === 'to_local') {
        lines.push(`force = ${remoteRoot()}`);   // 远端为准 → 单向到本地
    } else if (direction === 'to_remote') {
        lines.push(`force = ${config.localDataRoot}`);
    }

    for (const ex of (config.excludes || [])) {
        const e = String(ex).trim();
        if (e) lines.push(`ignore = Name ${e}`);
    }
    lines.push('ignore = Name .unison');
    lines.push('ignore = Name *.tmp');
    return lines.join('\n') + '\n';
}

/** 写 profile；未配置远端主机则跳过 */
function writeProfile(directionOverride) {
    const text = buildProfileText(directionOverride);
    if (!text) {
        logLine('未配置远端主机，跳过生成 profile。请在面板填写「远端主机」后保存。');
        return null;
    }
    const p = profilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, { mode: 0o600 });
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

/**
 * 解析 unison 的一行输出，更新进度对象（纯函数式：只改传入的 pr）。
 * 需要重点识别的行：
 *   " 37%  00:02 ETA"                          当前文件百分比
 *   "[BGN] Copying xxx from A to B"            开始处理某项
 *   "[END] Copying xxx"                        某项处理完
 *   "Unison ... started propagating changes"   进入传输阶段
 *   "Unison ... finished propagating changes"  传输结束
 *   "Synchronization complete at ... (N items transferred, M skipped, K failed)"
 *   "<---- new dir xxx" / "----> changed xxx"  比对决策（用来估总数）
 */
function parseProgressLine(pr, rawLine) {
    if (!pr) return;
    const t = String(rawLine).replace(/\r/g, '').trim();
    if (!t) return;

    const pct = t.match(/^(\d{1,3})%/);
    if (pct) {
        pr.itemPercent = Number(pct[1]);
        return;
    }

    if (/^\[BGN\]/.test(t)) {
        pr.started += 1;
        pr.current = t.replace(/^\[BGN\]\s*/, '');
        if (pr.phase !== 'transfer') pr.phase = 'transfer';
        return;
    }
    if (/^\[END\]/.test(t)) {
        pr.finished += 1;
        pr.itemPercent = null;
        return;
    }
    if (/started propagating changes/i.test(t)) {
        pr.phase = 'transfer';
        return;
    }
    if (/finished propagating changes/i.test(t)) {
        pr.phase = 'finalize';
        return;
    }

    const done = t.match(/Synchronization (?:complete|incomplete) at .*?\((\d+)\s+items?\s+transferred,\s*(\d+)\s+skipped,\s*(\d+)\s+failed\)/i);
    if (done) {
        pr.transferred = Number(done[1]);
        pr.skipped = Number(done[2]);
        pr.failed = Number(done[3]);
        pr.phase = 'done';
        return;
    }

    // 文件在同步过程中被改（几乎都是主人正在用酒馆）——unison 主动放弃，不算真失败
    const failedItem = t.match(/^Failed \[(.+?)\]/);
    if (failedItem) {
        pr._failFile = failedItem[1];
        return;
    }
    if (/has been modified during synchronization/i.test(t)) {
        pr.inUse = (pr.inUse || 0) + 1;
        if (pr._failFile) pr.inUseFiles.push(pr._failFile);
        pr._failFile = null;
        return;
    }

    if (/^(changed\b|new file\b|new dir\b|deleted\b|conflict\b|new props\b|props\b|partially transferred\b|failed\b|[<>]-{2,}|-{2,}>)/i.test(t)) {
        pr.expected += 1;
        if (pr.phase === 'idle' || pr.phase === 'spawn') pr.phase = 'reconcile';
    }
}

/** 估算总进度（0-100）；返回 null 表示总量未知（前端显示不确定进度） */
function progressPercent(pr) {
    if (!pr) return null;
    if (pr.phase === 'done') return 100;
    const expected = Math.max(pr.expected, pr.started, pr.finished);
    if (expected <= 0) return null;
    const frac = pr.finished + (pr.itemPercent ? pr.itemPercent / 100 : 0);
    return Math.max(0, Math.min(99, Math.round((frac / expected) * 100)));
}

function progressSnapshot() {
    const began = progress.beganAt ? Date.parse(progress.beganAt) : null;
    const ended = progress.endedAt ? Date.parse(progress.endedAt) : null;
    const snap = { ...progress };
    delete snap._failFile;
    const inUse = Number(snap.inUse) || 0;
    const failed = Number(snap.failed) || 0;
    // 扣掉「文件正在使用」的那些，剩下的才是真失败
    snap.failedNet = Math.max(0, failed - inUse);
    return {
        ...snap,
        percent: progressPercent(progress),
        elapsedMs: began ? ((ended || Date.now()) - began) : 0,
    };
}

function startSync(directionOverride) {
    if (state.running) throw new Error('已有同步任务在进行中');
    if (!config.remoteHost) throw new Error('请先在面板配置「远端主机」');
    const direction = DIRECTIONS.includes(directionOverride) ? directionOverride : config.direction;
    const prf = writeProfile(direction);
    if (!prf) throw new Error('无法生成 unison profile（远端主机未配置）');

    resetProgress(direction);
    const dirLabel = direction === 'to_local' ? '云端→本地' : direction === 'to_remote' ? '本地→云端' : '双向';
    logLine(`开始同步 [${dirLabel}] (profile=${config.profile}, prefer=${config.prefer}, incremental=${config.incremental !== false})`);
    logLine(`profile: ${prf}`);

    state.running = true;
    state.startedAt = new Date().toISOString();
    state.endedAt = null;
    state.exitCode = null;

    const child = spawn(config.unicmd, [config.profile, '-batch'], { cwd: os.homedir(), env: process.env });
    state.proc = child;

    const handle = (buf) => {
        for (const raw of buf.toString().split(/\r|\n/)) {
            parseProgressLine(progress, raw);
            const line = sanitize(raw);
            if (line) logLine(line);
        }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
        logLine(`启动 unison 失败: ${err.message}`);
        progress.phase = 'error';
        progress.error = err.message;
        state.running = false; state.proc = null;
        state.endedAt = new Date().toISOString(); state.exitCode = -1;
        progress.endedAt = state.endedAt;
    });
    child.on('close', (code) => {
        state.running = false; state.proc = null;
        state.endedAt = new Date().toISOString(); state.exitCode = code;
        progress.endedAt = state.endedAt;
        if (code === 0) {
            if (progress.phase !== 'done') progress.phase = 'done';
            logLine('✅ 同步完成');
        } else {
            progress.phase = 'error';
            if (!progress.error) progress.error = `unison 退出码 ${code}`;
            const inUse = Number(progress.inUse) || 0;
            const failed = Number(progress.failed) || 0;
            if (inUse > 0 && failed - inUse <= 0) {
                progress.phase = 'done';
                logLine(`✅ 同步完成（${inUse} 个文件正在被酒馆使用，已跳过，下一轮自动补上）`);
            } else {
                logLine(`⚠️ 同步结束，退出码 ${code}`);
            }
        }
        // 若本次是「一次性方向覆盖」，把 profile 恢复成配置里的方向
        if (DIRECTIONS.includes(directionOverride)) {
            try { writeProfile(); } catch (e) { logLine(`恢复 profile 失败: ${e.message}`); }
        }
    });

    return { started: true, profile: prf, direction };
}

// ---------------- 自动更新（从 GitHub 拉取插件新版本） ----------------

let updateTimer = null;

const UPDATE_STATE = {
    isGit: false,                   // 当前安装是不是 git 工作区
    runningVersion: info.version,   // 内存里正在跑的版本
    diskVersion: '',                // 磁盘/仓库上的版本
    branch: '',
    head: '',
    latest: '',
    behind: null,                   // 落后多少个提交；null=未知
    subject: '',                    // 远端最新提交标题
    checkedAt: null,
    updating: false,
    error: '',
    lastResult: null,
};

/** 在插件目录里跑一条 git 命令 */
function runGit(args, timeoutMs = 30000) {
    const dir = repoDir();
    if (!dir) return { ok: false, code: -1, out: '', err: '不是 git 安装' };
    const r = spawnSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return {
        ok: r.status === 0,
        code: r.status,
        out: (r.stdout || '').trim(),
        err: (r.stderr || '').trim(),
    };
}

function isGitRepo() {
    return !!repoDir();
}

/** 从某个 git 引用里读出 extension/manifest.json 的 version */
function versionAt(ref) {
    const r = runGit(['show', `${ref}:extension/manifest.json`], 15000);
    if (!r.ok) return '';
    try { return String(JSON.parse(r.out).version || ''); } catch { return ''; }
}

function checkUpdate() {
    UPDATE_STATE.runningVersion = info.version;
    UPDATE_STATE.checkedAt = new Date().toISOString();
    UPDATE_STATE.error = '';
    UPDATE_STATE.isGit = isGitRepo();
    if (!UPDATE_STATE.isGit) {
        UPDATE_STATE.behind = null;
        UPDATE_STATE.latest = '';
        UPDATE_STATE.diskVersion = '';
        return { ...UPDATE_STATE };
    }

    const branch = config.updateBranch || 'main';
    UPDATE_STATE.branch = branch;
    UPDATE_STATE.diskVersion = versionAt('HEAD');

    const fetch = runGit(['fetch', '--quiet', '--no-tags', 'origin', branch], 60000);
    if (!fetch.ok) {
        UPDATE_STATE.error = (fetch.err || fetch.out || 'git fetch 失败').split('\n')[0];
        UPDATE_STATE.behind = null;
        return { ...UPDATE_STATE };
    }

    const remote = `origin/${branch}`;
    const head = runGit(['rev-parse', 'HEAD']);
    const count = runGit(['rev-list', '--count', `HEAD..${remote}`]);
    const subj = runGit(['log', '-1', '--format=%s', remote]);
    UPDATE_STATE.head = head.ok ? head.out.slice(0, 8) : '';
    UPDATE_STATE.behind = count.ok ? Number(count.out) : null;
    UPDATE_STATE.subject = subj.ok ? subj.out : '';
    UPDATE_STATE.latest = versionAt(remote);
    return { ...UPDATE_STATE };
}

/** 找出装了本扩展的目录（各用户扩展目录 + 全局第三方目录） */
function findExtensionDirs() {
    const out = [];
    const dataRoot = config.localDataRoot || '';
    if (!dataRoot || !fs.existsSync(dataRoot)) return out;
    try {
        for (const ent of fs.readdirSync(dataRoot, { withFileTypes: true })) {
            if (!ent.isDirectory()) continue;
            const d = path.join(dataRoot, ent.name, 'extensions', 'st-cloud-sync');
            if (fs.existsSync(path.join(d, 'manifest.json'))) out.push(d);
        }
    } catch { /* ignore */ }
    try {
        const g = path.join(path.dirname(dataRoot), 'public', 'scripts', 'extensions', 'third-party', 'st-cloud-sync');
        if (fs.existsSync(path.join(g, 'manifest.json'))) out.push(g);
    } catch { /* ignore */ }
    return out;
}

/** 插件代码更新后，把 extension/ 三件套刷到各扩展目录（否则浏览器还是旧界面） */
function syncExtensionFiles() {
    const src = extSrcDir();
    if (!src || !fs.existsSync(src)) return { dirs: 0 };
    let dirs = 0;
    for (const d of findExtensionDirs()) {
        for (const f of ['index.js', 'style.css', 'manifest.json']) {
            const s = path.join(src, f);
            if (!fs.existsSync(s)) continue;
            try { fs.copyFileSync(s, path.join(d, f)); } catch (e) { logLine(`同步扩展文件失败 ${f}: ${e.message}`); }
        }
        dirs += 1;
    }
    return { dirs };
}

function doUpdate() {
    if (UPDATE_STATE.updating) throw new Error('正在更新中，请稍候');
    if (!isGitRepo()) throw new Error('当前不是 git 安装，无法自动更新（跑一次 ./install.sh --git 即可）');
    UPDATE_STATE.updating = true;
    try {
        const before = runGit(['rev-parse', 'HEAD']).out.slice(0, 8) || '';
        const pull = runGit(['pull', '--ff-only', 'origin', config.updateBranch || 'main'], 180000);
        if (!pull.ok) {
            UPDATE_STATE.error = (pull.err || pull.out || 'git pull 失败').split('\n')[0];
            return { ok: false, error: UPDATE_STATE.error, before };
        }
        const after = runGit(['rev-parse', 'HEAD']).out.slice(0, 8) || '';
        const ext = syncExtensionFiles();
        const result = {
            ok: true,
            before,
            after,
            updated: before !== after,
            extDirs: ext.dirs,
            restartRequired: before !== after,
        };
        UPDATE_STATE.lastResult = result;
        logLine(`插件更新: ${before} → ${after}${before === after ? '（已是最新）' : ''}${ext.dirs ? `，扩展文件已刷到 ${ext.dirs} 处` : ''}`);
        checkUpdate();
        return result;
    } finally {
        UPDATE_STATE.updating = false;
    }
}

function scheduleUpdateCheck() {
    if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
    const minutes = Number(config.autoUpdateCheckMinutes) || 0;
    if (minutes > 0 && config.enabled) {
        updateTimer = setInterval(() => {
            try {
                const r = checkUpdate();
                if (r.behind > 0) {
                    logLine(`🆕 插件有新版本 ${r.latest || ''}（落后 ${r.behind} 个提交）${config.autoUpdate ? '，自动更新中…' : '，可在面板一键更新'}`);
                    if (config.autoUpdate) {
                        try { doUpdate(); logLine('自动更新完成，请重启酒馆生效'); } catch (e) { logLine(`自动更新失败: ${e.message}`); }
                    }
                }
            } catch { /* 静默：网络不通不该刷日志 */ }
        }, minutes * 60 * 1000);
        logLine(`已开启插件更新检查：每 ${minutes} 分钟`);
    }
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
    logLine('插件已加载 (v3 增量/定向/进度)');
    if (!fs.existsSync(CONFIG_PATH)) { try { persistConfig(); } catch { /* ignore */ } }
    try { writeProfile(); } catch (e) { logLine(`写 profile 失败: ${e.message}`); }
    scheduleAutoSync();
    scheduleUpdateCheck();
    // 启动后延时自查一次（不阻塞启动；失败就静默）
    setTimeout(() => {
        try {
            const u = checkUpdate();
            if (u.isGit && u.behind > 0) logLine(`🆕 插件有新版本 ${u.latest || ''}（落后 ${u.behind} 个提交），可在面板一键更新`);
        } catch { /* 静默 */ }
    }, 20000);

    router.get('/status', (_req, res) => {
        res.json({
            ok: true,
            running: state.running,
            startedAt: state.startedAt,
            endedAt: state.endedAt,
            exitCode: state.exitCode,
            users: listUsers(),
            config,
            progress: progressSnapshot(),
            update: { ...UPDATE_STATE },
            log: state.log.slice(-400),
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
        next.incremental = next.incremental !== false && next.incremental !== 'false';
        next.autoUpdate = next.autoUpdate === true || next.autoUpdate === 'true';
        next.autoUpdateCheckMinutes = Number(next.autoUpdateCheckMinutes) || 0;
        next.updateBranch = String(next.updateBranch || 'main').trim() || 'main';
        if (!Array.isArray(next.excludes)) {
            next.excludes = String(next.excludes || '').split('\n').map(s => s.trim()).filter(Boolean);
        }
        config = next;
        persistConfig();
        let prf = '';
        try { prf = writeProfile(); } catch (e) { logLine(`写 profile 失败: ${e.message}`); }
        scheduleAutoSync();
        scheduleUpdateCheck();
        logLine('配置已更新');
        res.json({ ok: true, config, profile: prf });
    });

    router.post('/test', (_req, res) => {
        const result = testConnection();
        logLine(`测试连接: ${result.ok ? 'OK' : '失败'} ${result.stdout || result.stderr}`);
        res.json(result);
    });

    router.post('/sync', (req, res) => {
        const body = req.body || {};
        const dir = DIRECTIONS.includes(body.direction) ? body.direction : undefined;
        try {
            res.json({ ok: true, ...startSync(dir) });
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

    router.get('/update', (_req, res) => res.json({ ok: true, update: { ...UPDATE_STATE } }));

    router.post('/update/check', (_req, res) => {
        try {
            const u = checkUpdate();
            logLine(`检查插件更新: ${!u.isGit ? '非 git 安装' : u.error ? u.error : u.behind > 0 ? `有新版本 ${u.latest || ''}（落后 ${u.behind}）` : '已是最新'}`);
            res.json({ ok: true, update: u });
        } catch (e) {
            res.json({ ok: false, error: e.message, update: { ...UPDATE_STATE } });
        }
    });

    router.post('/update/apply', (_req, res) => {
        try {
            res.json({ ok: true, ...doUpdate() });
        } catch (e) {
            res.status(409).json({ ok: false, error: e.message });
        }
    });
}

export function exit() {
    if (state.timer) clearInterval(state.timer);
    if (updateTimer) clearInterval(updateTimer);
    if (state.proc) { try { state.proc.kill('SIGTERM'); } catch { /* ignore */ } }
}

/** 仅供离线自测使用的内部钩子（不影响插件运行） */
export const __internal = {
    progress,
    resetProgress,
    parseProgressLine,
    progressPercent,
    progressSnapshot,
    buildProfileText,
    startSync,
    loadConfig,
    checkUpdate,
    doUpdate,
    UPDATE_STATE,
    findExtensionDirs,
    syncExtensionFiles,
    get config() { return config; },
    setConfig(c) { config = c; },
};
