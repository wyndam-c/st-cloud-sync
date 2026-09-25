/**
 * 云同步 (Cloud Sync) — SillyTavern 前端扩展 (v3: 增量选项 / 定向同步 / 进度弹窗)
 * UI 壳：配置与动作都走服务端插件 /api/plugins/st-cloud-sync
 *   · 增量同步开关（交给服务端生成 unison profile 的 fastcheck）
 *   · 「按云酒馆同步」「按本地酒馆同步」两个定向按钮（一次性方向覆盖）
 *   · 同步时弹出进度窗：阶段 / 进度条 / 当前文件 / 计数 / 实时日志
 */
(function () {
    'use strict';

    const MODULE = 'st-cloud-sync';
    const API = `/api/plugins/${MODULE}`;
    let pollTimer = null;
    let pollInterval = null;
    let lastRunning = false;
    let pendingManualOpen = false;   // 只对「手动点按钮发起」的同步自动弹窗，自动同步不打扰
    let modalBuilt = false;

    const getCtx = () => SillyTavern.getContext();
    const $el = (id) => document.getElementById(id);

    const DIR_LABEL = {
        both: '双向 ⇄',
        to_local: '☁️ 云端 → 💻 本地',
        to_remote: '💻 本地 → ☁️ 云端',
    };
    const PHASE_LABEL = {
        idle: '就绪',
        spawn: '正在启动 / 连接远端…',
        reconcile: '正在比对文件（扫描差异）…',
        transfer: '正在传输…',
        finalize: '正在收尾…',
        done: '同步完成',
        error: '同步出错',
    };

    async function api(path, { method = 'GET', body } = {}) {
        const headers = getCtx().getRequestHeaders();
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${API}${path}`, {
            method, headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!res.ok) throw new Error(data.error || `${res.status}: ${text.slice(0, 200)}`);
        return data;
    }

    function setStatus(text, cls) {
        const el = $el('stcs_status');
        if (el) { el.textContent = text; el.className = 'stcs-status ' + (cls || ''); }
    }

    function renderLog(lines) {
        const box = $el('stcs_log');
        if (box) { box.textContent = (lines || []).join('\n'); box.scrollTop = box.scrollHeight; }
    }

    function fmtElapsed(ms) {
        const s = Math.max(0, Math.floor((ms || 0) / 1000));
        const m = Math.floor(s / 60);
        return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }

    function fillConfig(c) {
        if (!c) return;
        $el('stcs_host').value = c.remoteHost ?? '';
        $el('stcs_port').value = c.remotePort ?? 22;
        $el('stcs_user').value = c.remoteUser ?? '';
        $el('stcs_rroot').value = c.remoteDataRoot ?? '';
        $el('stcs_lroot').value = c.localDataRoot ?? '';
        $el('stcs_key').value = c.sshKey ?? '';
        $el('stcs_profile').value = c.profile ?? '';
        $el('stcs_dir').value = c.direction ?? 'both';
        $el('stcs_prefer').value = c.prefer ?? 'newer';
        $el('stcs_auto').value = c.autoSyncMinutes ?? 0;
        $el('stcs_incremental').checked = c.incremental !== false;
        $el('stcs_excludes').value = (c.excludes || []).join('\n');
    }

    function collectConfig() {
        return {
            remoteHost: $el('stcs_host').value.trim(),
            remotePort: Number($el('stcs_port').value) || 22,
            remoteUser: $el('stcs_user').value.trim(),
            remoteDataRoot: $el('stcs_rroot').value.trim(),
            localDataRoot: $el('stcs_lroot').value.trim(),
            sshKey: $el('stcs_key').value.trim(),
            profile: $el('stcs_profile').value.trim() || 'st-cloud-sync',
            direction: $el('stcs_dir').value,
            prefer: $el('stcs_prefer').value,
            incremental: !!$el('stcs_incremental').checked,
            autoSyncMinutes: Number($el('stcs_auto').value) || 0,
            excludes: $el('stcs_excludes').value.split('\n').map(s => s.trim()).filter(Boolean),
        };
    }

    // ---------------- 进度弹窗 ----------------

    function buildModal() {
        if (modalBuilt || $el('stcs_modal')) { modalBuilt = true; return; }
        const wrap = document.createElement('div');
        wrap.id = 'stcs_modal';
        wrap.className = 'stcs-modal';
        wrap.style.display = 'none';
        wrap.innerHTML = `
<div class="stcs-modal-card">
  <div class="stcs-modal-head">
    <b>云同步进度</b>
    <span class="stcs-modal-dir" id="stcs_m_dir"></span>
    <span class="stcs-modal-spacer"></span>
    <span class="stcs-elapsed" id="stcs_m_elapsed"></span>
  </div>
  <div class="stcs-modal-body">
    <div class="stcs-phase" id="stcs_m_phase">准备中…</div>
    <div class="stcs-bar"><div class="stcs-bar-fill" id="stcs_m_bar"></div></div>
    <div class="stcs-cur" id="stcs_m_cur"></div>
    <div class="stcs-counters">
      <span>已完成 <b id="stcs_m_done">0</b></span>
      <span>传输 <b id="stcs_m_tr">—</b></span>
      <span>跳过 <b id="stcs_m_sk">—</b></span>
      <span>失败 <b id="stcs_m_fail">—</b></span>
      <span class="stcs-pct" id="stcs_m_pct"></span>
    </div>
    <div class="stcs-inuse-note" id="stcs_m_inuse_note" style="display:none"></div>
    <div class="stcs-summary" id="stcs_m_sum"></div>
    <div class="stcs-log" id="stcs_m_log"></div>
  </div>
  <div class="stcs-modal-foot">
    <div class="menu_button stcs-danger" id="stcs_m_abort">中止同步</div>
    <span class="stcs-modal-spacer"></span>
    <div class="menu_button" id="stcs_m_hide">后台运行</div>
    <div class="menu_button" id="stcs_m_close">关闭</div>
  </div>
</div>`;
        document.body.appendChild(wrap);
        wrap.addEventListener('click', (e) => { if (e.target === wrap) hideModal(); });
        $el('stcs_m_hide').addEventListener('click', hideModal);
        $el('stcs_m_close').addEventListener('click', hideModal);
        $el('stcs_m_abort').addEventListener('click', async () => {
            try {
                await api('/abort', { method: 'POST', body: {} });
                toastr.warning('已请求中止同步');
            } catch (e) { toastr.error('中止失败：' + e.message); }
        });
        modalBuilt = true;
    }

    function showModal(s) {
        buildModal();
        const m = $el('stcs_modal');
        if (m) m.style.display = 'flex';
        if (s) renderProgress(s);
    }

    function hideModal() {
        const m = $el('stcs_modal');
        if (m) m.style.display = 'none';
        pendingManualOpen = false;   // 主人主动关掉，就别再自动弹
    }

    function renderProgress(s) {
        if (!modalBuilt) return;
        const p = (s && s.progress) || {};
        const running = !!(s && s.running);

        const dirEl = $el('stcs_m_dir');
        if (dirEl) dirEl.textContent = DIR_LABEL[p.direction || (s && s.config && s.config.direction) || 'both'] || '';

        const phaseEl = $el('stcs_m_phase');
        const phase = p.phase || (running ? 'reconcile' : 'idle');
        if (phaseEl) {
            phaseEl.textContent = PHASE_LABEL[phase] || phase;
            phaseEl.className = 'stcs-phase ' + (phase === 'error' ? 'stcs-bad' : phase === 'done' ? 'stcs-ok' : '');
        }

        const bar = $el('stcs_m_bar');
        if (bar) {
            const pct = p.percent;
            bar.classList.toggle('stcs-indeterminate', running && (pct === null || pct === undefined));
            bar.classList.toggle('stcs-bar-done', phase === 'done');
            bar.classList.toggle('stcs-bar-error', phase === 'error');
            bar.style.width = (pct === null || pct === undefined) ? (phase === 'done' ? '100%' : '100%') : `${pct}%`;
        }

        const pctEl = $el('stcs_m_pct');
        if (pctEl) pctEl.textContent = (p.percent === null || p.percent === undefined) ? '' : `${p.percent}%`;

        const cur = $el('stcs_m_cur');
        if (cur) {
            const c = p.current || '';
            cur.textContent = c ? ('当前：' + c) : '';
            cur.title = c;
        }

        const set = (id, v) => { const e = $el(id); if (e) e.textContent = (v === null || v === undefined) ? '—' : String(v); };
        const inUse = Number(p.inUse) || 0;
        // 真失败 = 总失败 - 因文件被占用而跳过的（后者不算故障）
        const rawFail = Number(p.failed) || 0;
        const netFail = (p.failedNet === null || p.failedNet === undefined) ? Math.max(0, rawFail - inUse) : Number(p.failedNet);
        const okRun = !running && (phase === 'done' || netFail === 0) && rawFail >= 0;
        set('stcs_m_done', p.finished ?? 0);
        set('stcs_m_tr', p.transferred);
        set('stcs_m_sk', p.skipped);
        set('stcs_m_fail', netFail);

        const note = $el('stcs_m_inuse_note');
        if (note) {
            if (inUse > 0) {
                const names = (p.inUseFiles || []).slice(0, 3).join('、');
                note.style.display = '';
                note.textContent = `🟡 另有 ${inUse} 个文件正在被酒馆使用（${names}${(p.inUseFiles || []).length > 3 ? ' 等' : ''}），已跳过，下一轮会自动补上`;
            } else {
                note.style.display = 'none';
                note.textContent = '';
            }
        }

        const el = $el('stcs_m_elapsed');
        if (el) el.textContent = running ? ('已用 ' + fmtElapsed(p.elapsedMs)) : (p.elapsedMs ? ('耗时 ' + fmtElapsed(p.elapsedMs)) : '');

        const sum = $el('stcs_m_sum');
        if (sum) {
            const tail = inUse > 0 ? `（${inUse} 个文件被占用，下轮自动补）` : '';
            if (okRun) {
                sum.className = 'stcs-summary ' + (inUse > 0 ? 'stcs-warn' : 'stcs-ok');
                const icon = netFail > 0 ? '⚠️' : '✅';
                sum.textContent = `${icon} 同步完成：传输 ${p.transferred ?? 0} / 跳过 ${p.skipped ?? 0} / 失败 ${netFail}${tail}`;
            } else if (phase === 'done' || phase === 'error') {
                const hasCounts = p.transferred !== null && p.transferred !== undefined;
                if (hasCounts) {
                    sum.className = 'stcs-summary stcs-warn';
                    sum.textContent = `⚠️ 同步结束：传输 ${p.transferred} / 跳过 ${p.skipped ?? 0} / 失败 ${netFail}${tail}（详见下方日志）`;
                } else {
                    sum.className = 'stcs-summary stcs-bad';
                    sum.textContent = '⚠️ 同步出错' + (p.error ? '：' + p.error : '') + '（详见下方日志）';
                }
            } else {
                sum.className = 'stcs-summary';
                sum.textContent = '';
            }
        }

        const log = $el('stcs_m_log');
        if (log) {
            const lines = (s && s.log ? s.log : []).slice(-200);
            log.textContent = lines.join('\n');
            log.scrollTop = log.scrollHeight;
        }

        const abortBtn = $el('stcs_m_abort');
        if (abortBtn) abortBtn.style.display = running ? '' : 'none';
    }

    // ---------------- 状态轮询 ----------------

    async function refresh() {
        try {
            const s = await api('/status');
            if (s.startedAt) window.__stcs_startedAt = s.startedAt;

            if (s.running) setStatus(`⏳ 正在同步（${DIR_LABEL[(s.progress || {}).direction || s.config.direction] || ''}）… 开始于 ${s.startedAt || ''}`, 'stcs-busy');
            else if (s.exitCode === 0) setStatus(`✅ 上次同步完成（${s.endedAt || '—'}）`, 'stcs-ok');
            else if (s.exitCode !== null && s.exitCode !== undefined) {
                const sp = s.progress || {};
                const inUse = Number(sp.inUse) || 0;
                const netFail = (sp.failedNet === null || sp.failedNet === undefined) ? Math.max(0, (Number(sp.failed) || 0) - inUse) : Number(sp.failedNet);
                if (netFail === 0 && inUse > 0) setStatus(`🟡 上次同步完成（${inUse} 个文件被占用跳过，下轮自动补）`, 'stcs-warn');
                else setStatus(`⚠️ 上次同步异常，退出码 ${s.exitCode}`, 'stcs-bad');
            }
            else setStatus('就绪', '');

            if (s.users) $el('stcs_users').textContent = `用户(${s.users.length}): ${s.users.join(', ') || '—'}`;
            renderLog(s.log);

            // 只有手动发起的同步才自动弹出进度窗；自动同步不打扰（可用「查看进度」打开）
            if (s.running && pendingManualOpen) showModal(s);
            if (!s.running && lastRunning) {
                // 刚跑完
                const p = s.progress || {};
                const inUse = Number(p.inUse) || 0;
                const netFail = (p.failedNet === null || p.failedNet === undefined) ? Math.max(0, (Number(p.failed) || 0) - inUse) : Number(p.failedNet);
                const tail = inUse > 0 ? `（${inUse} 个文件被占用，下轮自动补）` : '';
                if (s.exitCode === 0 || (netFail === 0 && inUse > 0)) {
                    if (inUse > 0) toastr.warning(`云同步完成：传输 ${p.transferred ?? 0} / 跳过 ${p.skipped ?? 0}；${inUse} 个文件正在使用被跳过，下轮自动补上`);
                    else toastr.success(`云同步完成：传输 ${p.transferred ?? 0} / 跳过 ${p.skipped ?? 0} / 失败 ${netFail}`);
                } else {
                    toastr.warning(`云同步结束：${netFail} 项失败，退出码 ${s.exitCode}${tail}`);
                }
                if ($el('stcs_modal') && $el('stcs_modal').style.display !== 'none') renderProgress(s);
            }
            if (s.running) {
                if ($el('stcs_modal') && $el('stcs_modal').style.display !== 'none') renderProgress(s);
                startPoll(1200);
            } else {
                pendingManualOpen = false;
                startPoll(4000);
            }
            lastRunning = !!s.running;
            return s;
        } catch (e) {
            setStatus(`⚠️ 无法连接服务端插件：${e.message}`, 'stcs-bad');
            return null;
        }
    }

    function startPoll(interval) {
        if (pollTimer && pollInterval === interval) return;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!$el('stcs_status')) { clearInterval(pollTimer); pollTimer = null; pollInterval = null; return; }
            refresh();
        }, interval);
        pollInterval = interval;
    }

    async function act(label, fn) {
        try {
            setStatus(`⏳ ${label}…`, 'stcs-busy');
            await fn();
            await refresh();
        } catch (e) {
            setStatus(`⚠️ ${label}失败：${e.message}`, 'stcs-bad');
        }
    }

    async function syncNow(direction, label) {
        try {
            await api('/sync', { method: 'POST', body: direction ? { direction } : {} });
            pendingManualOpen = true;      // 手动发起：弹进度窗
            toastr.success(`已开始${label || '同步'}`);
            await refresh();
        } catch (e) {
            toastr.error(`${label || '同步'}启动失败：${e.message}`);
            await refresh();
        }
    }

    function buildHtml() {
        return `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>云同步 (Cloud Sync · 双向/增量)</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="stcs-status" id="stcs_status">加载中…</div>
    <div class="stcs-users" id="stcs_users"></div>
    <div class="stcs-row"><label>远端主机</label><input type="text" id="stcs_host"></div>
    <div class="stcs-row"><label>端口</label><input type="number" id="stcs_port" style="max-width:120px"></div>
    <div class="stcs-row"><label>远端用户</label><input type="text" id="stcs_user"></div>
    <div class="stcs-row"><label>远端 data 根</label><input type="text" id="stcs_rroot"></div>
    <div class="stcs-row"><label>本地 data 根</label><input type="text" id="stcs_lroot"></div>
    <div class="stcs-row"><label>SSH 私钥</label><input type="text" id="stcs_key"></div>
    <div class="stcs-row"><label>同步方向</label>
      <select id="stcs_dir">
        <option value="both">双向（默认）</option>
        <option value="to_local">单向：云端 → 本地</option>
        <option value="to_remote">单向：本地 → 云端</option>
      </select>
    </div>
    <div class="stcs-row"><label>冲突策略</label>
      <select id="stcs_prefer">
        <option value="newer">较新者赢</option>
        <option value="local">本地赢</option>
        <option value="remote">云端赢</option>
      </select>
    </div>
    <div class="stcs-row">
      <label>增量同步</label>
      <label class="checkbox_label" style="flex:1" title="勾选=按大小+修改时间快速判断，只传变化（快）；取消=全量内容校验，最保险但更慢">
        <input type="checkbox" id="stcs_incremental"> <span style="font-size:.85em;opacity:.8">快速增量（只传变化）</span>
      </label>
    </div>
    <div class="stcs-row"><label>profile 名</label><input type="text" id="stcs_profile"></div>
    <div class="stcs-row"><label>自动同步(分钟)</label><input type="number" id="stcs_auto" min="0" style="max-width:120px"><span style="opacity:.7;font-size:.85em">0=关闭</span></div>
    <div class="stcs-row"><label>排除项(每行一个)</label><textarea id="stcs_excludes" rows="3" style="flex:1 1 200px"></textarea></div>
    <div class="stcs-btns">
      <div class="menu_button" id="stcs_save">保存配置</div>
      <div class="menu_button" id="stcs_test">测试连接</div>
      <div class="menu_button" id="stcs_show">查看进度</div>
    </div>
    <div class="stcs-btns">
      <div class="menu_button stcs-cloud" id="stcs_sync_cloud" title="以云端为准，把云酒馆的数据同步下来覆盖本地">☁️ 按云酒馆同步</div>
      <div class="menu_button stcs-local" id="stcs_sync_local" title="以本地为准，把本地数据推到云酒馆">💻 按本地酒馆同步</div>
      <div class="menu_button" id="stcs_sync" title="按上面「同步方向」的设置同步">立即同步(按设置)</div>
      <div class="menu_button" id="stcs_abort">中止</div>
    </div>
    <div class="stcs-log" id="stcs_log"></div>
  </div>
</div>`;
    }

    async function init() {
        if ($el('stcs_status') || !document.getElementById('extensions_settings')) return;
        $('#extensions_settings').append(buildHtml());
        buildModal();

        $el('stcs_save').addEventListener('click', () => act('保存配置', async () => {
            await api('/config', { method: 'POST', body: collectConfig() });
            toastr.success('配置已保存（profile 已重写）');
        }));
        $el('stcs_test').addEventListener('click', () => act('测试连接', async () => {
            const r = await api('/test', { method: 'POST' });
            toastr[r.ok ? 'success' : 'error'](r.ok ? `OK: ${r.stdout.split('\n')[0]}` : '连接失败');
        }));
        $el('stcs_show').addEventListener('click', () => { pendingManualOpen = true; refresh(); showModal(null); refresh(); });
        $el('stcs_sync_cloud').addEventListener('click', () => syncNow('to_local', '「按云酒馆同步」'));
        $el('stcs_sync_local').addEventListener('click', () => syncNow('to_remote', '「按本地酒馆同步」'));
        $el('stcs_sync').addEventListener('click', () => syncNow(null, '同步'));
        $el('stcs_abort').addEventListener('click', () => act('中止', () => api('/abort', { method: 'POST', body: {} })));

        const s = await refresh();
        if (s && s.config) fillConfig(s.config);
        startPoll(4000);
    }

    jQuery(async () => { await init(); });
})();
