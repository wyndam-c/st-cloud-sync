/**
 * 云同步 (Cloud Sync) — SillyTavern 前端扩展 (v2 双向/多用户)
 * UI 壳：配置与动作都走服务端插件 /api/plugins/st-cloud-sync
 */
(function () {
    'use strict';

    const MODULE = 'st-cloud-sync';
    const API = `/api/plugins/${MODULE}`;
    let pollTimer = null;

    const getCtx = () => SillyTavern.getContext();
    const $el = (id) => document.getElementById(id);

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
            autoSyncMinutes: Number($el('stcs_auto').value) || 0,
            excludes: $el('stcs_excludes').value.split('\n').map(s => s.trim()).filter(Boolean),
        };
    }

    async function refresh() {
        try {
            const s = await api('/status');
            if (s.running) setStatus(`⏳ 正在双向同步… 开始于 ${s.startedAt || ''}`, 'stcs-busy');
            else if (s.exitCode === 0) setStatus(`✅ 上次同步完成（${s.endedAt || '—'}）`, 'stcs-ok');
            else if (s.exitCode !== null && s.exitCode !== undefined) setStatus(`⚠️ 上次同步异常，退出码 ${s.exitCode}`, 'stcs-bad');
            else setStatus('就绪', '');
            if (s.users) $el('stcs_users').textContent = `用户(${s.users.length}): ${s.users.join(', ') || '—'}`;
            renderLog(s.log);
            return s;
        } catch (e) {
            setStatus(`⚠️ 无法连接服务端插件：${e.message}`, 'stcs-bad');
            return null;
        }
    }

    function startPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!$el('stcs_status')) { clearInterval(pollTimer); pollTimer = null; return; }
            refresh();
        }, 3000);
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

    function buildHtml() {
        return `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>云同步 (Cloud Sync · 双向)</b>
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
    <div class="stcs-row"><label>profile 名</label><input type="text" id="stcs_profile"></div>
    <div class="stcs-row"><label>自动同步(分钟)</label><input type="number" id="stcs_auto" min="0" style="max-width:120px"><span style="opacity:.7;font-size:.85em">0=关闭</span></div>
    <div class="stcs-row"><label>排除项(每行一个)</label><textarea id="stcs_excludes" rows="3" style="flex:1 1 200px"></textarea></div>
    <div class="stcs-btns">
      <div class="menu_button" id="stcs_save">保存配置</div>
      <div class="menu_button" id="stcs_test">测试连接</div>
      <div class="menu_button" id="stcs_sync">立即同步</div>
      <div class="menu_button" id="stcs_abort">中止</div>
    </div>
    <div class="stcs-log" id="stcs_log"></div>
  </div>
</div>`;
    }

    async function init() {
        if (!$el('stcs_status') && document.getElementById('extensions_settings')) {
            $('#extensions_settings').append(buildHtml());

            $el('stcs_save').addEventListener('click', () => act('保存配置', async () => {
                await api('/config', { method: 'POST', body: collectConfig() });
                toastr.success('配置已保存（profile 已重写）');
            }));
            $el('stcs_test').addEventListener('click', () => act('测试连接', async () => {
                const r = await api('/test', { method: 'POST' });
                toastr[r.ok ? 'success' : 'error'](r.ok ? `OK: ${r.stdout.split('\n')[0]}` : '连接失败');
            }));
            $el('stcs_sync').addEventListener('click', () => act('同步', async () => {
                await api('/sync', { method: 'POST', body: {} });
                toastr.success('已开始同步');
            }));
            $el('stcs_abort').addEventListener('click', () => act('中止', () => api('/abort', { method: 'POST', body: {} })));

            const s = await refresh();
            if (s && s.config) fillConfig(s.config);
            startPoll();
        }
    }

    jQuery(async () => { await init(); });
})();
