// ==UserScript==
// @name         DNF挂机助手
// @namespace    http://tampermonkey.net/
// @version      5.82
// @description  挂机统计浮窗（首次默认左上角、折叠胶囊可拖动/左右贴边吸附并记忆位置、窄屏自适应不溢出；设置面板移动端完整可见可滚动）+ 掉落/技能日志 + 怪物血条线性百分比（5 位小数精度，百万血不再卡住不动）+ HP/MP 血条修复 + 打造跳转修复 + 仓库装备/仓库材料置顶 + 背包详情「存仓」按钮（锁定装备也可存）+ 仓库装备「点击先看详情、再确认取出」（取消不发请求）+ 仓库材料「自选数量取出」（默认整组、超限回填、取消不发请求）+ 通关秘宝盒「按批全开」（每批 10 个、批间约 120ms、可停止）+ 游戏红字同步提示（监听游戏 .error，把文案用插件原样式贴顶提示）+ 屏蔽游戏自带挂机浮窗（可开关）+ 联网检查更新（只提示不执行，点击跳转下载页；设置面板可手动检查/关闭自动检查；新用户名地址失败时自动回退旧用户名地址）。
// @author       You
// @match        *://shileshihu.cn/*
// @match        *://www.shileshihu.cn/*
// @icon         https://shileshihu.cn/favicon.ico
// @updateURL    https://cdn.jsdelivr.net/gh/1694385621/DNF-js@main/dnf-helper.js
// @downloadURL  https://cdn.jsdelivr.net/gh/1694385621/DNF-js@main/dnf-helper.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Shared fixed-window dragging. Size changes never rewrite the saved anchor.
    const floatingWindows = new Map();
    function positionFloating(el, pos, dock) {
        if (!el.dataset.floatWidth) el.dataset.floatWidth=String(el.offsetWidth || 220);
        // v5.70：夹紧时用元素的真实渲染宽度（折叠胶囊 149px / 展开 220px），
        // 不再固定为首次记录的宽度，否则折叠态拖不到右侧边缘。
        // 展开/折叠刚切换的同一帧里 getBoundingClientRect 可能还是旧宽度，
        // 所以优先读显式 style.width（HUD 展开态是 220px，折叠态是 auto）。
        const styleWidth=parseFloat(el.style.width);
        const measured=el.getBoundingClientRect().width || Number(el.dataset.floatWidth) || 220;
        const width=Math.min(styleWidth>0?styleWidth:measured,Math.max(80,innerWidth-16));
        const margin=8;
        let left;
        if (dock === 'left') left = margin;
        else if (dock === 'right') left = Math.max(0, innerWidth - width - margin);
        // v5.78：自由位置也强制左右各留 8px，拖到边缘松手不会贴出视口
        else left = Math.max(margin, Math.min(Number(pos.left)||0, Math.max(margin, innerWidth - width - margin)));
        const top = Math.max(0, Math.min(Number(pos.top)||0, Math.max(0, innerHeight - 48)));
        Object.assign(el.style, {position:'fixed', left:left+'px', top:top+'px', right:'auto', bottom:'auto', transform:'none',
            maxHeight:Math.max(40, innerHeight-top-8)+'px', boxSizing:'border-box',animation:'none'});
    }
    function makeFloatingDraggable(el, handle, key, initial, persist) {
        for(const node of floatingWindows.keys())if(!node.isConnected)floatingWindows.delete(node);
        if (floatingWindows.has(el)) return;
        let pos = initial || {left:8,top:8};
        // v5.70：HUD 记录吸附侧（left/right），窗口尺寸或折叠宽度变化时按侧贴边；
        // 其它浮窗保持原有的自由坐标持久化。
        let dock = (key==='hud' && initial && (initial.dock==='left'||initial.dock==='right')) ? initial.dock : null;
        if (key !== 'hud') {
            try { const saved=JSON.parse(localStorage.getItem('dnf_float_'+key));
                if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) pos=saved;
            } catch (_) {}
        }
        positionFloating(el,pos,dock);
        floatingWindows.set(el,()=>positionFloating(el,pos,dock));
        handle.style.cursor='move'; handle.style.touchAction='none'; handle.style.userSelect='none'; handle.style.flexShrink='0';
        let active=null, suppressUntil=0;
        // 拖动结束后 400ms 内的 click 一律吞掉：折叠态标题栏的「+」、展开态的日志/设置/重置
        // 按钮都挂在标题栏上，必须保证拖动松手不会误触折叠或按钮。
        handle.addEventListener('click',e=>{if(Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
        handle.addEventListener('pointerdown',e=>{
            if(active || e.isPrimary===false || e.button!==0) return;
            const blocked=e.target.closest('button,input,select,a,[data-no-drag],span[title]');
            // 折叠胶囊只有「+」一个按钮，允许从它上面开始拖动（靠位移阈值区分点击/拖动）；
            // 展开态仍保护标题栏里的功能按钮，避免拖动误触。
            const interactiveHandle = !!(blocked && key==='hud' && el.dataset.hudCollapsed==='1');
            if(blocked && !interactiveHandle) return;
            // 折叠胶囊上的「+」既要能拖动、也要能单击折叠：这里不 preventDefault，
            // 保证 click 一定能送达；拖动超过阈值后由 pointermove 接管并吞掉 click。
            if(!interactiveHandle) e.preventDefault();
            const rect=el.getBoundingClientRect();
            active={id:e.pointerId,x:e.clientX,y:e.clientY,left:rect.left,top:rect.top,moved:false};
            handle.setPointerCapture?.(e.pointerId);
        });
        handle.addEventListener('pointermove',e=>{
            if(!active || active.id!==e.pointerId) return;
            const dx=e.clientX-active.x,dy=e.clientY-active.y;
            if(!active.moved && Math.hypot(dx,dy)<4)return;
            active.moved=true;e.preventDefault();
            pos={left:Math.max(0,Math.min(active.left+dx,Math.max(0,innerWidth-80))),top:Math.max(0,Math.min(active.top+dy,Math.max(0,innerHeight-48)))};
            // 拖动过程中按自由坐标走，暂不套用吸附侧
            positionFloating(el,pos);
        });
        const finish=e=>{
            if(!active || (e.pointerId!=null && active.id!==e.pointerId))return;
            const done=active;active=null;
            if(handle.hasPointerCapture?.(done.id))handle.releasePointerCapture(done.id);
            if(done.moved){suppressUntil=Date.now()+400;
                const rect=el.getBoundingClientRect();
                if(key==='hud'){
                    // 距左右边缘 16px 内自动贴边停靠，否则保留自由位置
                    const snap=16;
                    if(rect.left<=snap){dock='left';pos={left:8,top:rect.top};}
                    else if(innerWidth-rect.right<=snap){dock='right';pos={left:Math.max(0,innerWidth-rect.width-8),top:rect.top};}
                    else {dock=null;pos={left:rect.left,top:rect.top};}
                } else {pos={left:rect.left,top:rect.top};}
                if(persist)persist({...pos,dock});
                else try{localStorage.setItem('dnf_float_'+key,JSON.stringify(pos));}catch(_){}
                // v5.78：松手/贴边后立刻按最终坐标重算，确保左右至少留 8px
                positionFloating(el,pos,dock);
            }
        };
        ['pointerup','pointercancel','lostpointercapture'].forEach(type=>handle.addEventListener(type,finish));
    }
    window.addEventListener('resize',()=>{
        for(const [el,update] of floatingWindows){if(el.isConnected)update();else floatingWindows.delete(el);}
    });
    let settingsPanelEl=null;

    /** v5.79：设置面板宽度按视口收缩（左右各留 8px），窄屏时水平居中 */
    function settingsPanelLayout() {
        const avail = Math.max(160, Math.floor(innerWidth) - 16);
        const width = Math.min(440, avail);
        const narrow = avail < 560;
        const hudRight = (hudEl && hudEl.getBoundingClientRect().right) || 8;
        const left = narrow
            ? Math.max(8, (Math.floor(innerWidth) - width) / 2)
            : Math.max(8, Math.min(hudRight + 12, innerWidth - width - 8));
        return { avail, width, left, narrow };
    }

    /** 面板尺寸/高度重新计算：内容区滚动、标题栏常驻，底部始终可达 */
    function refreshSettingsPanel() {
        if (!settingsPanelEl || !settingsPanelEl.isConnected) return;
        const { avail, width } = settingsPanelLayout();
        settingsPanelEl.style.boxSizing = 'border-box';
        settingsPanelEl.style.width = width + 'px';
        settingsPanelEl.style.maxWidth = avail + 'px';
        const update = floatingWindows.get(settingsPanelEl);
        if (update) update();
        // 用可视视口（visualViewport 优先）兜底，兼容移动端地址栏/软键盘
        const vh = Math.floor((window.visualViewport && visualViewport.height) || innerHeight);
        const top = settingsPanelEl.getBoundingClientRect().top;
        settingsPanelEl.style.maxHeight = Math.max(120, Math.min(vh - 16, vh - top - 8)) + 'px';
    }

    function toggleSettingsPanel() {
        if(settingsPanelEl?.isConnected){settingsPanelEl.remove();settingsPanelEl=null;settingsOpen=false;return;}
        settingsOpen=true;
        const { avail, width, left } = settingsPanelLayout();
        const panel=document.createElement('section'); settingsPanelEl=panel;
        panel.className='dnf-settings-panel'; panel.setAttribute('aria-label','挂机助手设置');
        panel.style.cssText='position:fixed;z-index:1000001;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;' +
            'width:' + width + 'px;max-width:' + avail + 'px;' +
            // v5.79：100vh 兜底 + 支持 dvh 的浏览器用动态视口高度，避免移动端地址栏遮挡
            'max-height:calc(100vh - 16px);max-height:calc(100dvh - 16px);' +
            'background:#211a13;color:#edddc3;border:1px solid #9b7645;border-radius:12px;' +
            'box-shadow:0 12px 36px #0009;font:13px/1.5 Microsoft YaHei,sans-serif;' +
            'overflow-wrap:anywhere;word-break:break-word;';
        const head=document.createElement('header');
        head.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;padding:12px 16px;background:#302319;border-bottom:1px solid #80613e;';
        head.innerHTML='<div style="min-width:0"><strong style="color:#ffd794;font-size:16px">助手设置</strong><small style="display:block;color:#baa78e">拖动标题栏调整位置 · 更改即时保存</small></div>';
        const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭设置');close.style.cssText='background:none;border:0;color:#dfc79e;font-size:24px;cursor:pointer;flex:0 0 auto;min-width:32px;min-height:32px';close.onclick=toggleSettingsPanel;head.append(close);
        const body=document.createElement('div');body.className='dnf-settings-body';body.style.cssText='padding:12px;overflow-y:auto;overflow-x:hidden;min-height:0;flex:1 1 auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch';
        panel.append(head,body);document.body.append(panel);
        applySettingsPanelResizeHook();
        renderSettingsPanel();
        makeFloatingDraggable(panel,head,'settings',{left:left,top:16});
        refreshSettingsPanel();
    }

    /** 视口变化时重算设置面板（只挂一次） */
    function applySettingsPanelResizeHook() {
        if (window.__dnfSettingsResizeHook579) return;
        window.__dnfSettingsResizeHook579 = true;
        window.addEventListener('resize', refreshSettingsPanel, { passive: true });
        window.addEventListener('orientationchange', () => {
            setTimeout(refreshSettingsPanel, 60);
            setTimeout(refreshSettingsPanel, 300);
        }, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', refreshSettingsPanel, { passive: true });
        }
    }
    function renderSettingsPanel() {
        if(!settingsPanelEl?.isConnected)return;
        const body=settingsPanelEl.querySelector('.dnf-settings-body');
        const options=[['屏蔽挂机浮窗','hideGameAssistant','隐藏游戏原生挂机浮窗/折叠球（可恢复）'],['功能栏下移','relocateTabsAfterSettlement','功能栏放到最近结算下方'],['特性技能过滤','hideUnlearnedSkills','只显示已学前置的特性'],['统一 UI 主题','uiTheme','深色底、金色边框'],['诊断信息','debugHud','显示血条同步状态'],['启动时自动检查更新','autoCheckUpdate','读 version.json，只提示不自动安装']];
        body.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:8px">'+options.map(args=>'<div style="padding:8px 10px;border:1px solid #56422f;border-radius:8px;background:#2b2118">'+renderSettingsRow(...args)+'</div>').join('')+'</div>'+(isMobileLayout()?'<div style="margin-top:12px">'+renderModuleOrderRows()+'</div>':'')+renderUpdateBlock();
        body.querySelectorAll('[data-setkey]').forEach(el=>{el.setAttribute('role','switch');el.tabIndex=0;el.setAttribute('aria-checked',String(CONFIG[el.dataset.setkey]));el.setAttribute('aria-label',options.find(o=>o[1]===el.dataset.setkey)[0]);el.addEventListener('keydown',e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();el.click();}});});
        bindSettingsToggles(body);
    }

    /* ============================================================
     * 配置项
     * ============================================================ */
    const CONFIG = {
        pollInterval: 1000,
        enableLog: true,
        showFloatTip: true,
        // 复活次数 HUD 开关（常驻显示）
        enableReviveHud: true,
        // HUD 停靠角：top-left / top-right / bottom-left / bottom-right
        hudCorner: 'top-right',
        // HUD 拖动后的自由坐标 { left, top }（null = 首次放置于左上角）
        hudPos: null,
        // HUD 吸附侧：'left' / 'right' / null（自由位置）。旧存档没有该字段时按 null 处理。
        hudDock: null,
        // 挂机统计预热时间(ms)：等待这段时间后才开始算"每小时效率/预测升级"，避免样本过小
        statsWarmupMs: 5000,
        // 战斗日志本地存储上限（条）
        battleLogMax: 500,
        // 战斗日志本地存储 key 前缀（v4：按角色隔离）
        battleLogKeyPrefix: 'dnf_battle_log_v4_',
        // 技能统计本地存储 key 前缀（v2：按角色隔离）
        skillStatsKeyPrefix: 'dnf_skill_stats_v2_',
        // 用户设置本地存储 key 前缀（挂机助手 ⚙ 面板里的开关）
        // 最终 key = settingsKeyPrefix + (角色名 || '_default')
        settingsKeyPrefix: 'dnf_user_settings_v2_',
        // ===== 可在 ⚙ 面板切换的功能开关（含默认值）=====
        // 把「功能栏(标签页) + 其下方扩展框」移动到「最近结算」面板之下，默认关
        relocateTabsAfterSettlement: false,
        // HP / MP 血条实时同步：游戏里经验条会随进度增长，但 HP/MP 条
        // 的填充宽度不跟血量走（一直是满格，像贴图）。开启后读条上的
        // 「HP 2878 / 3784」文字反推百分比，强制写回填充层宽度。
        hpBarSync: true,
        // ===== v5.48：性能参数（集中管理，避免散落的魔法数字）=====
        // HP/MP 血条同步轮询间隔(ms)
        hpBarSyncMs: 400,
        // 血条结构未知时的兜底扫描缓存(ms)
        hpBarFallbackScanMs: 5000,
        // 血条首次校验 / 后续校验间隔(ms)
        barCheckFirstMs: 900,
        barCheckEveryMs: 1500,
        // DOM 变化后的轻量扫描去抖(ms)
        lightScanDebounceMs: 300,
        // 本地存储写入节流(ms)，避免战斗中每掉落一行就整包序列化写盘
        storageWriteThrottleMs: 1500,
        // HUD 是否常驻显示诊断信息（血条同步）
        debugHud: false,
        // 移动端六大模块顺序（人物框/状态框/地图怪物框/结算框/日志框/功能框）
        moduleOrder: ['char', 'status', 'dungeon', 'settle', 'log', 'tabs'],
        // 特性技能按前置主动/被动是否已学过滤（主动/被动面板始终全部显示）
        hideUnlearnedSkills: true,
        // 屏蔽游戏自带的「挂机助手」悬浮窗/页面（含折叠后的圆球）；默认开启，
        // 关闭则恢复显示。仅用 CSS 隐藏，不影响游戏逻辑与收益。
        hideGameAssistant: true,
        // 统一游戏 UI 风格：深底 + 金边 + 圆角（与背包标签行一致）
        uiTheme: true,
        // v5.81：启动后自动联网检查更新（只提示，不下载执行脚本）。默认开启。
        autoCheckUpdate: true,
        // 挂机统计 HUD 是否折叠（true=折叠为紧凑胶囊「挂机助手 vX.XX +」，false=展开显示完整分类）。
        // 折叠/展开由标题栏点击切换，状态持久化记忆。
        hudCollapsed: true,
    };

    /** 脚本版本（正文统一引用，升级只需改这里 + @version 元数据） */
    const VERSION = '5.82';

    /**
     * 可持久化的用户设置白名单（只存这些，其它运行期配置不写盘）。
     */
    const SETTING_KEYS = ['relocateTabsAfterSettlement', 'hudCorner', 'hudPos', 'hudDock', 'uiTheme', 'debugHud', 'moduleOrder', 'hideUnlearnedSkills', 'hideGameAssistant', 'hudCollapsed', 'autoCheckUpdate'];

    /** 移动端可自定义上下顺序的六大模块 */
    const MODULE_DEFS = [
        { key: 'char', label: '人物框', sel: '.main .doll-panel' },
        { key: 'status', label: '状态框', sel: '.main .resource-panel' },
        { key: 'dungeon', label: '地图怪物框', sel: '.main .panel.dungeon' },
        { key: 'settle', label: '结算框', sel: '.main .panel.settle' },
        { key: 'log', label: '日志框', sel: '.main .panel.battle-log' },
        { key: 'tabs', label: '功能框', sel: '.main .right-col' },
    ];
    const MODULE_DEFAULT_ORDER = MODULE_DEFS.map(d => d.key);
    const isMobileLayout = () =>
        (typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)').matches : false);

    /** 当前识别到的角色名（null 表示还没进 GameView） */
    let currentCharName = null;

    // ===== 运行时状态 =====
    let bloodBarStatusText = '';       // HUD 上 HP/MP 血条同步的识别状态
    let lastSkillShop = null;          // 最近一次 /skill-shop 返回的 { shop, passive_shop }


    /** 根据当前角色名拼 localStorage key */
    function settingsKeyForChar(name) {
        return CONFIG.settingsKeyPrefix + (name ? name : '_default');
    }
    function battleLogKeyForChar(name) {
        return CONFIG.battleLogKeyPrefix + (name ? name : '_default');
    }
    function skillStatsKeyForChar(name) {
        return CONFIG.skillStatsKeyPrefix + (name ? name : '_default');
    }

    /** 为当前角色加载日志/技能统计；无保存数据则给空壳 */
    function loadLogForChar(nameHint) {
        const name = nameHint || currentCharName;
        try {
            const raw = localStorage.getItem(battleLogKeyForChar(name));
            if (raw) {
                logHistory = JSON.parse(raw) || [];
                log('已加载角色日志[' + (name || '_default') + ']', logHistory.length, '条');
                return;
            }
        } catch (e) { /* ignore */ }
        logHistory = [];
    }
    function loadSkillStatsForChar(nameHint) {
        const name = nameHint || currentCharName;
        try {
            const raw = localStorage.getItem(skillStatsKeyForChar(name));
            if (raw) {
                skillStats = JSON.parse(raw);
                if (!skillStats || typeof skillStats !== 'object') skillStats = { casts: 0, damage: 0, bySkill: {} };
                if (!skillStats.bySkill) skillStats.bySkill = {};
                log('已加载角色技能统计[' + (name || '_default') + ']');
                return;
            }
        } catch (e) { /* ignore */ }
        skillStats = { casts: 0, damage: 0, bySkill: {} };
    }

    /** 保存当前日志/技能统计到指定角色的 localStorage key */
    let lastLogSaved = { key: '', json: '' };
    let lastSkillSaved = { key: '', json: '' };
    function saveLogForChar(nameHint) {
        const name = nameHint || currentCharName;
        try {
            const key = battleLogKeyForChar(name);
            const json = JSON.stringify(logHistory.slice(-CONFIG.battleLogMax));
            if (lastLogSaved.key === key && lastLogSaved.json === json) return;  // 内容没变不写盘
            lastLogSaved = { key, json };
            localStorage.setItem(key, json);
        } catch (e) { /* ignore */ }
    }
    function saveSkillStatsForChar(nameHint) {
        const name = nameHint || currentCharName;
        try {
            const key = skillStatsKeyForChar(name);
            const json = JSON.stringify(skillStats);
            if (lastSkillSaved.key === key && lastSkillSaved.json === json) return;
            lastSkillSaved = { key, json };
            localStorage.setItem(key, json);
        } catch (e) { /* ignore */ }
    }

    /**
     * 从 DOM 里提取当前角色名（直接查游戏 GameView header 的 .topbar .title）。
     * 找不到返回 null。
     */
    function detectCharacterName() {
        // GameView: header.topbar > div.title  显示角色名
        const titleEl = document.querySelector('.topbar .title');
        if (titleEl) {
            const t = (titleEl.textContent || '').trim();
            if (t && t.length <= 16 && !/^Lv\.|^EXP|已达最高/.test(t)) return t;
        }
        return null;
    }

    /**
     * 软重置脚本运行时 —— 角色切换 / 游戏路由重挂载时调用，
     * 语义上等价于「刷新页面后脚本重新注入一遍」，把所有模块级
     * 运行时状态清零，避免旧角色的 _cmpBusy / _cachedGameStore 等
     * 残留让新角色上的功能卡死。
     *
     * 注意：CONFIG（用户设置白名单）和 localStorage 不落盘也不清，
     * 因为 loadSettings 已在上游被调用过了，这里只管运行时。
     */
    function softReloadScriptRuntime() {
        log('[软重置] 清除所有运行时状态（视作页面刷新）');

        // --- Store 缓存 ---
        _cachedGameStore = null;
        if (_gameStoreRetryTimer) { clearTimeout(_gameStoreRetryTimer); _gameStoreRetryTimer = null; }


        // --- 技能商店数据（角色一换就失效） ---
        lastSkillShop = null;      // 技能商店数据按角色隔离，切换后重新拦截

        // --- HP/MP 血条同步缓存（新角色的条容器会被 Vue 重建）---
        barTargetsCache = [];
        barTargetsScanAt = 0;
        bloodBarStatusText = '';


        // --- 触发重扫描 ---
        lastRelocateAt = 0;
        try { runScans(); } catch (_) {}
    }

    /**
     * 检测当前角色身份，若与上次不同则：
     *   1) 保存当前设置到旧角色 key（如果角色已知）；
     *   2) 用新角色名的 key 覆盖 CONFIG；
     *   3) 重置 HUD 统计（currentLevel/currentExp 等）。
     * 启动时首次调用（oldName==null）只做 (2)。
     */
    function checkAndSwitchCharacter() {
        const newName = detectCharacterName();
        // 注意：null === null 也要继续执行，因为刷新后首次进入虽然角色名没变（都还是 null），
        // 但 CONFIG 刚被重置，需要 loadSettings(null) 去 _default 把用户设置读回来。
        // 只有「非空角色名完全一致」才是真 · 没变。
        if (newName && newName === currentCharName) return;
        const oldName = currentCharName;
        log('角色切换检测:', oldName, '→', newName);

        // ① 旧角色设置、日志、技能统计全部落盘（如果角色已知过）
        if (oldName) {
            saveSettings(oldName);
            saveLogForChar(oldName);
            saveSkillStatsForChar(oldName);
        }

        // ② 切到新角色（null → _default）
        currentCharName = newName;
        loadSettings(newName);
        loadLogForChar(newName);
        loadSkillStatsForChar(newName);

        // ③ 重置 HUD 等级/经验缓存 + 日志去重状态 + 战斗场次，让一切按新角色重新开始
        currentLevel = null;
        currentExp = null;
        maxExp = null;
        scanFailStreak = 0;
        hudDebugInfo = '';
        lastLogLines = [];
        battleCounter = 0;
        epicSeenMap.clear();
        lastSettlement = { kills: null, clears: null, gold: null, exp: null };

        // ④ 角色切换视作页面刷新：把所有模块级运行时状态一键清零
        softReloadScriptRuntime();

        renderHud();
        // 如果日志查看器正开着，刷新一下页签内容
        if (logViewerEl && document.body.contains(logViewerEl)) renderLogContent();
    }

    /* ============================================================
     * 登录态 / 角色判断
     * ============================================================ */
    function getToken() {
        try { return localStorage.getItem('dnf_idle_token') || ''; } catch (e) { return ''; }
    }
    function isInGame() {
        return /#\/game\//.test(location.hash) && !!getToken();
    }

    function loadSettings(nameHint) {
        let key = settingsKeyForChar(nameHint || currentCharName);
        let raw = localStorage.getItem(key);
        // 角色专属 key 没有 → fallback 到 _default（首次进 GameView 时角色名从 null 变真实名，
        // 但用户之前可能已在 _default 上留过设置，得把那份继承过来）
        if (!raw && nameHint && nameHint !== '_default') {
            const defaultKey = settingsKeyForChar(null);
            const fallback = localStorage.getItem(defaultKey);
            if (fallback) {
                log('角色[' + nameHint + ']无专属设置，从 _default 继承');
                raw = fallback;
                // 顺手写一份到角色专属 key，以后就不用再 fallback
                try { localStorage.setItem(key, fallback); } catch (_) {}
            }
        }
        try {
            if (raw) {
                const saved = JSON.parse(raw);
                for (const k of SETTING_KEYS) {
                    if (!saved || !saved.hasOwnProperty(k)) continue;
                    // 数组型设置（模块顺序）单独校验内容，避免脏数据导致布局异常
                    if (k === 'hudPos') {
                        const pos = saved[k];
                        if (pos === null || (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top))) CONFIG.hudPos = pos;
                        continue;
                    }
                    // 旧存档没有 hudDock，缺省保持 null（自由位置）
                    if (k === 'hudDock') {
                        const side = saved[k];
                        if (side === null || side === 'left' || side === 'right') CONFIG.hudDock = side;
                        continue;
                    }
                    if (k === 'moduleOrder') {
                        if (Array.isArray(saved[k])) CONFIG[k] = saved[k];
                        continue;
                    }
                    if (typeof saved[k] === typeof CONFIG[k]) CONFIG[k] = saved[k];
                }
                // 过滤非法/重复的模块 key，并补齐缺失项
                CONFIG.moduleOrder = normalizedModuleOrder();
                log('已加载角色设置[' + (nameHint || '_default') + ']:',
                    SETTING_KEYS.reduce((o, k) => { o[k] = CONFIG[k]; return o; }, {}));
            } else {
                log('角色[' + (nameHint || '_default') + ']无保存设置，使用默认值');
            }
        } catch (e) { log('读取角色设置失败（忽略）', e); }
    }

    function saveSettings(nameHint) {
        const key = settingsKeyForChar(nameHint || currentCharName);
        try {
            const data = SETTING_KEYS.reduce((o, k) => { o[k] = CONFIG[k]; return o; }, {});
            const json = JSON.stringify(data);
            localStorage.setItem(key, json);
            // 同时镜像写 _default key，这样：
            //   - 模块级预读（line 1795，硬编码读 _default）总能拿到最新值
            //   - 用户从未进过 GameView 时（角色名是 null）也有设置可继承
            if (key !== settingsKeyForChar(null)) {
                try { localStorage.setItem(settingsKeyForChar(null), json); } catch (_) {}
            }
            log('已保存角色设置[' + (nameHint || '_default') + ']');
        } catch (e) { log('保存角色设置失败', e); }
    }

    const LOG_PREFIX = '[DNF助手]';
    const log = (...args) => CONFIG.enableLog && console.log(LOG_PREFIX, ...args);

    /* ============================================================
     * 移动端模块自定义排序
     * ------------------------------------------------------------
     * 游戏移动端 .main 是单列 grid，三个 section 各自滚动。
     * 开启自定义顺序后，把 .left-col / .center-col 设为 display:contents，
     * 让六大模块直接成为 .main 的 flex 子项，用 CSS order 控制上下位置：
     *   人物框 / 状态框 / 地图怪物框 / 结算框 / 日志框 / 功能框
     * 顺序只改 CSS，不动 Vue 管理的 DOM，重渲染也不会把节点搬坏。
     * ============================================================ */
    let lastModuleOrderSig = '';

    function normalizedModuleOrder() {
        const saved = Array.isArray(CONFIG.moduleOrder) ? CONFIG.moduleOrder : [];
        const out = [];
        saved.forEach(k => {
            if (MODULE_DEFAULT_ORDER.indexOf(k) !== -1 && out.indexOf(k) === -1) out.push(k);
        });
        MODULE_DEFAULT_ORDER.forEach(k => {
            if (out.indexOf(k) === -1) out.push(k);
        });
        return out;
    }

    /** 上移/下移一个模块，返回是否发生变化 */
    function moveModule(key, dir) {
        const order = normalizedModuleOrder();
        const i = order.indexOf(key);
        if (i < 0) return false;
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return false;
        order.splice(i, 1);
        order.splice(j, 0, key);
        CONFIG.moduleOrder = order;
        return true;
    }

    function applyModuleOrder() {
        const main = document.querySelector('.main');
        if (!main) return;
        const mobile = isMobileLayout();
        const order = normalizedModuleOrder();
        // 默认顺序不改布局，保持游戏原生滚动体验；只有自定义顺序才启用堆叠
        const stack = mobile && order.join(',') !== MODULE_DEFAULT_ORDER.join(',');
        const sig = stack ? ('stack:' + order.join(',')) : 'off';
        if (sig === lastModuleOrderSig) {
            // 顺序没变：只在 Vue 重渲染导致 class/order 丢失时补一次
            const needFix = (stack !== main.classList.contains('dnf-mod-stack'))
                || (stack && order.some((key, i) => {
                    const def = MODULE_DEFS.find(d => d.key === key);
                    const el = def && document.querySelector(def.sel);
                    return !!el && el.style.order !== String((i + 1) * 10);
                }));
            if (!needFix) return;
        }
        lastModuleOrderSig = sig;
        if (stack) main.classList.add('dnf-mod-stack');
        else main.classList.remove('dnf-mod-stack');

        order.forEach((key, i) => {
            const def = MODULE_DEFS.find(d => d.key === key);
            const el = def && document.querySelector(def.sel);
            if (el) el.style.order = stack ? String((i + 1) * 10) : '';
        });
        // 「增益效果」面板没有单独开放排序，固定跟随「地图怪物框」其后
        const buff = document.querySelector('.main .buff-panel');
        if (buff) {
            const di = order.indexOf('dungeon');
            buff.style.order = stack ? String((di + 1) * 10 + 1) : '';
        }
    }

    /* ============================================================
     * 技能面板：特性技能过滤
     * ------------------------------------------------------------
     *   主动技能 / 被动技能 → 全部显示，不做任何隐藏
     *   特性技能 → 保留「已学特性」；「可学特性」只显示前置主动/被动已学会的条目
     *              （特性本身没学、但前置主动/被动已学 → 显示；
     *                前置未学 → 隐藏）
     *
     * 前置状态来自 /skill-shop 返回的 passive_shop[].block_reason：
     *   block_reason === 'base' 表示前置主动/被动尚未学习。
     * 数据还没拦截到时用 DOM 兜底：skill-locked 且提示不含「觉醒」的视为前置未学。
     * ============================================================ */
    const TP_SHOP_LABEL = '可学特性';

    /** 单条特性技能是否应隐藏（只看前置主动/被动是否已学） */
    function tpRowShouldHide(row, tpItems) {
        const info = row.querySelector(':scope > div');
        const nameEl = info ? info.querySelector(':scope > div') : null;
        const name = nameEl ? (nameEl.textContent || '').trim() : '';
        const it = tpItems.get(name);
        if (it) return it.block_reason === 'base';
        // 数据未就绪：游戏给「前置未学 / 未觉醒」的行都加 skill-locked，
        // 用提示文字区分，只隐藏前置未学的。
        if (row.classList.contains('skill-locked')) {
            const txt = row.textContent || '';
            return txt.indexOf('觉醒') === -1;
        }
        return false;
    }

    /** 过滤「可学特性」分区；返回 { total, visible }（关闭开关时返回 null） */
    function applyTpShopFilter(sec, tpItems, hide) {
        let total = 0;
        let visible = 0;
        let n = sec.nextElementSibling;
        while (n && !n.classList.contains('bag-section')) {
            n.querySelectorAll('.skill-row').forEach(row => {
                total++;
                const hidden = hide && tpRowShouldHide(row, tpItems);
                const want = hidden ? 'none' : '';
                if (row.style.display !== want) row.style.display = want;
                if (!hidden) visible++;
            });
            n = n.nextElementSibling;
        }
        return hide ? { total: total, visible: visible } : null;
    }

    function applyHideUnlearnedSkills() {
        const hide = CONFIG.hideUnlearnedSkills;

        // 未学习的特性技能：name → 数据（用于判断 block_reason）
        const tpItems = new Map();
        if (lastSkillShop && Array.isArray(lastSkillShop.passive_shop)) {
            lastSkillShop.passive_shop.forEach(it => {
                if (!it || it.passive_kind !== 'tp' || !it.name) return;
                if (typeof it.learned_level === 'number' && it.learned_level > 0) return;
                tpItems.set(it.name, it);
            });
        }

        document.querySelectorAll('.bag-section.muted').forEach(sec => {
            const t = (sec.textContent || '').trim();
            // 主动技能 / 被动技能面板始终全部显示，只处理「可学特性」
            if (t !== TP_SHOP_LABEL) return;
            const stat = applyTpShopFilter(sec, tpItems, hide);
            // 可学特性被全部过滤掉时，连标题一起隐藏
            const headWant = (stat && stat.total > 0 && stat.visible === 0) ? 'none' : '';
            if (sec.style.display !== headWant) sec.style.display = headWant;
        });
    }

    /** 显示 / 隐藏游戏自带的「挂机助手」悬浮窗（含折叠球） */
    function applyGameAssistantVisibility() {
        const root = document.documentElement;
        const want = !!CONFIG.hideGameAssistant;
        if (root && root.classList.contains('dnf-hide-game-assist') !== want) {
            root.classList.toggle('dnf-hide-game-assist', want);
        }
    }

    /**
     * 仓库页：区块顺序重排（v5.72）。
     * ------------------------------------------------------------
     * v5.68 曾把「仓库道具（取出区）」置顶；本版按新要求改为：
     *   bag-head 标签栏 → 仓库装备 → 仓库材料 → 其余（仓库道具 / 通关秘宝盒 /
     *   工具栏 / 账号共享说明 / 背包装备 / 背包材料 保持自然顺序）。
     * 游戏把仓库内容放在 .bag-tab（display:flex; flex-direction:column）里，
     * 因此只给标题与其后同组内容打 class + CSS order，不移动任何游戏节点；
     * 切子标签导致节点重建后，applyWarehouseOrder 会在下一轮扫描时重新打标记。
     * 每个区块从标题开始，到下一个 .bag-section 之前结束（标题后的筛选按钮、
     * 格子、空态文案都属于同一组，整组一起上移）。
     */
    const WH_EQUIP_LABEL = '仓库装备';
    const WH_MATERIAL_LABEL = '仓库材料';
    const WH_ITEMS_LABEL = '仓库道具';
    const WH_EMPTY_LABEL = '仓库为空';
    const WH_GROUP_CLASSES = {
        equip: { head: 'dnf-wh-equip-head', body: ['dnf-wh-equip-chips', 'dnf-wh-equip-grid'] },
        material: { head: 'dnf-wh-mat-head', body: ['dnf-wh-mat-chips', 'dnf-wh-mat-grid'] },
        items: { head: 'dnf-wh-items-head', body: ['dnf-wh-items-grid'] }
    };
    function whSectionKind(el) {
        if (!el.classList.contains('bag-section')) return null;
        const text = (el.textContent || '').trim();
        if (text.indexOf(WH_EQUIP_LABEL) === 0) return 'equip';
        if (text.indexOf(WH_MATERIAL_LABEL) === 0) return 'material';
        if (text.indexOf(WH_ITEMS_LABEL) === 0) return 'items';
        return null;
    }
    function applyWarehouseOrder() {
        document.querySelectorAll('.bag-tab').forEach(tab => {
            // 先清掉上一轮标记，避免游戏复用节点后残留旧 class
            const all = Object.values(WH_GROUP_CLASSES);
            all.forEach(g => {
                tab.querySelectorAll('.' + g.head).forEach(el => el.classList.remove(g.head));
                g.body.forEach(cls => tab.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls)));
            });
            tab.querySelectorAll('.dnf-wh-items-empty').forEach(el => el.classList.remove('dnf-wh-items-empty'));
            const kids = Array.from(tab.children);
            kids.forEach((el, i) => {
                const kind = whSectionKind(el);
                if (!kind) return;
                const group = WH_GROUP_CLASSES[kind];
                el.classList.add(group.head);
                // 标题后的内容直到下一个 bag-section 为止，全部归入该组
                for (let j = i + 1; j < kids.length; j++) {
                    const sib = kids[j];
                    if (sib.classList.contains('bag-section')) break;
                    if (kind === 'items' && (sib.textContent || '').trim() === WH_EMPTY_LABEL) {
                        sib.classList.add('dnf-wh-items-empty');
                    } else if (kind === 'items') {
                        sib.classList.add('dnf-wh-items-grid');
                    } else {
                        // 筛选按钮 / 格子 / 空态文案：格子单独标记，其余按 chips 处理
                        sib.classList.add(sib.classList.contains('bag-page-grid') ? group.body[1] : group.body[0]);
                    }
                }
            });
        });
    }


    // 安装 fetch 拦截器（必须在游戏加载前生效，脚本 @run-at document-start）
    // 注意：只读取响应做本地缓存，绝不修改响应体返回给游戏。
    // 把重活延后到浏览器空闲时段执行（避免与游戏渲染抢占主线程）；不支持时退回宏任务
    const scheduleIdle = (fn) => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 800 });
        else setTimeout(fn, 0);
    };

    // 解析拦截到的接口响应（延后到空闲时段执行，见 scheduleIdle）
    function handleIntercepted(url, data) {
        if (!data) return;
        if (/\/api\/characters\/[^/]+\/skill-shop$/.test(url)) {
            // 技能商店（主动 + 被动 + 特性）数据：用于判断哪些主动/被动已学习，
            // 进而过滤特性技能列表。
            if (Array.isArray(data.passive_shop)) {
                lastSkillShop = {
                    shop: Array.isArray(data.shop) ? data.shop : [],
                    passive_shop: data.passive_shop
                };
                // 数据可能晚于面板渲染到达，收到后立刻重算一次
                try { applyHideUnlearnedSkills(); } catch (_) {}
            }
        }
    }

    (function installFetchHook() {
        if (window.__dnfSetHookInstalled) return;
        window.__dnfSetHookInstalled = true;
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            return origFetch.apply(this, args).then(resp => {
                try {
                    const req = args[0];
                    const url = (typeof req === 'string') ? req : (req && req.url) || '';
                    if (!url || url.indexOf('/api/') === -1) return resp;
                    // 只关心少量接口，其余 /api 请求直接放行，
                    // 避免为其它高频请求增加克隆解析开销
                    const relevant =
                        /\/api\/characters\/[^/]+\/skill-shop$/.test(url);
                    if (!relevant) return resp;
                    // 先同步 clone（tee 出独立流），再把 JSON 解析延后到空闲时段执行，
                    // 避免与游戏渲染背包/装备列表抢占主线程
                    const clone = resp.clone();
                    scheduleIdle(() => {
                        clone.json().then(data => handleIntercepted(url, data)).catch(() => { });
                    });
                } catch (e) { }
                return resp;
            });
        };
    })();

    /* ============================================================
     * 插件浮动提示 toast（v5.75 恢复最初样式）
     * ------------------------------------------------------------
     * 历史：v5.72–v5.74 曾按游戏 .error 的字色/字号复刻红字观感，本版按要求
     * 不再模仿游戏红字，恢复改红字之前那套「[DNF助手]」深色提示窗：
     * 半透明黑底 + 金色文字 + 6px 圆角 + 轻微阴影，所有 showTip 共用一套。
     * 游戏 .error 只作为「文案来源」：syncGameError 把同一句文字交给 showTip，
     * 显示时统一加 [DNF助手] 前缀，外观与启动/存仓/全开等插件提示完全一致。
     * 位置：贴屏幕最上方（top:4px）、水平居中，pointer-events:none 不挡按钮。
     * ============================================================ */
    let tipEl = null;
    function ensureTip() {
        if (!CONFIG.showFloatTip) return null;
        if (tipEl && document.body.contains(tipEl)) return tipEl;
        tipEl = document.createElement('div');
        tipEl.className = 'dnf-helper-toast';
        tipEl.style.cssText = [
            'position:fixed', 'z-index:999999',
            // v5.75：贴屏幕最顶部（留 4px 边距），水平居中；pointer-events:none 不挡游戏按钮
            'left:50%', 'top:4px', 'transform:translateX(-50%)',
            'box-sizing:border-box',
            // 最初的插件提示容器：深色半透明底 + 金色字
            'padding:6px 12px', 'border-radius:6px',
            'background:rgba(0,0,0,0.75)', 'color:#ffb84d',
            'font:12px/1.4 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
            'max-width:min(80vw,420px)', 'text-align:center',
            // 长句/多行：自动换行，保留原文换行
            'white-space:pre-wrap', 'word-break:break-word', 'overflow-wrap:anywhere',
            'box-shadow:0 2px 8px rgba(0,0,0,.4)',
            'pointer-events:none', 'opacity:0',
            'transition:opacity .3s ease'
        ].join(';');
        document.body.appendChild(tipEl);
        return tipEl;
    }
    let tipTimer = null;
    // v5.81：可点击 toast 的临时监听器（更新提示用），普通 showTip 会清掉，避免残留点击行为
    let tipClickHandler = null;
    function clearTipClick() {
        if (!tipEl) return;
        tipEl.style.pointerEvents = 'none';
        tipEl.style.cursor = '';
        tipEl.style.textDecoration = '';
        if (tipClickHandler) {
            tipEl.removeEventListener('click', tipClickHandler);
            tipClickHandler = null;
        }
    }
    function showTip(msg) {
        const el = ensureTip();
        if (!el) return;
        clearTipClick();
        el.textContent = LOG_PREFIX + ' ' + String(msg == null ? '' : msg);
        el.style.opacity = '1';
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
    }
    /**
     * v5.81：可点击的 toast（更新提示专用）。沿用 showTip 的容器与样式，
     * 只是临时打开 pointer-events 并挂一次 click；到点/被普通提示覆盖后自动解绑。
     */
    function showTipAction(msg, onClick, holdMs) {
        const el = ensureTip();
        if (!el) return;
        clearTipClick();
        el.textContent = LOG_PREFIX + ' ' + String(msg == null ? '' : msg);
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        el.style.textDecoration = 'underline';
        tipClickHandler = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            try { onClick(); } catch (_) { }
        };
        el.addEventListener('click', tipClickHandler, { passive: false });
        clearTimeout(tipTimer);
        // 更新提示需要更长的阅读/点击窗口（默认 10s），超时后自动收起
        tipTimer = setTimeout(() => { el.style.opacity = '0'; clearTipClick(); }, Math.max(3000, Number(holdMs) || 10000));
    }

    /* ============================================================
     * 联网检查更新（v5.81）
     * ------------------------------------------------------------
     * 安全红线：只做「读 version.json + 提示 + 跳转」，绝不 eval、
     * 不远程执行代码、不自动替换/改写本地脚本，也不碰任何游戏接口。
     * 失败一律静默（断网 / 404 / JSON 坏 / 8s 超时都只 debug），不弹错误。
     * 节流：同一版本 24 小时内只自动提示一次（用户点开也算一次）。
     * ============================================================ */
    const UPDATE_CDN_BASE = 'https://cdn.jsdelivr.net/gh/';
    const UPDATE_REPO_PATH = '/DNF-js@main/';
    const UPDATE_OWNER = '1694385621';          // 当前 GitHub 用户名
    const UPDATE_LEGACY_OWNER = '15186474463';  // 改名前的旧用户名（GitHub 改名会重定向，jsDelivr 多数情况仍可读，用作兜底）
    const UPDATE_SCRIPT_URL = UPDATE_CDN_BASE + UPDATE_OWNER + UPDATE_REPO_PATH + 'dnf-helper.js';
    const UPDATE_VERSION_URL = UPDATE_CDN_BASE + UPDATE_OWNER + UPDATE_REPO_PATH + 'version.json';
    const UPDATE_TIMEOUT_MS = 8000;
    const UPDATE_LEGACY_TIMEOUT_MS = 5000;      // 兜底源超时短一点，避免两个都慢时拖太久
    const UPDATE_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
    const UPDATE_PROMPT_KEY = 'dnf_update_prompted_v1';
    const UPDATE_AUTO_DELAY_MS = 8000;
    let updateChecking = false;

    /** 语义化版本 → 数字段数组（"5.10" > "5.9"；非数字段按 0 处理） */
    function parseVersionSegs(v) {
        return String(v == null ? '' : v).trim().replace(/^v/i, '').split('.')
            .map(s => parseInt(s, 10)).map(n => Number.isFinite(n) ? n : 0);
    }
    /** 按数字段比较：a>b 返回 1，相等 0，a<b 返回 -1 */
    function compareVersions(a, b) {
        const x = parseVersionSegs(a), y = parseVersionSegs(b);
        const len = Math.max(x.length, y.length);
        for (let i = 0; i < len; i++) {
            const p = x[i] || 0, q = y[i] || 0;
            if (p > q) return 1;
            if (p < q) return -1;
        }
        return 0;
    }
    function readPrompted() {
        try {
            const rec = JSON.parse(localStorage.getItem(UPDATE_PROMPT_KEY) || 'null');
            if (rec && typeof rec.version === 'string' && Number.isFinite(rec.at)) return rec;
        } catch (_) { }
        return null;
    }
    /** 同一版本 24h 内已经提示/点开过 → 不再自动提示 */
    function wasPromptedRecent(version) {
        const rec = readPrompted();
        return !!(rec && rec.version === version && (Date.now() - rec.at) < UPDATE_PROMPT_TTL_MS);
    }
    function markPrompted(version) {
        try { localStorage.setItem(UPDATE_PROMPT_KEY, JSON.stringify({ version: version, at: Date.now() })); } catch (_) { }
    }

    /** 指定用户名的 version.json 地址 */
    function updateVersionUrl(owner) { return UPDATE_CDN_BASE + owner + UPDATE_REPO_PATH + 'version.json'; }
    /** 指定用户名的 dnf-helper.js 地址 */
    function updateScriptUrl(owner) { return UPDATE_CDN_BASE + owner + UPDATE_REPO_PATH + 'dnf-helper.js'; }
    /** 从下载地址里取 GitHub 用户名（.../gh/<owner>/...）；取不到返回空串 */
    function ownerOfUpdateUrl(u) {
        const m = /^https?:\/\/[^/]+\/gh\/([^/@?#]+)\//i.exec(String(u == null ? '' : u));
        return m ? m[1] : '';
    }

    /** 从指定用户名拉 version.json（超时 + 时间戳绕缓存）；任何失败返回 null */
    async function fetchManifestFrom(owner, timeoutMs) {
        if (typeof fetch !== 'function') return null;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) { } }, timeoutMs) : 0;
        try {
            const base = updateVersionUrl(owner);
            const url = base + '?_t=' + Date.now();
            const resp = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
            if (!resp || !resp.ok) return null;
            const data = await resp.json();
            if (!data || typeof data !== 'object') return null;
            const version = typeof data.version === 'string' ? data.version.trim() : '';
            if (!/^\d+(\.\d+)*$/.test(version.replace(/^v/i, ''))) return null;
            // url 只接受 http(s)，且用户名必须与本次成功的源一致，否则按本次源拼 dnf-helper.js，
            // 避免「新地址 404、旧地址兜底成功」时把用户又引回打不开的新地址。
            const raw = typeof data.url === 'string' ? data.url.trim() : '';
            const target = (/^https?:\/\//i.test(raw) && ownerOfUpdateUrl(raw) === String(owner))
                ? raw : updateScriptUrl(owner);
            const notes = typeof data.notes === 'string' ? data.notes.trim() : '';
            return { version: version, url: target, notes: notes, owner: String(owner) };
        } catch (_) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 先查新用户名地址；失败再回退旧用户名地址（v5.82）。两个都失败返回 null */
    async function fetchUpdateManifest() {
        const primary = await fetchManifestFrom(UPDATE_OWNER, UPDATE_TIMEOUT_MS);
        if (primary) return primary;
        log('新地址不可用（' + UPDATE_OWNER + '），回退旧地址 ' + UPDATE_LEGACY_OWNER);
        return await fetchManifestFrom(UPDATE_LEGACY_OWNER, UPDATE_LEGACY_TIMEOUT_MS);
    }

    /** 打开下载页（只跳转，不在页面里执行任何远端代码） */
    function openUpdatePage(url) {
        try { window.open(url || UPDATE_SCRIPT_URL, '_blank', 'noopener,noreferrer'); } catch (_) { }
    }

    function promptUpdate(info, statusEl) {
        const text = '发现新版本 v' + info.version + '，点击更新';
        if (statusEl) statusEl.textContent = '发现 v' + info.version + (info.notes ? '：' + info.notes : '');
        showTipAction(text, () => {
            markPrompted(info.version);
            openUpdatePage(info.url);
            showTip('已打开更新页面，请在浏览器中保存并替换脚本');
        }, 10000);
    }

    /**
     * 检查更新。
     * @param {{manual?:boolean,statusEl?:HTMLElement}} opts manual=true 时忽略 24h 节流并反馈结果
     */
    async function checkForUpdate(opts) {
        const manual = !!(opts && opts.manual);
        const statusEl = (opts && opts.statusEl) || null;
        if (updateChecking) return;
        updateChecking = true;
        try {
            const info = await fetchUpdateManifest();
            if (!info) {
                log('检查更新失败（网络/404/解析/超时，已静默忽略）');
                if (statusEl) statusEl.textContent = '检查失败，请稍后重试';
                if (manual) showTip('检查更新失败，请稍后重试');
                return;
            }
            if (compareVersions(info.version, VERSION) > 0) {
                const needPrompt = manual || !wasPromptedRecent(info.version);
                if (needPrompt) {
                    if (!manual) markPrompted(info.version);   // 自动提示也记一次，24h 内不再打扰
                    promptUpdate(info, statusEl);
                } else if (statusEl) {
                    statusEl.textContent = '发现 v' + info.version + '（24 小时内已提示过）';
                }
            } else {
                if (statusEl) statusEl.textContent = '已是最新版本 v' + VERSION;
                if (manual) showTip('已是最新版本 v' + VERSION);
            }
        } catch (e) {
            log('检查更新异常（已忽略）', e);
        } finally {
            updateChecking = false;
        }
    }

    /** 启动后延迟自动检查一次（默认 8s，避开进游戏的高峰；可关） */
    function scheduleUpdateCheck() {
        if (!CONFIG.autoCheckUpdate) return;
        if (window.__dnfUpdateScheduled581) return;
        window.__dnfUpdateScheduled581 = true;
        setTimeout(() => {
            try { checkForUpdate({ manual: false }); } catch (_) { }
        }, UPDATE_AUTO_DELAY_MS);
    }
    // ===== v5.81 UPDATE CHECK END =====


    /* ============================================================
     * 游戏红字同步（v5.75）
     * ------------------------------------------------------------
     * 游戏真实报错是 <div class="error" data-v-38d660e3>…</div>，
     * 由 Vue 直接插入/改写文本，父容器 section.right-col[data-v-38d660e3]。
     * 这里只做「同步一份到插件 toast」，不修改、不隐藏游戏原生红字：
     *   - MutationObserver 监听新增节点与文本变化（characterData），120ms 合并一轮；
     *   - 每轮扫描 div.error，同一节点只有在「文本变化」时才重放，避免常驻节点
     *     被无关 DOM 变动反复触发；
     *   - 同一文案 2.5s 内只弹一次（Vue 重建同文本节点时去重）；
     *   - 文案交给 showTip 显示（统一加 [DNF助手] 前缀、用插件最初样式，不模仿游戏红字）；
     *   - 插件自身的 showTip 不受影响，所以存仓/全开等提示不会与同步重复。
     * ============================================================ */
    const GAME_ERROR_DEDUPE_MS = 2500;
    let gameErrorObserver = null;
    let lastGameError = { text: '', at: 0 };
    // 记录每个 .error 节点上次同步过的文本：文本不变就不再弹
    const mirroredErrorNodes = new WeakMap();

    /** 收集当前页面上可识别的游戏系统红字（排除插件自身 UI；空文本节点也要收集，用于重置去重状态） */
    function collectGameErrors() {
        const out = [];
        document.querySelectorAll('div.error').forEach(node => {
            if (!node.isConnected) return;
            // 只认游戏页面里的系统提示，避免误抓其它同 class 的组件
            if (!node.closest('.app-shell') && !node.closest('[data-v-app]')) return;
            // 插件自己的提示/面板不参与（防御性判断）
            if (node.closest('.dnf-helper-toast,.dnf-settings-panel')) return;
            const text = (node.textContent || '').trim();
            out.push([node, text]);
        });
        return out;
    }

    /** 把游戏新出现的红字原样同步到插件 toast（相同文案短时去重） */
    function syncGameError() {
        if (!CONFIG.showFloatTip) return;
        for (const [node, text] of collectGameErrors()) {
            if (mirroredErrorNodes.get(node) === text) continue;   // 节点文本没变：跳过
            // 先把空文本也记下来：游戏清空后再用同一节点报同一句时，仍能重新弹一次
            mirroredErrorNodes.set(node, text);
            if (!text) continue;
            const now = Date.now();
            if (text === lastGameError.text && now - lastGameError.at < GAME_ERROR_DEDUPE_MS) continue;
            lastGameError = { text, at: now };
            showTip(text);
        }
    }

    /** 启动红字监听（body/documentElement 可能在 document-start 阶段尚未就绪，用 documentElement 兜底） */
    function startGameErrorSync() {
        if (gameErrorObserver) return;
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => { scheduled = false; syncGameError(); }, 120);
        };
        gameErrorObserver = new MutationObserver(schedule);
        gameErrorObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        schedule();   // 注入脚本时若红字已经在页面上，也能补同步一次
    }

    /* ============================================================
     * 挂机助手 HUD（首次默认左上角，可点击折叠/展开）
     *   - 当前复活币数量
     *   - 挂机时长（脚本启动以来）
     *   - 累计击杀 / 通关 / 金币 / 经验（从"最近结算"区块增量累加）
     *   - 累计装备（背包装备数变化检测）
     * ============================================================ */
    let hudEl = null;
    let hudHeaderEl = null;
    let hudBodyEl = null;
    let hudCollapsed = true;      // 浮窗初始默认收起（只留 + 按钮）
    let settingsOpen = false;      // 挂机助手内「⚙ 设置」面板是否展开

    let reviveCount = null;   // 从游戏原生「挂机助手」浮窗读取的「复活 N 次」
    let potionCount = null;   // 从游戏原生「挂机助手」浮窗读取的「药水 ×N」
    let hudStartTime = Date.now();   // 挂机时长起点，登录重置时会更新
    // 当前等级与经验进度（用于预测下一次升级时间）
    let currentLevel = null;          // 当前角色等级，如 46
    let currentExp = null;            // 当前经验值
    let maxExp = null;                // 当前等级经验上限

    // 累计统计
    const stats = {
        kills: 0,        // 累计击杀
        clears: 0,       // 累计通关
        gold: 0,         // 累计金币
        exp: 0,          // 累计经验
        drops: {         // 累计掉落物，按类别计数
            consumable: 0,  // 消耗品
            material: 0,    // 材料
            equip: 0,       // 装备
            epic: 0,        // 史诗（掉落物含"史诗"字样）
        },
    };
    // 上一次解析到的"最近结算"原值，用于增量计算
    let lastSettlement = { kills: null, clears: null, gold: null, exp: null };
    // 史诗掉落去重：物品名 → 上次统计的时间戳
    // 用于解决「离线收益重放」导致同一件史诗被统计两次的问题
    const epicSeenMap = new Map();
    // 史诗去重时间窗（毫秒）：窗口内同一件史诗只统计一次
    // （史诗掉落本身很稀有，窗口内重复基本上都是离线重放，不会误伤真实掉落）
    const EPIC_DEDUP_WINDOW_MS = 60000;

    // 掉落记录本地存储：{ b: 场次, text: 日志行 } 数组，最多 CONFIG.battleLogMax 条
    let lastLogLines = [];        // 上一次抓取的完整日志行，用于增量 diff 与新战斗判定
    let battleCounter = 0;        // 场次编号
    let logHistory = (() => {
        try { return JSON.parse(localStorage.getItem(battleLogKeyForChar(null)) || '[]') || []; }
        catch (e) { return []; }
    })();
    // 高频写入节流：战斗中每掉落一行都会调用 save*，合并成每 1.5s 最多一次写盘
    let logSaveTimer = null, logSaveAt = 0;
    let skillSaveTimer = null, skillSaveAt = 0;
    function saveLogHistory() {
        const now = Date.now();
        if (now - logSaveAt >= CONFIG.storageWriteThrottleMs) {
            logSaveAt = now;
            saveLogForChar(currentCharName);
            return;
        }
        if (logSaveTimer) return;
        logSaveTimer = setTimeout(() => {
            logSaveTimer = null;
            logSaveAt = Date.now();
            saveLogForChar(currentCharName);
        }, CONFIG.storageWriteThrottleMs);
    }

    // 技能释放/输出统计：{ casts: 总释放次数, damage: 总输出, bySkill: { 技能名: {casts, damage} } }
    let skillStats = (() => {
        try {
            const v = JSON.parse(localStorage.getItem(skillStatsKeyForChar(null)) || 'null');
            return (v && typeof v === 'object') ? v : { casts: 0, damage: 0, bySkill: {} };
        } catch (e) { return { casts: 0, damage: 0, bySkill: {} }; }
    })();
    function saveSkillStats() {
        const now = Date.now();
        if (now - skillSaveAt >= CONFIG.storageWriteThrottleMs) {
            skillSaveAt = now;
            saveSkillStatsForChar(currentCharName);
            return;
        }
        if (skillSaveTimer) return;
        skillSaveTimer = setTimeout(() => {
            skillSaveTimer = null;
            skillSaveAt = Date.now();
            saveSkillStatsForChar(currentCharName);
        }, CONFIG.storageWriteThrottleMs);
    }
    // 查看器当前页签：'drop' 掉落 | 'skill' 技能
    let activeLogTab = 'drop';

    // HUD 停靠角距屏幕边缘的距离（比旧版 top:40px 更贴近角落）
    const HUD_CORNER_GAP = '8px';
    // v5.75：首次启动（没有保存过的拖动坐标/吸附侧）时默认落在游戏画面左上角。
    // 只要用户拖过或贴过边，CONFIG.hudPos / hudDock 就有值，会优先恢复历史位置。
    // top 取 60px：落在游戏顶部导航（返回/角色名/更新时间，约 57px 高）下方，
    // 仍属于游戏画面左上角，但不会把「← 返回」等关键按钮盖住。
    const HUD_DEFAULT_POS = { left: 12, top: 60 };

    /** v5.78：可用宽度 = 视口宽 - 左右各 8px；小于 340px 时切紧凑排版 */
    function hudAvailWidth() {
        return Math.max(120, Math.floor(innerWidth) - 16);
    }
    function applyHudResponsiveSize() {
        if (!hudEl) return;
        const avail = hudAvailWidth();
        const compact = avail < 340;
        hudEl.classList.toggle('dnf-hud-compact', compact);
        hudEl.style.font = compact
            ? '600 11px/1.5 -apple-system,Segoe UI,Microsoft YaHei,sans-serif'
            : '600 12px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif';
        hudEl.style.maxWidth = avail + 'px';
        if (hudCollapsed) {
            // 折叠胶囊同样受视口约束（auto 宽度 + maxWidth）
            hudEl.style.width = 'auto';
        } else {
            hudEl.style.width = Math.min(220, avail) + 'px';
            if (hudBodyEl) {
                hudBodyEl.style.padding = compact ? '6px 8px' : '8px 10px';
                hudBodyEl.style.lineHeight = compact ? '1.5' : '1.7';
            }
        }
    }

    /** 优先恢复已保存拖动坐标/吸附侧；没有坐标时从左上角开始 */
    function applyHudPosition() {
        if (!hudEl) return;
        // 先按当前视口重算宽度/排版，再做定位钳制
        applyHudResponsiveSize();
        const pos = CONFIG.hudPos;
        const dock = CONFIG.hudDock === 'left' || CONFIG.hudDock === 'right' ? CONFIG.hudDock : null;
        positionFloating(hudEl, pos && Number.isFinite(pos.left) && Number.isFinite(pos.top) ? pos : HUD_DEFAULT_POS, dock);
    }
    function enableHudDrag() {
        makeFloatingDraggable(hudEl,hudHeaderEl,'hud',
            Object.assign({}, CONFIG.hudPos || HUD_DEFAULT_POS, {dock:CONFIG.hudDock}),
            pos=>{
                CONFIG.hudPos={left:pos.left,top:pos.top};
                CONFIG.hudDock=(pos.dock==='left'||pos.dock==='right')?pos.dock:null;
                saveSettings();
            });
    }
    function ensureHud() {
        if (!CONFIG.enableReviveHud) return null;
        if (hudEl && document.body.contains(hudEl)) return hudEl;

        hudEl = document.createElement('div');
        hudEl.style.cssText = [
            'position:fixed', 'z-index:999998',
            'padding:0', 'border-radius:8px',
            'background:rgba(20,12,8,0.92)', 'color:#ffd76b',
            'font:600 12px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
            // v5.78：窄屏按视口收缩（左右各留至少 8px），绝不横向溢出
            'width:220px', 'min-width:0', 'max-width:calc(100vw - 16px)', 'box-sizing:border-box',
            'overflow-wrap:anywhere', 'word-break:break-word',
            // 限高到视口内并纵向排列：内容超出屏幕时由内容区滚动，底部不会跑出屏幕
            'max-height:calc(100vh - 16px)', 'display:flex', 'flex-direction:column',
            'box-shadow:0 2px 12px rgba(0,0,0,.55)',
            'border:1px solid rgba(255,184,77,0.4)',
            'cursor:pointer', 'user-select:none',
            'transition:box-shadow .2s',
            'overflow:hidden'   // 防止按钮 hover scale 后溢出
        ].join(';');

        // 在面板内滚动时不冒泡到游戏页面，避免连带滚动游戏视图
        const stopHudScrollChain = (e) => { e.stopPropagation(); };
        hudEl.addEventListener('wheel', stopHudScrollChain, { passive: true });
        hudEl.addEventListener('touchmove', stopHudScrollChain, { passive: true });

        // 标题栏（点击折叠/展开）
        hudHeaderEl = document.createElement('div');
        hudHeaderEl.className = 'dnf-hud-header';
        hudHeaderEl.style.cssText = [
            'padding:6px 10px', 'border-bottom:1px solid rgba(255,184,77,0.25)',
            'display:flex', 'justify-content:space-between', 'align-items:center',
            'font-weight:700'
        ].join(';');
        const titleSpan = document.createElement('span');
        titleSpan.textContent = '挂机助手 v' + VERSION;
        // v5.78：标题允许省略，不把标题栏撑出面板
        titleSpan.style.cssText = 'color:#ffb84d;min-width:0;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap';
        // 右侧按钮组：日志 / 重置 / 设置 / 折叠
        const rightGroup = document.createElement('span');
        rightGroup.style.cssText = 'display:flex;align-items:center;gap:5px';
        // 按钮统一样式：圆形 + 深色半透明 + 金色微光边框 + hover 放大发光
        const btnBase = 'display:inline-flex !important;align-items:center !important;' +
            'justify-content:center !important;width:24px !important;height:24px !important;' +
            'min-width:24px !important;min-height:24px !important;border-radius:50% !important;' +
            'cursor:pointer;transition:all .18s ease;' +
            'background:rgba(6,3,1,.55) !important;' +
            'border:1px solid rgba(255,184,77,.35) !important;' +
            'box-shadow:0 1px 3px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,184,77,.12);' +
            'user-select:none;padding:0 !important;line-height:1;outline:none';
        // hover 发光样式
        const hoverStyle = 'transform:scale(1.12);' +
            'background:rgba(255,184,77,.18) !important;' +
            'border-color:rgba(255,184,77,.8) !important;' +
            'box-shadow:0 0 10px rgba(255,184,77,.45),0 0 18px rgba(255,184,77,.2),inset 0 1px 0 rgba(255,255,255,.15)';
        const applyHover = (el) => {
            el.addEventListener('mouseenter', () => { el.style.cssText += ';' + hoverStyle; });
            el.addEventListener('mouseleave', () => { el.style.cssText = btnBase + el._colorStyle; });
            el.addEventListener('touchstart', () => { el.style.cssText += ';' + hoverStyle; }, { passive: true });
            el.addEventListener('touchend', () => { setTimeout(() => { el.style.cssText = btnBase + el._colorStyle; }, 200); }, { passive: true });
        };
        // 日志按钮：SVG 小笔记本
        const logBtn = document.createElement('span');
        logBtn.title = '查看掉落 / 技能日志';
        logBtn._colorStyle = 'color:#ffd76b';
        logBtn.style.cssText = btnBase + logBtn._colorStyle;
        logBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
            '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
            '<path d="M8 7h8M8 11h8M8 15h5"/>' +
            '</svg>';
        applyHover(logBtn);
        logBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLogViewer(); });
        // 重置按钮
        const resetBtn = document.createElement('span');
        resetBtn.title = '点击重置统计';
        resetBtn._colorStyle = 'color:#ff9a9a';
        resetBtn.style.cssText = btnBase + resetBtn._colorStyle + 'font-size:13px;font-weight:700';
        resetBtn.textContent = '⟲';
        applyHover(resetBtn);
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resetStats();
            showTip('统计已手动重置');
        });
        // 设置按钮
        const gearBtn = document.createElement('span');
        gearBtn.title = '脚本设置';
        gearBtn._colorStyle = 'color:#b9e0ff';
        gearBtn.style.cssText = btnBase + gearBtn._colorStyle;
        gearBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="3"/>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
            '</svg>';
        applyHover(gearBtn);
        gearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSettingsPanel();
        });
        // 折叠按钮（也是圆形）
        const toggleSpan = document.createElement('span');
        toggleSpan.title = '折叠 / 展开';
        toggleSpan._colorStyle = 'color:#9a8860';
        toggleSpan.style.cssText = btnBase + toggleSpan._colorStyle + 'font-size:12px';
        toggleSpan.textContent = '—';
        applyHover(toggleSpan);
        rightGroup.appendChild(logBtn);
        rightGroup.appendChild(resetBtn);
        rightGroup.appendChild(gearBtn);
        rightGroup.appendChild(toggleSpan);
        hudHeaderEl.appendChild(titleSpan);
        hudHeaderEl.appendChild(rightGroup);
        // 折叠/展开状态应用（创建时按初始状态套一次，点击时再切换）
        const setHudCollapsed = (collapsed) => {
            hudCollapsed = collapsed;
            // 供拖动逻辑判断：折叠态允许从「+」按钮上开始拖动
            hudEl.dataset.hudCollapsed = hudCollapsed ? '1' : '0';
            toggleSpan.textContent = hudCollapsed ? '+' : '—';
            // 折叠时隐藏其余按钮（只留「+」），展开时恢复
            [logBtn, resetBtn, gearBtn, toggleSpan].forEach((el, i) => {
                el.style.cssText = btnBase + (el._colorStyle || '') +
                    (hudCollapsed && i < 3 ? ';display:none !important' : '');
            });
            hudEl.style.minWidth = '0';
            hudEl.style.padding = '0';
            if (hudCollapsed) {
                // 折叠态：隐藏内容区，标题栏收成紧凑胶囊「挂机助手 vX.XX」+ 圆形「+」
                hudHeaderEl.style.borderBottom = 'none';
                hudHeaderEl.style.padding = '7px 15px';
                hudHeaderEl.style.gap = '12px';
                hudBodyEl.style.display = 'none';
                hudEl.style.width = 'auto';
                hudEl.style.borderColor = 'rgba(200,149,74,0.85)';
                hudEl.style.borderRadius = '9px';
            } else {
                hudHeaderEl.style.borderBottom = '1px solid rgba(255,184,77,0.25)';
                hudHeaderEl.style.padding = '6px 10px';
                hudHeaderEl.style.gap = '0';
                hudBodyEl.style.display = 'block';
                hudBodyEl.style.padding = '8px 10px';
                hudEl.style.borderColor = 'rgba(255,184,77,0.4)';
                hudEl.style.borderRadius = '8px';
                // 展开时强制重绘一次，补上折叠期间跳过的时间/统计更新
                hudLastHtml = '';
                renderHud();
            }
            // v5.78：切换后按当前视口重算宽度/紧凑排版，并重新钳制位置
            applyHudResponsiveSize();
            // 折叠/展开都会改变宽度（149px → 220px）：下一帧按吸附侧重新贴边，
            // 避免停在右侧的胶囊展开后溢出屏幕、或停在左侧时出现偏移。
            // 宽度重排可能晚于一帧，吸附侧再补两次校准（自由位置不做延迟校准，
            // 以免打断正在进行的拖动）。
            requestAnimationFrame(() => applyHudPosition());
            if (CONFIG.hudDock === 'left' || CONFIG.hudDock === 'right') {
                setTimeout(() => applyHudPosition(), 120);
                setTimeout(() => applyHudPosition(), 320);
            }
        };
        hudHeaderEl.addEventListener('click', () => {
            setHudCollapsed(!hudCollapsed);
            // 记忆折叠/展开状态，刷新后保持
            CONFIG.hudCollapsed = hudCollapsed;
            saveSettings();
        });
        hudEl.appendChild(hudHeaderEl);

        // 内容区（min-height:0 + overflow-y:auto：内容超出屏幕时自身滚动，底部始终可达）
        hudBodyEl = document.createElement('div');
        hudBodyEl.style.cssText = 'padding:8px 10px;line-height:1.7;flex:1;min-height:0;' +
            'overflow-y:auto;overscroll-behavior:contain';
        hudEl.appendChild(hudBodyEl);

        // 标题栏拖动 + 记住位置
        enableHudDrag();

        document.body.appendChild(hudEl);
        applyHudPosition();
        // 位置只在初始化/切换角/窗口尺寸变化时写，避免每秒 renderHud 触发样式重算
        window.addEventListener('resize', applyHudPosition, { passive: true });
        // v5.78：手机横竖屏旋转、地址栏收起/软键盘导致可视视口变化时也要重新钳制
        window.addEventListener('orientationchange', () => {
            setTimeout(applyHudPosition, 60);
            setTimeout(applyHudPosition, 300);
        }, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', applyHudPosition, { passive: true });
        }
        // 初始状态：从已保存设置恢复折叠态（记忆）
        hudCollapsed = !!CONFIG.hudCollapsed;
        setHudCollapsed(hudCollapsed);
        renderHud();
        return hudEl;
    }

    /** 把毫秒格式化为 "H时M分S秒" */
    function formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return h + '时' + m + '分' + sec + '秒';
        if (m > 0) return m + '分' + sec + '秒';
        return sec + '秒';
    }

    /** 数字千分位格式化 */
    function fmtNum(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n);
    }

    /** HTML 转义：HUD 里角色名/日志文本等外部来源内容不能直接拼进 innerHTML */
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 渲染 HUD 内容（含挂机时长、预测升级时间、累计统计、复活次数、获取效率、掉落物分类） */
    let hudLastHtml = '';
    function renderHud() {
        if (!hudEl || !hudBodyEl) return;
        if (hudCollapsed) return;   // 折叠状态不重建隐藏 DOM，展开时再渲染
        const duration = formatDuration(Date.now() - hudStartTime);
        const valStyle = 'color:#ffb84d;font-weight:700';
        // 计算每小时效率（用累计值除以挂机小时数）
        // 挂机不足 1 分钟时显示 "—"，避免数值偏低误导
        const elapsedMs = Date.now() - hudStartTime;
        const elapsedH = elapsedMs / 3600000;
        let goldRate, expRate;
        if (elapsedMs < CONFIG.statsWarmupMs) {
            goldRate = '—'; expRate = '—';
        } else {
            goldRate = fmtNum(Math.round(stats.gold / elapsedH));
            expRate = fmtNum(Math.round(stats.exp / elapsedH));
        }

        // 预测下一次升级时间
        // 公式: 预测剩余时间 = (maxExp - currentExp) / 经验速率
        // 经验速率用 stats.exp / elapsedH（每小时经验）
        // 满级判定：游戏在满级时不再渲染 "N / M" 经验条，同时会显示"已达最高等级"，
        //   因此 currentLevel 有值但 currentExp/maxExp 都是 null → 隐藏预测升级行。
        const atMaxLevel = (currentLevel !== null && currentExp === null && maxExp === null);
        let levelUpText = '—';
        if (!atMaxLevel && currentLevel !== null && currentExp !== null && maxExp !== null
            && maxExp > currentExp && elapsedMs >= CONFIG.statsWarmupMs) {
            const needExp = maxExp - currentExp;
            const expPerMs = stats.exp / elapsedMs;   // 每毫秒经验
            if (expPerMs > 0) {
                const remainMs = needExp / expPerMs;
                levelUpText = formatDuration(remainMs);
            }
        }
        const levelText = (currentLevel === null) ? '—' : ('Lv.' + currentLevel);

        const lines = [];
        if (currentCharName) {
            lines.push('角色: <span style="color:#ffb84d;font-weight:700">' + escHtml(currentCharName) + '</span>');
        }
        if (hudDebugInfo) {
            lines.push('<span style="color:#ff7676;font-size:11px">' + escHtml(hudDebugInfo) + '</span>');
        }
        lines.push('挂机时长: <span style="' + valStyle + '">' + duration + '</span>');
        lines.push('当前等级: <span style="' + valStyle + '">' + levelText + '</span>' +
            (atMaxLevel ? ' <span style="color:#ffb84d;font-size:11px">(已满级)</span>' : ''));
        if (!atMaxLevel) {
            lines.push('预测升级: <span style="' + valStyle + '">' + levelUpText + '</span>');
        }
        lines.push('<div style="border-top:1px dashed rgba(255,184,77,0.25);margin:4px 0"></div>');
        lines.push('复活: <span style="' + valStyle + '">' + (reviveCount === null ? '—' : reviveCount + ' 次') + '</span> · 药水: <span style="' + valStyle + '">' + (potionCount === null ? '—' : '×' + potionCount) + '</span>');
        lines.push('<div style="border-top:1px dashed rgba(255,184,77,0.25);margin:4px 0"></div>');
        lines.push('累计击杀: <span style="' + valStyle + '">' + stats.kills + '</span>');
        lines.push('累计通关: <span style="' + valStyle + '">' + stats.clears + '</span>');
        lines.push('金币/时: <span style="' + valStyle + '">' + goldRate + '</span>');
        lines.push('经验/时: <span style="' + valStyle + '">' + expRate + '</span>');
        lines.push('<div style="border-top:1px dashed rgba(255,184,77,0.25);margin:4px 0"></div>');
        lines.push('掉落-消耗品: <span style="' + valStyle + '">' + stats.drops.consumable + '</span>');
        lines.push('掉落-材料: <span style="' + valStyle + '">' + stats.drops.material + '</span>');
        lines.push('掉落-装备: <span style="' + valStyle + '">' + stats.drops.equip + '</span>');
        lines.push('掉落-史诗: <span style="' + valStyle + '">' + stats.drops.epic + '</span>');
        // 设置面板（默认折叠，由 ⚙ 按钮展开）
        // 血条同步状态（排查用，默认关闭，可在 ⚙ 里打开）
        if (CONFIG.debugHud && bloodBarStatusText) {
            lines.push('血条同步: <span style="color:#8ecaff">' + escHtml(bloodBarStatusText) + '</span>');
        }

        const html = lines.join('<br>');
        if (html === hudLastHtml) return;   // 内容没变：不重建 DOM，保住滚动位置与点击态
        const scrollTop = hudBodyEl.scrollTop;
        hudBodyEl.innerHTML = html;
        hudBodyEl.scrollTop = scrollTop;
        hudLastHtml = html;
        // 为刚才注入的开关绑定点击事件（因为 innerHTML 重建 DOM，需重新 attach）
        bindSettingsToggles();
    }

    /** 渲染一行带开关的设置：label + 描述 + 可点开关 */
    function renderSettingsRow(label, key, desc) {
        const on = !!CONFIG[key];
        const bg = on ? '#ffb84d' : 'rgba(255,255,255,0.15)';
        const dot = on ? '#fff' : 'rgba(255,255,255,0.4)';
        const left = on ? '15px' : '2px';
        const id = 'dnf-set-' + key;
        return '' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin:3px 0">' +
                '<div style="flex:1;min-width:0">' +
                    '<div style="font-size:12px;color:#ffd76b">' + label + '</div>' +
                    '<div style="font-size:10px;color:#a79070">' + desc + '</div>' +
                '</div>' +
                '<div id="' + id + '" data-setkey="' + key + '" ' +
                    'style="width:26px;height:14px;border-radius:7px;background:' + bg + ';' +
                    'position:relative;cursor:pointer;flex:0 0 26px;margin-left:6px;transition:background .15s">' +
                    '<div style="position:absolute;top:1px;left:' + left + ';width:12px;height:12px;' +
                    'border-radius:50%;background:' + dot + ';transition:left .15s"></div>' +
                '</div>' +
            '</div>';
    }

    /** 渲染「面板位置」四角选择器：↖↗／↙↘ 两行两列，点击即切换停靠角 */
    function renderCornerPicker() {
        return '<div style="margin:6px 0;color:#ffd76b">自由定位：按住标题文字拖动，松手保存位置。</div>';

    }

    /** v5.81：设置面板底部的「检查更新」区块（当前版本 + 手动检查按钮 + 结果行） */
    function renderUpdateBlock() {
        return '<div style="margin-top:12px;padding:8px 10px;border:1px solid #56422f;border-radius:8px;background:#2b2118">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
                '<div style="min-width:0;flex:1 1 140px">' +
                    '<div style="font-size:12px;color:#ffd76b">当前版本 v' + VERSION + '</div>' +
                    '<div data-update-status="1" style="font-size:10px;color:#a79070;overflow-wrap:anywhere">联网检查更新（只提示，不自动安装）</div>' +
                '</div>' +
                '<button type="button" data-updatecheck="1" style="flex:0 0 auto;min-width:88px;min-height:32px;padding:6px 12px;' +
                    'border-radius:6px;border:1px solid #9b7645;background:#3a2b1c;color:#ffd76b;' +
                    'font:12px/1.2 Microsoft YaHei,sans-serif;cursor:pointer">检查更新</button>' +
            '</div></div>';
    }

    /** 渲染「模块顺序」：移动端用 ↑/↓ 调整六大模块的上下位置 */
    function renderModuleOrderRows() {
        const order = normalizedModuleOrder();
        const btnStyle = 'display:inline-flex;align-items:center;justify-content:center;' +
            'width:22px;height:22px;border-radius:4px;background:rgba(255,255,255,0.08);' +
            'border:1px solid rgba(255,184,77,0.35);color:#ffd76b;font-size:13px;line-height:1;' +
            'cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent';
        let html = '<div style="border-top:1px dashed rgba(255,184,77,0.35);margin:6px 0"></div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">' +
                '<span style="font-size:11px;color:#ffb84d;font-weight:700">模块顺序</span>' +
                '<span data-modreset="1" style="font-size:10px;color:#a79070;cursor:pointer;' +
                    'text-decoration:underline">恢复默认</span>' +
            '</div>';
        order.forEach((key, i) => {
            const def = MODULE_DEFS.find(d => d.key === key);
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin:2px 0">' +
                '<span style="font-size:11px;color:#ffd76b;white-space:nowrap;overflow:hidden;' +
                    'text-overflow:ellipsis">' + (i + 1) + '. ' + def.label + '</span>' +
                '<span style="display:flex;gap:4px;flex:0 0 auto;margin-left:6px">' +
                    '<span data-modmove="' + key + ':up" style="' + btnStyle + '">↑</span>' +
                    '<span data-modmove="' + key + ':down" style="' + btnStyle + '">↓</span>' +
                '</span></div>';
        });
        return html;
    }

    /** 为设置面板里的所有开关绑定点击事件（innerTML 重建后重绑） */
    function bindSettingsToggles(root = hudBodyEl) {
        const nodes = root.querySelectorAll('[data-setkey]');
        nodes.forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const k = el.getAttribute('data-setkey');
                CONFIG[k] = !CONFIG[k];
                saveSettings();
                log('设置变更:', k, '→', CONFIG[k]);
                // 立即生效的动作
                if (k === 'relocateTabsAfterSettlement') {
                    // 关闭时把之前挪走的 DOM 还原；开启时立即执行一次
                    if (CONFIG[k]) relocateTabsAfterSettlement();
                    else resetTabsPlacement();
                }
                if (k === 'hideGameAssistant') {
                    // 立即生效：给 <html> 加/去类，CSS 同时隐藏展开面板与折叠球
                    applyGameAssistantVisibility();
                }
                if (k === 'uiTheme') {
                    // 立即生效：整块移除 / 重新注入主题样式
                    applyUiTheme();
                }
                renderHud();
                renderSettingsPanel();
                showTip((CONFIG[k] ? '已开启' : '已关闭') + ': ' + k);
            });
        });

        // 「面板位置」四角选择器
        root.querySelectorAll('[data-corner]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                CONFIG.hudCorner = el.getAttribute('data-corner');
                CONFIG.hudPos = null;   // 选角落时清掉拖动坐标，回到吸附定位
                CONFIG.hudDock = null;  // 同时清掉左右停靠，避免旧的吸附侧覆盖角落选择
                saveSettings();
                log('面板位置变更:', CONFIG.hudCorner);
                applyHudPosition();
                renderHud();
                renderSettingsPanel();
                showTip('面板位置已切换');
            });
        });

        // 模块顺序：↑/↓ 调整 + 恢复默认
        root.querySelectorAll('[data-modmove]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const parts = (el.getAttribute('data-modmove') || '').split(':');
                if (!moveModule(parts[0], parts[1])) return;
                saveSettings();
                applyModuleOrder();
                hudLastHtml = '';   // 顺序变了，强制重绘
                renderHud();
                renderSettingsPanel();
            });
        });
        const resetMod = root.querySelector('[data-modreset]');
        if (resetMod) {
            resetMod.addEventListener('click', (e) => {
                e.stopPropagation();
                CONFIG.moduleOrder = MODULE_DEFAULT_ORDER.slice();
                saveSettings();
                applyModuleOrder();
                hudLastHtml = '';
                renderHud();
                renderSettingsPanel();
                showTip('模块顺序已恢复默认');
            });
        }

        // v5.81：「检查更新」按钮（手动检查忽略 24h 节流，结果同时写到状态行与 toast）
        const updateBtn = root.querySelector('[data-updatecheck]');
        if (updateBtn) {
            updateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const statusEl = root.querySelector('[data-update-status]');
                if (updateBtn.dataset.busy === '1') return;
                updateBtn.dataset.busy = '1';
                updateBtn.textContent = '检查中…';
                if (statusEl) statusEl.textContent = '正在检查…';
                const done = () => {
                    updateBtn.dataset.busy = '';
                    updateBtn.textContent = '检查更新';
                };
                // checkForUpdate 内部已兜住所有异常，这里只负责恢复按钮态
                Promise.resolve(checkForUpdate({ manual: true, statusEl: statusEl }))
                    .catch(() => { if (statusEl) statusEl.textContent = '检查失败，请稍后重试'; })
                    .then(done);
            });
        }
    }

    /** 把被 relocateTabsAfterSettlement 挪走的 DOM 还原到原位（三栏布局） */
    function resetTabsPlacement() {
        const main = document.querySelector('.main');
        const rightCol = document.querySelector('.right-col');
        const centerCol = document.querySelector('.center-col');
        if (!main || !rightCol || !centerCol) return;
        // 只把属于 right-col 的节点挪回 right-col（即之前 relocate 挪到 settle 后的那些）
        const rightKids = Array.from(centerCol.children).filter(c =>
            c.classList.contains('main-tabs') || c.classList.contains('tab-body'));
        rightKids.forEach(c => rightCol.appendChild(c));
    }

    /**
     * 从"最近结算"区块提取数据并做增量累加。
     * 截图中该区块格式为:
     *   最近结算  4秒
     *   击杀 4   通关 0
     *   金币 +888
     *   经验 +31320
     *
     * 统计口径（关键）：首次检测到的值只作为基线，不加入统计；
     * 之后只统计脚本启动后发生的增量。
     * 原因：游戏的"最近结算"区块可能显示脚本启动前就已存在的累计值，
     *       直接加进去会导致"刚上线就有大量击杀/通关"的错误统计。
     *
     * 击杀/通关：游戏内累计值，可能在结算后重置：
     *   - 首次：设基线，不加
     *   - 新值 > 基线：累加差值（本次新增的击杀/通关）
     *   - 新值 < 基线：结算重置，只更新基线为新值（之前的增量已计入）
     *   - 新值 = 基线：无变化
     *
     * 金币/经验：格式为 "+N"，表示本次结算的收益：
     *   - 首次：设基线，不加（这次结算发生在脚本启动前）
     *   - 新值 ≠ 基线：新一次结算，累加新值
     *   - 新值 = 基线：同一次结算，不加
     */
    function scanSettlement() {
        // 只读「最近结算」面板自身的 textContent（定向读取，不触发全页布局重排）
        const settleEl = document.querySelector('.panel.settle');
        if (!settleEl) return;
        const text = settleEl.textContent || '';
        // 只在"最近结算"区块内匹配。
        // 之前版本在找不到"最近结算"时退化到全页扫描，可能导致：
        //   扫描1：从"最近结算"读到"击杀 4" → 基线 4
        //   扫描2："最近结算"暂时消失，退化全页读到"累计击杀 656" → 656 > 4 → 误加 652
        // 修复：只信任"最近结算"这一个数据源，找不到就跳过本次扫描。
        const idx = text.indexOf('最近结算');
        if (idx < 0) return; // 没有"最近结算"区块，不扫描（避免数据源切换导致虚假增量）
        const seg = text.substring(idx, idx + 300);

        const mKills = seg.match(/击杀\s*(\d+)/);
        const mClears = seg.match(/通关\s*(\d+)/);
        const mGold = seg.match(/金币\s*\+?\s*(\d+)/);
        const mExp = seg.match(/经验\s*\+?\s*(\d+)/);

        const cur = {
            kills: mKills ? parseInt(mKills[1], 10) : null,
            clears: mClears ? parseInt(mClears[1], 10) : null,
            gold: mGold ? parseInt(mGold[1], 10) : null,
            exp: mExp ? parseInt(mExp[1], 10) : null,
        };

        let changed = false;

        // ===== 击杀 =====
        // 首次检测：仅设基线，不累加（避免把脚本启动前的历史击杀算进来）
        if (cur.kills !== null) {
            if (lastSettlement.kills === null) {
                lastSettlement.kills = cur.kills;
                log('击杀基线:', cur.kills, '（首次检测，仅设基线不统计）');
            } else if (cur.kills > lastSettlement.kills) {
                stats.kills += (cur.kills - lastSettlement.kills);
                changed = true;
                lastSettlement.kills = cur.kills;
            } else if (cur.kills < lastSettlement.kills) {
                // 结算重置：之前的增量已计入，只更新基线
                lastSettlement.kills = cur.kills;
            }
        }

        // ===== 通关 =====
        if (cur.clears !== null) {
            if (lastSettlement.clears === null) {
                lastSettlement.clears = cur.clears;
                log('通关基线:', cur.clears, '（首次检测，仅设基线不统计）');
            } else if (cur.clears > lastSettlement.clears) {
                stats.clears += (cur.clears - lastSettlement.clears);
                changed = true;
                lastSettlement.clears = cur.clears;
            } else if (cur.clears < lastSettlement.clears) {
                lastSettlement.clears = cur.clears;
            }
        }

        // ===== 金币（+N 形式，本次结算收益）=====
        if (cur.gold !== null) {
            if (lastSettlement.gold === null) {
                lastSettlement.gold = cur.gold;
                log('金币基线:', cur.gold, '（首次检测，仅设基线不统计）');
            } else if (cur.gold !== lastSettlement.gold) {
                // 数值变化 = 新一次结算，累加本次收益
                stats.gold += cur.gold;
                changed = true;
                lastSettlement.gold = cur.gold;
            }
        }

        // ===== 经验（+N 形式，本次结算收益）=====
        if (cur.exp !== null) {
            if (lastSettlement.exp === null) {
                lastSettlement.exp = cur.exp;
                log('经验基线:', cur.exp, '（首次检测，仅设基线不统计）');
            } else if (cur.exp !== lastSettlement.exp) {
                stats.exp += cur.exp;
                changed = true;
                lastSettlement.exp = cur.exp;
            }
        }

        if (changed) {
            renderHud();
            log('累计统计更新:', JSON.stringify(stats));
        }
    }

    /**
     * 扫描战斗日志中的"获得 XXX"条目，按三类统计掉落数量：
     *   - 消耗品：药剂、肉干、硬币、邀请函等可消耗物品
     *   - 材料：炉岩炭、魔力之花等 crafting 材料
     *   - 装备：戒指、武器、防具、首饰等装备类
     * 去重机制：同一物品名只统计一次（避免日志滚动时重复累加）。
     */
    // 物品分类关键词字典（按出现概率从高到低匹配）
    const DROP_CATEGORIES = {
        // 消耗品：药剂、肉、硬币、邀请函、卡片等可使用/可消耗物品
        consumable: [
            '药剂', '药水', '肉干', '肉', '硬币', '邀请函', '邀请书',
            '卡片', '卷轴', '书', '面包', '苹果', '香蕉', '酒',
            'HP药剂', 'MP药剂', '恢复药', '魔药',
        ],
        // 材料：炭、花、结晶、矿石、布料、皮革、灵魂等 crafting 材料
        material: [
            '炭', '煤', '花', '结晶', '晶石', '晶体', '矿石', '矿',
            '布料', '皮革', '皮', '灵魂', '碎片', '粉尘', '精华',
            '炉岩炭', '魔力之花', '扭曲', '魔石', '宝石', '原石',
        ],
        // 装备：戒指、项链、手镯、武器、上衣、下装、鞋、腰带、护肩、耳环、称号等
        equip: [
            '戒指', '项链', '手镯', '耳环', '称号', '光环', '翅膀',
            '武器', '上衣', '下装', '鞋', '腰带', '护肩', '帽子',
            '头发', '脸部', '胸部', '裤子', '盔甲', '剑', '刀',
            '杖', '枪', '弓', '斧', '锤', '手套', '念珠', '十字架',
            '图腾', '战斧', '镰刀', '矛', '棍棒', '匕首', '双剑',
            '光剑', '太刀', '短剑', '巨剑', '钝器', '左轮', '自动手枪',
            '步枪', '手弩', '指虎', '魔杖', '法杖', '扫把',
            '战镰', '长枪', '光矛',
        ],
        // 装备单字关键词（裤、腿、带、链、坠、镯、肩、甲、项、圈、棍、棒 等）
        // 单字匹配风险高，单独分组便于单独控制和扩展
        equipSingleChar: [
            '裤', '腿', '带', '链', '坠', '镯', '肩', '甲',
            '项', '圈', '棍', '棒',
        ],
    };

    function classifyDrop(itemName) {
        // 1. 优先精确匹配多字装备关键词
        for (const kw of DROP_CATEGORIES.equip) {
            if (itemName.includes(kw)) return 'equip';
        }
        // 2. 单字装备关键词匹配（裤/腿/带/链/坠/镯/肩 等）
        //    仅在词尾位置匹配，避免误伤词首（如"裤"匹配"长裤"而非"裤腰"）
        for (const kw of DROP_CATEGORIES.equipSingleChar) {
            if (itemName.endsWith(kw)) return 'equip';
        }
        // 3. 消耗品关键词
        for (const kw of DROP_CATEGORIES.consumable) {
            if (itemName.includes(kw)) return 'consumable';
        }
        // 4. 材料关键词
        for (const kw of DROP_CATEGORIES.material) {
            if (itemName.includes(kw)) return 'material';
        }
        // 未识别：默认归为材料（最常见）
        return 'material';
    }

    /**
     * 扫描角色状态栏，提取等级和经验进度，用于预测下一次升级时间。
     *
     * 主方法：直接查 GameView left-col 的 DOM（已确认类名）：
     *   .topbar .title            → 角色名
     *   .left-col .resource-panel → 资源面板
     *     .lv-row .lv             → "Lv.46"
     *     同 lv-row 里的 <span>   → " EXP cur / next"  或  "已达最高等级"
     *   这种方式比 body.innerText 靠谱得多（innerText 会受布局、换行影响）。
     *
     * 兜底方法：查全页 span 的 textContent（正则匹配 EXP \d+ / \d+）。
     */
    /** HUD 里显示的临时调试信息（空字符串则不显示） */
    let hudDebugInfo = '';
    let scanFailStreak = 0;   // 连续未命中等级/经验的次数，>10 时弹一次调试 tip

    function scanLevelExp() {
        // ===== 主方法：DOM 精确查询 GameView left-col =====
        let domLevel = null, domExpCur = null, domExpMax = null, domMax = false;

        const resourcePanel = document.querySelector('.left-col .resource-panel');
        const lvRow = resourcePanel ? resourcePanel.querySelector('.lv-row') : null;
        if (lvRow) {
            // 1) 等级
            const lvEl = lvRow.querySelector('.lv');
            if (lvEl) {
                const m = (lvEl.textContent || '').match(/Lv\.?\s*(\d+)/i);
                if (m) domLevel = parseInt(m[1], 10);
            }
            // 2) EXP / 满级标志：遍历 lvRow 下所有 span（两个兄弟 span）
            //    注意：EXP 数值位数随等级增长，不能用 \d{7,} 这种"大数字才匹配"的假设
            //    低等级（如 Lv.6）EXP 可能只有 3~5 位，这里改成 \d{1,}（至少 1 位）。
            //    由于我们只在 lv-row 的 span 里匹配，不会误命中其它地方。
            const spans = lvRow.querySelectorAll('span');
            for (const sp of spans) {
                const t = (sp.textContent || '').trim();
                if (/已达最高等级|已满级/.test(t)) { domMax = true; }
                const em = t.match(/EXP\s+(\d{1,})\s*\/\s*(\d{1,})/i);
                if (em) {
                    const c = parseInt(em[1], 10);
                    const mx = parseInt(em[2], 10);
                    // 经验上限必须大于当前值，且至少是 1 才视为有效；
                    // 不再要求"大于 1000000"——低等级人物 EXP 本来就很小
                    if (mx > c && mx >= 1) { domExpCur = c; domExpMax = mx; }
                }
            }
        }

        // ===== 兜底：全页扫 span/div 的 textContent =====
        let fbLevel = null, fbExpCur = null, fbExpMax = null, fbMax = false;
        if (domLevel === null || domExpCur === null) {
            const allSpans = document.querySelectorAll('span,div');
            for (const el of allSpans) {
                const t = (el.textContent || '').trim();
                if (!t || t.length > 100) continue;
                if (/已达最高等级|已满级/.test(t)) { fbMax = true; }
                const em = t.match(/(?:EXP|经验)\s+(\d{1,})\s*\/\s*(\d{1,})/i);
                if (em) {
                    const c = parseInt(em[1], 10);
                    const mx = parseInt(em[2], 10);
                    if (mx > c && mx >= 1 && fbExpCur === null) {
                        fbExpCur = c; fbExpMax = mx;
                    }
                }
                const lm = t.match(/Lv\.?\s*(\d+)/i);
                if (lm && fbLevel === null) {
                    const n = parseInt(lm[1], 10);
                    // 去掉 "Lv.N EXP ..." 这种同行 span（避免和 EXP span 混）
                    if (n >= 1 && n <= 100 && !/Lv\.\d+.*EXP/.test(t)) fbLevel = n;
                }
            }
        }

        // 合并：DOM 优先，兜底其次
        const level = domLevel !== null ? domLevel : fbLevel;
        const expCur = domExpCur !== null ? domExpCur : fbExpCur;
        const expMax = domExpMax !== null ? domExpMax : fbExpMax;
        const maxed = domMax || fbMax;

        // ===== 写入 HUD =====
        let changed = false;
        if (level !== null && currentLevel !== level) {
            currentLevel = level;
            changed = true;
        }
        if (maxed) {
            if (currentExp !== null || maxExp !== null) {
                currentExp = null; maxExp = null;
                changed = true;
            }
        } else if (expCur !== null && expMax !== null) {
            if (currentExp !== expCur || maxExp !== expMax) {
                currentExp = expCur; maxExp = expMax;
                changed = true;
            }
        }

        // ===== 调试：每次命中都写 log（前 3 次 + 身份变化时），失败 10 次弹临时 HUD =====
        if (level === null && expCur === null && !maxed) {
            scanFailStreak++;
            if (scanFailStreak === 10) {
                log('scanLevelExp 连续失败 10 次，调试：', { domLevel, domExpCur, domExpMax, domMax, fbLevel, fbExpCur, fbExpMax, fbMax });
                hudDebugInfo = '（未找到等级/经验 DOM，可能在非战斗页）';
                changed = true;
            }
        } else {
            // 命中后前 3 次写 log，之后只在 changed 时写（避免刷屏）
            if (scanFailStreak > 0 || hudDebugInfo) {
                scanFailStreak = 0;
                hudDebugInfo = '';
                changed = true;
            }
            if ((scanLogCount < 3) || changed) {
                scanLogCount++;
                log('scanLevelExp:', { level, expCur, expMax, maxed });
            }
        }

        if (changed) renderHud();
    }

    /** 从游戏原生「挂机助手」浮窗读取复活次数与药水数量（隐藏浮窗后仍可读 DOM 文本） */
    function scanAssistStats() {
        const el = document.querySelector('.assist, .assist-collapsed');
        if (!el) return;
        const text = (el.textContent || '').replace(/\s+/g, ' ');
        let m = text.match(/复活\s*([\d,]+)\s*次/);
        if (m) reviveCount = parseInt(m[1].replace(/,/g, ''), 10);
        m = text.match(/药水\s*[×x]?\s*([\d,]+)/);
        if (m) potionCount = parseInt(m[1].replace(/,/g, ''), 10);
    }
    /** scanLevelExp 成功命中的日志计数器（避免每次轮询都 log） */
    let scanLogCount = 0;

    /* ============================================================
     * 掉落物日志本地存储
     * 游戏内"战斗日志"每次新战斗都会覆盖上一场，这里只提取其中的掉落物信息
     * （loot 事件"获得 X"、epic 事件"史诗掉落 X"），累积保存（最多 battleLogMax 条），
     * 并提供可滚动的查看器，同时统计掉落物（含史诗）。
     * 说明：仍会读取全部日志行用于判断"是否进入新一场战斗"，
     *       但只有掉落物行会被展示与统计。
     * ============================================================ */

    /**
     * 从页面提取战斗日志行（直接读取 DOM，而不是 innerText）。
     * 游戏(Vue)战斗日志结构：
     *   .panel.battle-log  >  .bl-box  >  多个 .bl-line
     * 每个 .bl-line = 一个时间 <span>(M:SS) + 若干 .bl-frag 文本片段。
     * 关键：.bl-line 是 flex 布局，用 innerText 会把时间与每个片段拆成多行，
     *      导致旧版只能读到 "0:03" 这种纯时间行、拿不到掉落内容。
     *      所以这里改为直接读 DOM：时间取首个子元素，内容拼接所有 .bl-frag。
     */
    function extractLogLines() {
        const box = document.querySelector('.panel.battle-log .bl-box') || document.querySelector('.bl-box');
        if (!box) return [];
        const out = [];
        const rows = box.querySelectorAll('.bl-line');
        for (const row of rows) {
            // 时间：首个子元素（文本形如 M:SS）
            let time = '';
            const first = row.firstElementChild;
            if (first && /^\d{1,2}:\d{2}$/.test((first.textContent || '').trim())) {
                time = first.textContent.trim();
            }
            // 内容：拼接该行所有 .bl-frag 片段（如 "获得 " + "诺顿的达人HP药剂"）
            let text = '';
            const frags = row.querySelectorAll('.bl-frag');
            for (const f of frags) text += (f.textContent || '');
            text = text.replace(/\s+/g, ' ').trim();
            if (!text) continue;
            out.push(time ? (time + ' ' + text) : text);
        }
        return out;
    }

    /** 解析日志行时间戳为秒，如 "0:03" → 3 */
    function parseLineSec(line) {
        const m = /^(\d{1,2}):(\d{2})/.exec(line);
        return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
    }

    /** 从单条日志行统计掉落物（史诗优先；否则按 消耗品/材料/装备 归类） */
    function countDropFromLine(line) {
        // 掉落物名称：loot 事件为"获得 X"，epic 事件为"史诗掉落 X"
        let rest = null;
        let isEpic = false;
        const em = line.match(/史诗掉落\s*(.+)$/);
        if (em) {
            rest = em[1].trim();
            isEpic = true;
        } else {
            const m = line.match(/获得\s*(.+)$/);
            if (!m) return;
            rest = m[1].trim();
            // 名称里含"史诗"也按史诗计（兜底）
            if (/史诗/.test(rest)) isEpic = true;
        }
        // 数量（如 "×5" / "x5"），无则计 1
        let qty = 1;
        const qm = rest.match(/[x×]\s*(\d+)/i);
        if (qm) qty = parseInt(qm[1], 10) || 1;
        if (isEpic) {
            stats.drops.epic += qty;
            const displayName = rest.replace(/[x×]\s*\d+/ig, '').trim();
            log('史诗掉落统计 +' + qty, '（', rest, '）');
            // 史诗掉落弹出浮动提示 + 金光窗口
            showTip('史诗掉落：' + displayName + (qty > 1 ? (' ×' + qty) : ''));
            showEpicPopup(displayName + (qty > 1 ? (' ×' + qty) : ''));
            return;
        }
        // 提取物品名：去掉括号备注、数量、稀有度标记
        const name = rest.replace(/[（(][^）)]*[）)]/g, '')
            .replace(/[x×]\s*\d+/ig, '')
            .replace(/史诗|神器|传说|勇者|稀有|高级|普通/g, '')
            .replace(/^[\s·:：\-]+/, '')
            .trim();
        if (!name || name.length < 2) return;
        const cat = classifyDrop(name);
        stats.drops[cat] += qty;
        log('掉落物:', name, 'x' + qty, '-> 分类:', cat);
    }

    /** 判断一条日志行是否为史诗掉落（与 countDropFromLine 的口径一致） */
    function isEpicDropLine(line) {
        if (/史诗掉落/.test(line)) return true;
        const m = line.match(/获得\s*(.+)$/);
        return !!(m && /史诗/.test(m[1]));
    }

    /** 提取史诗掉落行的"物品名"作为去重 key（忽略时间前缀与数量） */
    function epicItemKey(line) {
        let rest;
        const em = line.match(/史诗掉落\s*(.+)$/);
        if (em) rest = em[1];
        else {
            const m = line.match(/获得\s*(.+)$/);
            rest = m ? m[1] : line;
        }
        return rest.replace(/[x×]\s*\d+/ig, '').replace(/\s+/g, ' ').trim();
    }

    /**
     * 判断该史诗行是否属于「重复统计」应跳过。
     * 场景：离线后重新上线，游戏会把离线期间的战斗事件（含"史诗掉落 X"）
     *      作为「最近结算」重放；这段重放可能被脚本多次读到（重渲染 / 结算面板刷新），
     *      若不做去重，同一件史诗就会被累加两次。
     * 策略：同一件史诗在 EPIC_DEDUP_WINDOW_MS 窗口内只统计一次。
     */
    function isDuplicateEpicDrop(line) {
        if (!isEpicDropLine(line)) return false;
        const key = epicItemKey(line);
        if (!key) return false;
        const now = Date.now();
        const prev = epicSeenMap.get(key);
        if (prev != null && (now - prev) < EPIC_DEDUP_WINDOW_MS) return true;
        epicSeenMap.set(key, now);
        // 顺带清理过期 key，避免长时间挂机后 Map 无限增长
        if (epicSeenMap.size > 100) {
            for (const [k, t] of epicSeenMap) {
                if (now - t >= EPIC_DEDUP_WINDOW_MS) epicSeenMap.delete(k);
            }
        }
        return false;
    }

    /**
     * 从单条日志行统计技能释放次数与输出伤害。
     * 游戏日志行示例（时间前缀已去掉）：
     *   「怒气爆发」                    → 行首「技能名」= 一次释放（cast）
     *   「怒气爆发」 巨鼠 -1497 暴击    → 该技能输出 1497
     *   巨鼠 -320 持续伤害              → 无技能名，归入"持续伤害"
     *   巨鼠 -500 装备特效              → 归入"装备特效"
     *   "受到 巨鼠 51 伤害" 是玩家受伤（正数），不计入输出。
     * 注意：只有"行首"的「X」才算释放计数，避免把
     *   "门票不足，离开远古副本，返回「深渊」" 这类文案误判成技能。
     */
    function countSkillFromLine(line) {
        const body = line.replace(/^\d{1,2}:\d{2}\s*/, '');
        const lead = /^「([^」]+)」/.exec(body);   // 行首的技能名 = 一次释放
        let dmg = 0;
        const dms = body.match(/-(\d+)/g);
        if (dms) { for (const d of dms) dmg += parseInt(d.slice(1), 10) || 0; }
        if (!lead && dmg <= 0) return;
        let name;
        if (lead) name = lead[1];
        else if (body.indexOf('持续伤害') >= 0) name = '持续伤害';
        else if (body.indexOf('装备特效') >= 0) name = '装备特效';
        else name = '其它';
        const rec = skillStats.bySkill[name] || (skillStats.bySkill[name] = { casts: 0, damage: 0 });
        if (lead) { rec.casts++; skillStats.casts++; }
        rec.damage += dmg;
        skillStats.damage += dmg;
    }

    /** 抓取日志增量：diff 上一次快照，把新增行存入历史并统计掉落/技能 */
    function scanBattleLog() {
        const cur = extractLogLines();
        if (cur.length === 0) return;
        let newLines = [];
        let newBattle = false;
        if (lastLogLines.length === 0) {
            newBattle = true;
            newLines = cur.slice();
        } else {
            const firstCur = parseLineSec(cur[0]);
            const firstLast = parseLineSec(lastLogLines[0]);
            if (firstCur !== null && firstLast !== null && firstCur < firstLast) {
                // 首行时间戳回退 → 新一场战斗（日志被覆盖重置）
                newBattle = true;
                newLines = cur.slice();
            } else {
                // 同一场：取 lastLogLines 后缀 与 cur 前缀 的最长重叠，剩余部分即新增行
                const maxK = Math.min(lastLogLines.length, cur.length);
                let k = 0;
                for (let t = maxK; t > 0; t--) {
                    let ok = true;
                    for (let i = 0; i < t; i++) {
                        if (lastLogLines[lastLogLines.length - t + i] !== cur[i]) { ok = false; break; }
                    }
                    if (ok) { k = t; break; }
                }
                if (k === 0) {
                    // 与上一场完全没有重叠 → 日志被整体替换，判定为新一场战斗
                    newBattle = true;
                    newLines = cur.slice();
                } else {
                    newLines = cur.slice(k);
                }
            }
        }
        lastLogLines = cur;
        if (newLines.length === 0) return;
        if (newBattle) battleCounter++;
        // 全部新增行：统计技能释放/输出
        for (const ln of newLines) countSkillFromLine(ln);
        saveSkillStats();
        // 只收录掉落物信息（loot："获得 X" / epic："史诗掉落 X"），其它行不展示、不统计
        const dropLines = newLines.filter(ln =>
            ln.indexOf('获得') >= 0 || ln.indexOf('史诗掉落') >= 0);
        for (const ln of dropLines) {
            // 史诗去重：离线重放（最近结算）会把同一件史诗多次送到日志，
            // 这里跳过时间窗内重复的史诗行，避免「离线收益」重复统计史诗。
            if (isDuplicateEpicDrop(ln)) {
                log('跳过重复史诗（离线收益重放）:', ln);
                continue;
            }
            logHistory.push({ b: battleCounter, text: ln });
            if (logHistory.length > CONFIG.battleLogMax) logHistory.shift();
            countDropFromLine(ln);
        }
        saveLogHistory();
        renderHud();
        if (logViewerEl && document.body.contains(logViewerEl)) renderLogContent();
    }

    /* ---------- 战斗日志查看器（可滚动） ---------- */
    let logViewerEl = null;

    function renderDropTab(list) {
        if (logHistory.length === 0) {
            list.textContent = '暂无掉落记录';
            return;
        }
        let lastBattle = null;
        for (const e of logHistory) {
            if (e.b !== lastBattle) {
                lastBattle = e.b;
                const h = document.createElement('div');
                h.textContent = '— 第 ' + e.b + ' 场 —';
                h.style.cssText = 'color:#ffb84d;opacity:.7;margin:6px 0 2px;font-size:11px';
                list.appendChild(h);
            }
            const isEpicLine = e.text.indexOf('史诗掉落') >= 0 || /史诗/.test(e.text);
            const d = document.createElement('div');
            d.textContent = e.text;
            // 史诗掉落行标金加粗
            d.style.cssText = 'word-break:break-all;line-height:1.5;' +
                (isEpicLine ? 'color:#ffb84a;font-weight:700' : 'color:#ccc');
            list.appendChild(d);
        }
    }

    function renderSkillTab(list) {
        // 用 hudStartTime 作为时间窗：和 HUD 上的"挂机时长"口径一致；
        // 即便 skillStats 是更早加载的存档也没关系 —— 这是全局视角的 DPS
        const elapsedSec = Math.max(1, Math.floor((Date.now() - hudStartTime) / 1000));
        const totalDps = skillStats.damage > 0 ? Math.round(skillStats.damage / elapsedSec) : 0;

        const rows = Object.keys(skillStats.bySkill)
            .map(name => {
                const s = skillStats.bySkill[name];
                return {
                    name,
                    casts: s.casts,
                    damage: s.damage,
                    avg: s.casts > 0 ? Math.round(s.damage / s.casts) : 0,
                    dps: s.damage > 0 ? Math.round(s.damage / elapsedSec) : 0,
                };
            })
            .sort((a, b) => b.damage - a.damage || b.casts - a.casts);
        if (rows.length === 0) { list.textContent = '暂无技能统计'; return; }

        const head = document.createElement('div');
        head.style.cssText = 'color:#ffb84d;font-size:11px;margin:0 0 6px';
        head.textContent = '总输出 ' + fmtNum(skillStats.damage) +
            ' · 总释放 ' + skillStats.casts + ' 次' +
            ' · 总 DPS ' + fmtNum(totalDps);
        list.appendChild(head);

        const totalDmg = skillStats.damage || 1;
        const totalCasts = skillStats.casts || 1;
        for (const r of rows) {
            const box = document.createElement('div');
            box.style.cssText = 'margin:6px 0;padding-bottom:5px;' +
                'border-bottom:1px dashed rgba(255,184,77,.18)';
            const nameEl = document.createElement('div');
            nameEl.textContent = '「' + r.name + '」';
            nameEl.style.cssText = 'color:#8ecbff;font-weight:700';
            const statEl = document.createElement('div');
            statEl.style.cssText = 'color:#bbb';
            statEl.innerHTML =
                '释放 <b style="color:#ffd76b">' + r.casts + '</b> 次' +
                '（占 ' + Math.round(r.casts / totalCasts * 100) + '%）' +
                ' · 输出 <b style="color:#ffd76b">' + fmtNum(r.damage) + '</b>' +
                '（占 ' + Math.round(r.damage / totalDmg * 100) + '%）' +
                '<br>' +
                '平均伤害 <b style="color:#ffd76b">' + fmtNum(r.avg) + '</b>' +
                ' · DPS <b style="color:#ffd76b">' + fmtNum(r.dps) + '</b>';
            box.appendChild(nameEl);
            box.appendChild(statEl);
            list.appendChild(box);
        }
    }

    function renderLogContent() {
        if (!logViewerEl || !document.body.contains(logViewerEl)) return;
        const list = logViewerEl.querySelector('.dnf-log-list');
        if (!list) return;
        // 记录刷新前的滚动状态：用户在底部时跟随最新；否则保持当前位置，
        // 避免上翻查看旧日志时被新掉落打断、强行跳回底部
        const prevTop = list.scrollTop;
        const atBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) <= 8;
        list.innerHTML = '';
        if (activeLogTab === 'skill') renderSkillTab(list);
        else renderDropTab(list);
        if (atBottom) list.scrollTop = list.scrollHeight;   // 本来就在底部 → 自动跟随最新
        else list.scrollTop = prevTop;                      // 正在上翻阅读 → 保持原位置
        // 高亮当前页签
        const tabs = logViewerEl.querySelectorAll('.dnf-log-tab');
        Array.prototype.forEach.call(tabs, t => {
            const on = t.getAttribute('data-tab') === activeLogTab;
            t.style.color = on ? '#ffb84d' : '#888';
            t.style.borderBottom = on ? '2px solid #ffb84d' : '2px solid transparent';
        });
    }

    function toggleLogViewer() {
        if (logViewerEl && document.body.contains(logViewerEl)) {
            logViewerEl.remove();
            logViewerEl = null;
            return;
        }
        logViewerEl = document.createElement('div');
        // 限高到视口内，保证即使屏幕很短、面板底部也始终可见可点
        logViewerEl.style.cssText = 'position:fixed;top:70px;right:10px;z-index:999999;' +
            'width:min(88vw,380px);max-height:calc(100vh - 84px);display:flex;flex-direction:column;' +
            'background:rgba(15,10,6,.97);border:1px solid rgba(255,184,77,.5);border-radius:8px;' +
            'color:#ddd;font:12px/1.5 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;' +
            'box-shadow:0 4px 20px rgba(0,0,0,.6);overflow:hidden;overscroll-behavior:contain';

        // 在面板内滚动时阻止事件冒泡到游戏页面，避免连带滚动游戏视图（滚动链已用 overscroll-behavior 兜底）
        const stopScrollChain = (e) => { e.stopPropagation(); };
        logViewerEl.addEventListener('wheel', stopScrollChain, { passive: true });
        logViewerEl.addEventListener('touchmove', stopScrollChain, { passive: true });

        const head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
            'padding:6px 10px;border-bottom:1px solid rgba(255,184,77,.3)';

        // 页签：掉落 / 技能
        const tabsWrap = document.createElement('span');
        tabsWrap.style.cssText = 'display:flex;gap:14px';
        const mkTab = (label, tab) => {
            const b = document.createElement('span');
            b.className = 'dnf-log-tab';
            b.setAttribute('data-tab', tab);
            b.textContent = label;
            b.style.cssText = 'cursor:pointer;padding:2px 0;font-weight:700';
            b.addEventListener('click', () => { activeLogTab = tab; renderLogContent(); });
            return b;
        };
        tabsWrap.appendChild(mkTab('掉落', 'drop'));
        tabsWrap.appendChild(mkTab('技能', 'skill'));

        const btns = document.createElement('span');
        const clearBtn = document.createElement('span');
        clearBtn.textContent = '清空';
        clearBtn.style.cssText = 'color:#ff7676;cursor:pointer;padding:0 6px';
        clearBtn.addEventListener('click', () => {
            logHistory = [];
            lastLogLines = [];
            battleCounter = 0;
            skillStats = { casts: 0, damage: 0, bySkill: {} };
            saveLogHistory();
            saveSkillStats();
            renderLogContent();
        });
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'color:#999;cursor:pointer;padding:0 6px';
        closeBtn.addEventListener('click', () => {
            if (logViewerEl) logViewerEl.remove();
            logViewerEl = null;
        });
        btns.appendChild(clearBtn);
        btns.appendChild(closeBtn);
        head.appendChild(tabsWrap);
        head.appendChild(btns);

        const list = document.createElement('div');
        list.className = 'dnf-log-list';
        // min-height:0 是关键：flex 子项默认 min-height:auto 不会收缩，
        // 会导致列表超出面板被裁掉、底部滚不到
        list.style.cssText = 'overflow-y:auto;padding:8px 10px;flex:1;min-height:0;' +
            'overscroll-behavior:contain;-webkit-overflow-scrolling:touch';

        logViewerEl.appendChild(head);
        logViewerEl.appendChild(list);
        document.body.appendChild(logViewerEl);
        const grip=document.createElement('div');grip.textContent='日志记录 · 拖动';grip.style.cssText='padding:7px 10px;color:#c5a875;border-bottom:1px solid #725330';
        logViewerEl.prepend(grip);
        makeFloatingDraggable(logViewerEl,grip,'logs',{left:Math.max(8,innerWidth-400),top:70});
        renderLogContent();
    }

    /**
     * 登录检测（仅记录状态，不再自动重置统计）。
     * 之前自动重置导致：切到"战斗日志"页时角色面板不可见，
     * 被误判为登出 → 切回又误判登录 → 反复清零，金币/经验永远为 0。
     * 现在改为：只在脚本启动时初始化一次状态，重置交给 HUD 上的手动按钮。
     */
    let isLoggedIn = false;

    function checkLoginAndReset() {
        // 定向判断：GameView 挂载后才会有 .resource-panel（等级/金币/血条面板）
        const loggedIn = isInGame() && !!document.querySelector('.main .resource-panel');
        if (loggedIn && !isLoggedIn) {
            isLoggedIn = true;
            log('检测到已登录，挂机统计已就绪（如需清零请点 HUD 右上角 ⟲ 按钮）');
        }
    }

    /** 重置所有统计：清零累计数据、清空已记录掉落、重置挂机时长起点 */
    function resetStats() {
        reviveCount = null;   // 复活次数（下次扫描挂机浮窗时更新）
        potionCount = null;   // 药水数量（下次扫描挂机浮窗时更新）
        currentLevel = null;          // 等级（下次重新提取）
        currentExp = null;            // 经验当前值
        maxExp = null;                // 经验上限
        stats.kills = 0;
        stats.clears = 0;
        stats.gold = 0;
        stats.exp = 0;
        stats.drops.consumable = 0;
        stats.drops.material = 0;
        stats.drops.equip = 0;
        stats.drops.epic = 0;
        lastSettlement = { kills: null, clears: null, gold: null, exp: null };
        epicSeenMap.clear();
        scanFailStreak = 0;
        hudDebugInfo = '';
        lastLogLines = [];
        battleCounter = 0;
        logHistory = [];
        saveLogForChar(currentCharName);      // 手动重置立即落盘，避免节流延迟后又写回旧数据
        skillStats = { casts: 0, damage: 0, bySkill: {} };
        saveSkillStatsForChar(currentCharName);
        hudStartTime = Date.now();   // 重置挂机时长起点
        renderHud();
    }

    /* ============================================================
     * 样式注入：怪物列表两列 + 史诗金光弹窗动画
     * ============================================================ */
    function injectStyles() {
        if (document.getElementById('dnf-helper-style')) return;
        const st = document.createElement('style');
        st.id = 'dnf-helper-style';
        st.textContent = [
            // ===== 怪物血条（v5.80）=====
            // 只约束「轨道」：宽度跟随卡片可用的 100%，桌面仍被 110px 上限保持原样；
            // 绝不给 .monster-hp-fill 设 max-width / overflow，否则会压住百分比伸缩。
            // fill 由游戏内联 width:xx% 驱动（相对轨道），插件再用 JS 提高小数精度（见 runMonsterHpPrecision）。
            '.monster .monster-hp{width:100% !important;max-width:110px;min-width:0;box-sizing:border-box}',
            '.monster .monster-info{min-width:0}',
            // ===== 仓库页区块顺序（v5.72，替换 v5.68 的「仓库道具」置顶）=====
            // .bag-tab 本身是 flex column，直接用 order 调整子项展示顺序，不改游戏 DOM 结构。
            // 目标顺序：标签栏 bag-head 最前 → 仓库装备 → 仓库材料 → 其余（仓库道具/通关秘宝盒/
            // 工具栏/账号共享说明/背包装备/背包材料 保持自然顺序）。
            '.bag-tab>.bag-head{order:-10 !important}',
            '.bag-tab>.dnf-wh-equip-head{order:-9 !important}',
            '.bag-tab>.dnf-wh-equip-chips{order:-9 !important}',
            '.bag-tab>.dnf-wh-equip-grid{order:-9 !important}',
            '.bag-tab>.dnf-wh-mat-head{order:-8 !important}',
            '.bag-tab>.dnf-wh-mat-chips{order:-8 !important}',
            '.bag-tab>.dnf-wh-mat-grid{order:-8 !important}',
            // 仓库道具排在「仓库材料」之后、其它区块之前（与需求里「其余」第一项一致）
            '.bag-tab>.dnf-wh-items-head{order:-7 !important}',
            '.bag-tab>.dnf-wh-items-grid{order:-7 !important}',
            '.bag-tab>.dnf-wh-items-empty{order:-7 !important}',
            // ===== 物品详情「存仓」按钮（v5.68）=====
            '.dnf-deposit-box{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:4px}',
            '.dnf-deposit-box .dnf-deposit-label{font-size:12px;color:#c8b593}',
            '.dnf-deposit-box .dnf-deposit-qty{width:64px;height:30px;padding:0 6px;border-radius:6px;' +
                'border:1px solid #8f6d3f;background:#241a12;color:#f4e2c2;' +
                'font:12px/1 Microsoft YaHei,sans-serif;text-align:center}',
            '.dnf-deposit-box .dnf-deposit-qty:disabled{opacity:.6}',
            '.dnf-deposit-box .dnf-deposit-btn[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-deposit-box .dnf-deposit-msg{flex:0 0 100%;font-size:12px;line-height:1.35;' +
                'margin-top:2px;color:#c8b593}',
            '.dnf-deposit-box .dnf-deposit-msg.is-ok{color:#8ee6a0}',
            '.dnf-deposit-box .dnf-deposit-msg.is-err{color:#ff9a9a}',
            // ===== 仓库装备详情「确认取出」浮层（v5.77）=====
            // 只给插件自己新增的节点上样式，不动游戏原生按钮
            '.dnf-withdraw-box{flex:1 1 100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;' +
                'margin-top:2px;padding-top:8px;border-top:1px dashed #56422f}',
            '.dnf-withdraw-box .dnf-withdraw-btn{flex:0 0 auto;min-width:112px;padding:9px 14px;border-radius:6px;' +
                'cursor:pointer;border:1px solid #c7751a;background:linear-gradient(180deg,#f0a23d,#d47e1c);' +
                'color:#1a1206;font:700 13px/1 Microsoft YaHei,sans-serif}',
            '.dnf-withdraw-box .dnf-withdraw-btn[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-withdraw-box .dnf-withdraw-cancel{flex:0 0 auto;min-width:72px;padding:9px 12px;border-radius:6px;' +
                'cursor:pointer;border:1px solid #8f6d3f;background:#2a2118;color:#e6d3b3;' +
                'font:13px/1 Microsoft YaHei,sans-serif}',
            '.dnf-withdraw-box .dnf-withdraw-cancel[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-withdraw-box .dnf-withdraw-msg{flex:0 0 100%;font-size:12px;line-height:1.35;color:#c8b593}',
            '.dnf-withdraw-box .dnf-withdraw-msg.is-err{color:#ff9a9a}',
            '.dnf-withdraw-box .dnf-withdraw-msg.is-ok{color:#8ee6a0}',
            // ===== 仓库材料「自选数量取出」弹窗（v5.80）=====
            // 只加插件自己的遮罩层，不改游戏原生格子与按钮
            '.dnf-qty-mask{position:fixed;inset:0;z-index:1000002;display:flex;align-items:center;' +
                'justify-content:center;padding:16px;background:#0008}',
            '.dnf-qty-panel{width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);' +
                'box-sizing:border-box;overflow-y:auto;padding:14px 16px;border-radius:12px;' +
                'border:1px solid #9b7645;background:#211a13;color:#edddc3;' +
                'box-shadow:0 12px 36px #0009;font:13px/1.5 Microsoft YaHei,sans-serif;' +
                'overflow-wrap:anywhere;word-break:break-word}',
            '.dnf-qty-title{color:#ffd794;font-size:15px;font-weight:700;margin-bottom:4px}',
            '.dnf-qty-sub{color:#baa78e;font-size:12px;margin-bottom:10px}',
            '.dnf-qty-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
            '.dnf-qty-label{color:#c8b593;font-size:12px}',
            '.dnf-qty-input{width:120px;height:34px;padding:0 8px;border-radius:6px;' +
                'border:1px solid #8f6d3f;background:#241a12;color:#f4e2c2;' +
                'font:13px/1 Microsoft YaHei,sans-serif;text-align:center}',
            '.dnf-qty-input:disabled{opacity:.6}',
            '.dnf-qty-msg{min-height:18px;font-size:12px;line-height:1.35;color:#c8b593}',
            '.dnf-qty-msg.is-err{color:#ff9a9a}',
            '.dnf-qty-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:4px}',
            '.dnf-qty-actions button{min-width:88px;min-height:34px;padding:0 14px;border-radius:6px;' +
                'cursor:pointer;font:700 13px/1 Microsoft YaHei,sans-serif}',
            '.dnf-qty-ok{border:1px solid #c7751a;background:linear-gradient(180deg,#f0a23d,#d47e1c);color:#1a1206}',
            '.dnf-qty-ok[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-qty-cancel{border:1px solid #8f6d3f;background:#2a2118;color:#e6d3b3}',
            '.dnf-qty-cancel[disabled]{opacity:.55;cursor:not-allowed}',
            // ===== HUD 移动端自适应（v5.78）=====
            // 内容永远在 220px（或窄屏收缩后的宽度）内换行，不撑破面板
            '.dnf-hud{overflow-wrap:anywhere;word-break:break-word}',
            '.dnf-hud .dnf-hud-header{min-width:0}',
            // 可用宽度 < 340px：紧凑排版（更小字号/内边距 + 更小圆形按钮）
            '.dnf-hud-compact .dnf-hud-header{padding:5px 8px !important}',
            '.dnf-hud-compact .dnf-hud-header span[title]{width:22px !important;height:22px !important;' +
                'min-width:22px !important;min-height:22px !important}',
            '.dnf-hud-compact .dnf-hud-header span[title] svg{width:12px;height:12px}',
            // ===== 设置面板移动端自适应（v5.79）=====
            // 面板本身与内容都不得横向撑破；内容区纵向滚动
            '.dnf-settings-panel{box-sizing:border-box;max-width:calc(100vw - 16px);' +
                'overflow-wrap:anywhere;word-break:break-word}',
            '.dnf-settings-panel *{min-width:0}',
            '.dnf-settings-panel .dnf-settings-body{overflow-y:auto;overflow-x:hidden}',
            // 触摸目标不小于 32px：关闭按钮 / 模块排序箭头 / 开关热区
            '.dnf-settings-panel button{min-width:32px;min-height:32px}',
            '.dnf-settings-panel [data-modmove]{min-width:32px !important;min-height:32px !important}',
            // v5.79：「恢复默认」也是可点区域，撑到 32px 高，避免窄屏误触
            '.dnf-settings-panel [data-modreset]{display:inline-flex;align-items:center;' +
                'min-height:32px;padding:0 6px}',
            '.dnf-settings-panel [data-setkey]::after{content:"";position:absolute;' +
                'left:-6px;right:-6px;top:-9px;bottom:-9px}',
            // ===== 通关秘宝盒「全开」按钮（v5.69）=====
            // 只在秘宝盒面板顶部挂一行，不改动游戏原有的「开 1 个 / 开 10 个」按钮与行结构。
            '.dnf-clearbox-head{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:0 2px}',
            '.dnf-clearbox-head .dnf-clearbox-all[data-busy="1"]{color:#ffd794}',
            // 史诗金光弹窗动画
            '@keyframes dnfEpicSheen{0%{background-position:0% 0%}100%{background-position:200% 200%}}',
            '@keyframes dnfEpicShine{0%{background-position:-150% 0}100%{background-position:250% 0}}',
            '@keyframes dnfEpicGlow{0%,100%{filter:brightness(1);transform:translate(-50%,-50%) scale(1)}' +
                '50%{filter:brightness(1.35);transform:translate(-50%,-50%) scale(1.03)}}',
            '.dnf-epic-modal{position:fixed;left:50%;top:50%;z-index:1000000;width:min(84vw,320px);' +
                'padding:3px;border-radius:14px;' +
                'background:linear-gradient(135deg,#ffe98a,#ffb84a,#fff6cc,#ff9d00,#ffd84a);' +
                'background-size:200% 200%;' +
                'animation:dnfEpicSheen 3s linear infinite,dnfEpicGlow 1.6s ease-in-out infinite;' +
                'box-shadow:0 0 24px #ffb84a,0 0 48px rgba(255,168,0,.6);transform:translate(-50%,-50%)}',
            '.dnf-epic-inner{position:relative;border-radius:12px;overflow:hidden;padding:14px 16px;' +
                'background:radial-gradient(circle at 50% 0%,#3a2a08,#140d04 70%)}',
            '.dnf-epic-inner::after{content:"";position:absolute;inset:0;pointer-events:none;' +
                'background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.35) 50%,transparent 60%);' +
                'background-size:250% 100%;animation:dnfEpicShine 2.2s linear infinite}',
            '.dnf-epic-title{font-weight:800;font-size:16px;text-align:center;color:#ffd84a;' +
                'text-shadow:0 0 8px #ff9d00;letter-spacing:2px;margin-bottom:8px}',
            '.dnf-epic-line{color:#ffe98a;font-weight:700;font-size:13px;text-align:center;' +
                'margin:3px 0;word-break:break-all;text-shadow:0 0 6px rgba(255,168,0,.7)}',
            '.dnf-epic-close{margin-top:12px;width:100%;padding:8px;border:none;border-radius:8px;' +
                'cursor:pointer;font-family:inherit;font-size:13px;font-weight:800;color:#3a2500;' +
                'background:linear-gradient(90deg,#ffd84a,#ff9d00);box-shadow:0 0 12px #ffb84a}',
            // ===== 隐藏游戏自带的「挂机助手」悬浮窗（展开面板 + 折叠球）=====
            '.dnf-hide-game-assist .assist,' +
            '.dnf-hide-game-assist .assist-collapsed{display:none !important}',
            // ===== 移动端六大模块自定义排序 =====
            '@media (max-width:760px){' +
                '.main.dnf-mod-stack{grid-template-columns:1fr !important;' +
                    'grid-auto-rows:auto !important;align-items:start !important;' +
                    'overflow-y:auto !important;overflow-x:hidden !important;' +
                    '-webkit-overflow-scrolling:touch}' +
                '.main.dnf-mod-stack>.left-col,' +
                '.main.dnf-mod-stack>.center-col{display:contents !important}' +
                '.main.dnf-mod-stack>.right-col{grid-column:auto !important;' +
                    'height:auto !important;overflow:visible !important}' +
            '}',
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    /* ============================================================
     * 怪物血条精度修正（v5.80）
     * ------------------------------------------------------------
     * 游戏用内联 width:(cur/max*100).toFixed(0)% 驱动 .monster-hp-fill，
     * 血量上百万时 1% 就是两万多血，进度条会长时间停在同一个整数百分比，
     * 看起来「不动」。这里只读 .monster-hp-text 的 cur/max，把 fill 的
     * 宽度重写成 5 位小数百分比（相对轨道），让掉血过程线性、细腻。
     * 不新增节点、不改原生节点结构，也不给 fill 设 max-width/overflow。
     * ============================================================ */
    let _hpSyncRaf = 0;
    function syncMonsterHpFills() {
        const cards = document.querySelectorAll('.monster');
        for (let i = 0; i < cards.length; i++) {
            const fill = cards[i].querySelector('.monster-hp-fill');
            const textEl = cards[i].querySelector('.monster-hp-text');
            if (!fill || !textEl) continue;
            const m = /([\d.]+)\s*\/\s*([\d.]+)/.exec(textEl.textContent || '');
            if (!m) continue;
            const cur = Number(m[1]);
            const max = Number(m[2]);
            if (!isFinite(cur) || !isFinite(max) || max <= 0) continue;
            const pct = Math.max(0, Math.min(100, cur / max * 100));
            const next = (pct >= 100 ? '100' : pct.toFixed(5)) + '%';
            if (fill.style.width !== next) fill.style.width = next;
        }
    }
    function scheduleMonsterHpSync() {
        if (_hpSyncRaf) return;
        _hpSyncRaf = requestAnimationFrame(() => {
            _hpSyncRaf = 0;
            try { syncMonsterHpFills(); } catch (_) { }
        });
    }
    function initMonsterHpPrecision() {
        if (window.__dnfHpPrecision580) return;
        window.__dnfHpPrecision580 = true;
        syncMonsterHpFills();
        try {
            // 只观察文本/节点变化，不观察 attributes，避免自己写 style 造成死循环
            const obs = new MutationObserver(scheduleMonsterHpSync);
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch (_) { }
        // 兜底：同一文本节点被原地替换时 MutationObserver 可能不漏事件，1s 再同步一次
        setInterval(scheduleMonsterHpSync, 1000);
    }

    /* ============================================================
     * 统一 UI 主题（与背包标签行同风格）
     * ------------------------------------------------------------
     * 深底 rgb(24,19,11) + 1px 金边 rgba(217,180,110,.35) + 4px 圆角 + #c8a874 文字，
     * 激活态 #ffb03a 发光。单独一个 <style>，开关关掉时整块移除，零残留。
     * ============================================================ */
    const UI_THEME_ID = 'dnf-ui-theme-style';

    function applyUiTheme() {
        const exist = document.getElementById(UI_THEME_ID);
        if (!CONFIG.uiTheme) {
            if (exist && exist.parentNode) exist.parentNode.removeChild(exist);
            return;
        }
        if (exist) return;
        const st = document.createElement('style');
        st.id = UI_THEME_ID;
        st.textContent = [
            // 面板
            '.main .panel{background:rgb(26,21,13) !important;' +
                'border:1px solid rgba(217,180,110,.28) !important;border-radius:8px !important;' +
                'box-shadow:0 2px 10px rgba(0,0,0,.5) !important}',
            // 面板标题
            '.main .panel-title,.main .panel>header{color:#ffb03a !important;font-weight:700 !important;' +
                'border-bottom:1px solid rgba(217,180,110,.16) !important}',
            // 标签页（顶部主标签 / 子标签 / 功能栏）
            '.main [class*="tabs"] button,.main button[class*="tab"],.main [class*="tab-bar"] button{' +
                'background:rgb(24,19,11) !important;border:1px solid rgba(217,180,110,.35) !important;' +
                'border-radius:4px !important;color:#c8a874 !important}',
            '.main [class*="tabs"] button.active,.main button[class*="tab"].active{' +
                'color:#ffb03a !important;border-color:#ffb03a !important;' +
                'background:rgb(36,29,18) !important;box-shadow:0 0 8px rgba(255,176,58,.3) !important}',
            // 普通按钮：统一圆角
            '.main button{border-radius:4px !important}',
            // 输入框 / 下拉（不含勾选框、单选框）
            '.main input:not([type="checkbox"]):not([type="radio"]),.main select,.main textarea{' +
                'background:rgb(20,16,10) !important;border:1px solid rgba(217,180,110,.35) !important;' +
                'border-radius:4px !important;color:#e8c58a !important}',
            '.main input::placeholder{color:rgba(200,168,116,.5) !important}',
            // 滚动条
            '.main ::-webkit-scrollbar{width:8px;height:8px}',
            '.main ::-webkit-scrollbar-track{background:rgb(20,16,10)}',
            '.main ::-webkit-scrollbar-thumb{background:rgba(217,180,110,.45);border-radius:4px}',
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    /* ---------- 史诗掉落：金光弹窗（需手动关闭） ---------- */
    let epicModalEl = null;
    let epicListEl = null;

    function buildEpicModal() {
        const modal = document.createElement('div');
        modal.className = 'dnf-epic-modal';
        const inner = document.createElement('div');
        inner.className = 'dnf-epic-inner';
        const title = document.createElement('div');
        title.className = 'dnf-epic-title';
        title.textContent = '★ 史诗掉落 ★';
        const list = document.createElement('div');
        list.className = 'dnf-epic-list';
        const close = document.createElement('button');
        close.className = 'dnf-epic-close';
        close.textContent = '关 闭';
        close.addEventListener('click', () => {
            if (epicModalEl) epicModalEl.remove();
            epicModalEl = null;
            epicListEl = null;
        });
        inner.appendChild(title);
        inner.appendChild(list);
        inner.appendChild(close);
        modal.appendChild(inner);
        document.body.appendChild(modal);
        makeFloatingDraggable(modal,title,'epic',{left:Math.max(8,(innerWidth-320)/2),top:Math.max(8,(innerHeight-240)/2)});
        modal.style.overflow='auto';
        epicModalEl = modal;
        epicListEl = list;
    }

    function showEpicPopup(text) {
        if (!document.body) return;
        injectStyles();
        if (!epicModalEl || !document.body.contains(epicModalEl)) buildEpicModal();
        const line = document.createElement('div');
        line.className = 'dnf-epic-line';
        line.textContent = text;
        epicListEl.appendChild(line);
    }

    /* ============================================================
     * 布局调整：把「功能栏(main-tabs) + 扩展框(tab-body)」搬到「最近结算」之下
     * ------------------------------------------------------------
     * 游戏(GameView)布局是一个 grid：
     *   div.main
     *     ├ aside.left-col              角色信息 + 等级/血量条
     *     ├ section.center-col          [副本, 增益, .panel.settle, .panel.battle-log]
     *     └ section.right-col           [.main-tabs(功能栏), .tab-body(扩展框)]
     * 移动端(≤760px，单列)下 .right-col 排在 center-col 之后，即位于战斗日志下方；
     * 需求是放到「最近结算」之下、战斗日志之上 → 把 .right-col 整块插入
     * center-col 的 .panel.settle 之后即可（整块移动，扩展框一起跟走）。
     * 仅移动端生效；桌面/平板(≥761px 三栏/两栏)保持原布局，不受影响。
     * ============================================================ */
    let lastRelocateAt = 0;

    function relocateTabsAfterSettlement() {
        if (!CONFIG.relocateTabsAfterSettlement || !document.body) return;
        const now = Date.now();
        if (now - lastRelocateAt < 1200) return;   // 节流，避免 MutationObserver 反复触发
        lastRelocateAt = now;

        const main = document.querySelector('.main');
        if (!main) return;
        const centerCol = main.querySelector(':scope > .center-col');
        const rightCol = main.querySelector(':scope > .right-col') || document.querySelector('.right-col');
        if (!centerCol || !rightCol) return;

        const mobile = window.matchMedia('(max-width: 760px)').matches;
        if (mobile) {
            const settle = centerCol.querySelector('.panel.settle');
            if (!settle) return;   // 结算面板尚未生成，下次再试
            if (rightCol.parentElement === centerCol && rightCol.previousElementSibling === settle) return; // 已到位
            try {
                centerCol.insertBefore(rightCol, settle.nextSibling);
                log('已把「功能栏 + 扩展框」移动到「最近结算」之下');
            } catch (e) {
                log('移动功能栏失败（可能被游戏重渲染覆盖）', e);
            }
        } else {
            // 桌面/平板：还原为 .main 的第三个栅格列
            if (rightCol.parentElement === main) return; // 已还原
            try {
                main.appendChild(rightCol);
                log('已还原功能栏位置（非移动端）');
            } catch (e) {
                log('还原功能栏失败', e);
            }
        }
    }

    /* ============================================================
     * 获取游戏 Vue store（Symbol("game-store") 提供的全局状态）
     *
     * 游戏在 GameView 组件的 provides 里注入了一个 Symbol("game-store")，
     * 对应的值就是整个游戏的全局状态 + 方法集合（startAuctionHover、hoverItem、
     * hoverStyle 等都在上面）。我们直接遍历 Vue 组件树找到 GameView，
     * 再从它的 provides 里按 Symbol.description 匹配取出 store。
     *
     * 这条路比"派发模拟鼠标事件"靠谱得多：
     *   - 事件派发经常被 stopPropagation / preventDefault 吃掉
     *   - 模拟事件的坐标计算在移动端视口里经常算错
     *   - 直接调 store 函数 = 绕过所有事件系统，Vue 响应式照常触发
     * ============================================================ */
    let _cachedGameStore = null;
    let _gameStoreRetryTimer = null;

    function getGameStore() {
        if (_cachedGameStore) return _cachedGameStore;

        const rootEl = document.querySelector('[data-v-app]');
        if (!rootEl || !rootEl.__vue_app__) {
            log('[getGameStore] Vue app 还没挂载');
            return null;
        }

        const rootComp = rootEl.__vue_app__._container?._vnode?.component;
        if (!rootComp) {
            log('[getGameStore] rootComp 不存在');
            return null;
        }

        // 广度优先遍历组件树，找 GameView
        const queue = [rootComp];
        const visited = new Set();
        let gv = null;
        while (queue.length > 0) {
            const comp = queue.shift();
            if (!comp || visited.has(comp)) continue;
            visited.add(comp);
            const name = comp.type && (comp.type.__name || comp.type.name);
            if (name === 'GameView') { gv = comp; break; }
            // 子组件
            if (comp.subTree) {
                const st = comp.subTree;
                if (st.component) queue.push(st.component);
                if (st.children) {
                    if (Array.isArray(st.children)) {
                        for (const child of st.children) {
                            if (child && child.component) queue.push(child.component);
                        }
                    }
                }
            }
        }

        if (!gv) {
            log('[getGameStore] GameView 未找到（可能还没进入游戏）');
            return null;
        }

        // 从 GameView.provides 里找 Symbol("game-store")
        const prov = gv.provides;
        if (!prov) {
            log('[getGameStore] GameView.provides 不存在');
            return null;
        }

        for (const sym of Object.getOwnPropertySymbols(prov)) {
            if (sym.description === 'game-store') {
                const val = prov[sym];
                if (val && typeof val === 'object' && typeof val.startAuctionHover === 'function') {
                    _cachedGameStore = val;
                    log('[getGameStore] ✅ 找到 store！startAuctionHover 可用');
                    return val;
                }
            }
        }

        log('[getGameStore] provides 里没找到 game-store symbol');
        return null;
    }

    /**
     * 修复游戏「详情弹窗 → 打造」按钮点了没反应。
     *
     * 游戏原实现（ItemDetailModal 的 detailCraft）是：
     *   if (!detailItem.value) return;
     *   detailItem.value = null;                       // 先把弹窗关掉
     *   if (detailEquippedSlot.value) { openCraftPageSlot(...); return; }
     *   const item = detailInInventory.value;
     *   item && openCraftPageInstance(item);
     *
     * 但 detailEquippedSlot / detailInInventory 都是由 detailItem 派生的 computed，
     * detailItem 一置空两者立即失效，于是两个分支都进不去 —— 点「打造」只会关弹窗，
     * 不会跳转到打造页。
     *
     * 这里在捕获阶段（Vue 的 onClick 之前）先把装备取出来，自己关弹窗并跳转：
     *   - 已装备的 → openCraftPageSlot(slot)，打造页选中该部位
     *   - 背包里的 → openCraftPageInstance(item)，打造页选中该件
     */
    function initDetailCraftFix() {
        if (document.__dnfCraftFix544) return;
        document.__dnfCraftFix544 = true;

        document.addEventListener('click', (e) => {
            const node = e.target;
            if (!node || !node.closest) return;
            const btn = node.closest('.modal-mask .detail-actions button.da-btn');
            if (!btn || btn.textContent.trim() !== '打造') return;

            const store = getGameStore();
            if (!store || !store.detailItem || !store.detailItem.value) return;
            const item = store.detailItem.value;
            if (item.kind !== 'equipment') return;

            // 拦在游戏 onClick 之前，避免走上面那个失效的原实现
            e.preventDefault();
            e.stopImmediatePropagation();

            // 必须在关弹窗之前读派生状态（顺序反了就会和游戏一样拿不到）
            const slot = store.detailEquippedSlot ? store.detailEquippedSlot.value : '';
            const inBag = store.detailInInventory ? store.detailInInventory.value : null;

            try { store.detailItem.value = null; } catch (_) {}

            try {
                if (slot && store.openCraftPageSlot) {
                    store.openCraftPageSlot(slot);
                } else if (inBag && store.openCraftPageInstance) {
                    store.openCraftPageInstance(inBag);
                } else {
                    showTip('该装备不在背包/身上，无法打造');
                }
            } catch (err) {
                log('[打造] 跳转失败:', err && err.message);
            }
        }, true);
    }

    /* ============================================================
     * 物品详情「存仓」按钮（v5.68）
     *
     * 需求：背包【装备】/【材料】标签的物品详情弹窗里能直接存入共享仓库。
     * 实现要点：
     *   - 不复制游戏节点、不改游戏按钮，自己创建一个「存仓」按钮 + 可选数量输入；
     *   - 点击后直接调用游戏自己的仓库存入接口（与游戏内部方法同一套 REST API）：
     *       装备：POST /api/characters/{charId}/warehouse-equip-deposit { instance_id }
     *       材料：POST /api/characters/{charId}/warehouse-deposit      { item_id, count }
     *     材料整组/部分数量都走同一个接口，数量上限 = 当前持有数；
     *   - 成功后刷新背包(inventory)、仓库(warehouse)，容量与仓库页列表随之更新；
     *   - 失败时把接口返回的 error 原样显示在弹窗里，按钮恢复可点，不出现假成功；
     *   - 按钮按 detailItem 的 item_id/instance_id 打 key，重复扫描不会重复注入；
     *     切换物品或弹窗关闭后标记失效，自动重建/销毁。
     * ============================================================ */
    let _depositBusy = false;

    function depositDisabledReason(store, item) {
        if (!item) return '没有可存入的物品';
        const slot = store.detailEquippedSlot ? store.detailEquippedSlot.value : '';
        if (slot) return '已穿戴，请先卸下再存入';
        // v5.73：去掉「物品已锁定」禁用条件，锁定装备同样允许存仓。
        // 注意：detailInInventory 是「背包中对应物品对象」的 ref，而不是布尔值
        const inBag = store.detailInInventory ? store.detailInInventory.value : null;
        if (!inBag) return '物品不在背包中，无法存入';
        const wh = store.warehouse ? store.warehouse.value : null;
        if (wh && Number(wh.used) >= Number(wh.capacity)) {
            return '仓库已满（' + wh.used + '/' + wh.capacity + '）';
        }
        if (item.kind === 'equipment') {
            if (!(Number(item.instance_id) > 0)) return '该装备没有实例编号，无法存入';
            return '';
        }
        if (!(Number(item.count) > 0)) return '该物品数量不足，无法存入';
        // 游戏内部 warehouseDepositItems 就是「可存入材料」白名单（排除消耗品与特殊/绑定道具）
        const list = store.warehouseDepositItems ? store.warehouseDepositItems.value : null;
        if (Array.isArray(list) && !list.some(x => x && x.item_id === item.item_id)) {
            return '该物品不可存入仓库（绑定/特殊道具）';
        }
        return '';
    }

    function setDepositMsg(box, text, isError) {
        const msg = box && box.querySelector('.dnf-deposit-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.classList.toggle('is-err', !!text && !!isError);
        msg.classList.toggle('is-ok', !!text && !isError);
    }

    /**
     * 调游戏自己的角色接口，错误信息与游戏内一致（JSON 的 error 字段）。
     * v5.77：新增可选超时（AbortController）与失败前缀，仓库取出复用同一套逻辑。
     */
    async function postCharacterApi(store, path, body, timeoutMs, failLabel) {
        const charId = store.charId ? store.charId.value : null;
        if (!charId) throw new Error('未找到当前角色，无法操作');
        const token = localStorage.getItem('dnf_idle_token') || '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const opts = {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        };
        let timer = null;
        if (Number(timeoutMs) > 0) {
            const controller = new AbortController();
            opts.signal = controller.signal;
            timer = setTimeout(() => controller.abort(), Number(timeoutMs));
        }
        try {
            const res = await fetch('/api/characters/' + charId + '/' + path, opts);
            let data = null;
            try { data = await res.json(); } catch (_) {}
            if (!res.ok) {
                const msg = (data && (data.error || data.message)) ||
                    ((failLabel || '存入失败') + '（HTTP ' + res.status + '）');
                throw new Error(msg);
            }
            return data;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new Error('请求超时（' + Math.round(Number(timeoutMs) / 1000) + ' 秒），请检查网络后重试');
            }
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function depositDetailItem(store, box) {
        if (_depositBusy) return;
        if (!store.detailItem) return;
        const item = store.detailItem.value;
        if (!item) return;

        const reason = depositDisabledReason(store, item);
        if (reason) { setDepositMsg(box, reason, true); return; }

        const isEquip = item.kind === 'equipment';
        let qty = 1;
        const input = box.querySelector('.dnf-deposit-qty');
        if (!isEquip) {
            const max = Math.max(1, Number(item.count) || 0);
            if (input) {
                let n = parseInt(input.value, 10);
                if (!Number.isFinite(n) || n < 1) n = max;
                if (n > max) n = max;
                qty = n;
                input.value = String(n);
            } else {
                qty = max;
            }
        }

        const btn = box.querySelector('.dnf-deposit-btn');
        _depositBusy = true;
        if (btn) { btn.disabled = true; btn.textContent = '存入中…'; }
        if (input) input.disabled = true;
        setDepositMsg(box, '', false);

        try {
            const data = isEquip
                ? await postCharacterApi(store, 'warehouse-equip-deposit', { instance_id: item.instance_id })
                : await postCharacterApi(store, 'warehouse-deposit', { item_id: item.item_id, count: qty });

            // 接口返回的 view 就是最新仓库容量/列表，先写入避免等待第二次请求
            if (data && data.view && store.warehouse) store.warehouse.value = data.view;

            // 先关弹窗：物品已离开背包，继续展示旧详情会误导
            if (store.detailItem) store.detailItem.value = null;

            const label = item.name + (qty > 1 ? ' ×' + qty : '');
            // v5.73：统一走插件自己的轻量红字提示，保证「存仓成功」也是同一套观感
            showTip('已存入仓库：' + label);

            try {
                const tasks = [];
                if (typeof store.loadInventory === 'function') tasks.push(store.loadInventory());
                if (typeof store.loadWarehouse === 'function') tasks.push(store.loadWarehouse());
                if (tasks.length) await Promise.all(tasks);
            } catch (refreshErr) {
                log('[存仓] 已存入但刷新失败:', refreshErr && refreshErr.message);
            }
        } catch (err) {
            const msg = (err && err.message) ? err.message : '存入失败，请稍后重试';
            setDepositMsg(box, msg, true);
            if (btn) { btn.disabled = false; btn.textContent = '存仓'; }
            if (input) input.disabled = false;
        } finally {
            _depositBusy = false;
        }
    }

    function applyDetailDepositButton() {
        const store = getGameStore();
        let mask = null;
        let actions = null;
        let item = null;

        if (store && store.detailItem && store.detailItem.value) {
            item = store.detailItem.value;
            const masks = document.querySelectorAll('.modal-mask');
            for (const m of masks) {
                const rows = m.querySelectorAll('.detail-actions');
                if (rows.length) {
                    mask = m;
                    actions = rows[rows.length - 1];
                }
            }
        }

        // 弹窗关闭或切换到别的弹窗：清掉所有残留注入框
        document.querySelectorAll('[data-dnf-deposit-box]').forEach(box => {
            if (!mask || !mask.contains(box)) box.remove();
        });

        if (!mask || !actions || !item) return;
        if (!store.tab || store.tab.value !== 'bag') return;
        const sub = store.bagSub ? store.bagSub.value : '';
        if (sub !== 'equip' && sub !== 'material') return;
        if (sub === 'equip' && item.kind !== 'equipment') return;
        if (sub === 'material' && item.kind === 'equipment') return;

        const reason = depositDisabledReason(store, item);
        const key = [sub, item.kind, item.instance_id || 0, item.item_id, item.count,
            item.locked ? 1 : 0, reason].join('|');

        const existing = actions.querySelector('[data-dnf-deposit-box]');
        if (existing && existing.dataset.depositKey === key) return;
        if (existing) existing.remove();

        const box = document.createElement('div');
        box.className = 'dnf-deposit-box';
        box.setAttribute('data-dnf-deposit-box', '1');
        box.dataset.depositKey = key;

        // 材料可堆叠时给数量输入：默认整组，可改，上限=持有数
        if (item.kind !== 'equipment' && Number(item.count) > 1) {
            const label = document.createElement('span');
            label.className = 'dnf-deposit-label';
            label.textContent = '数量';
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'dnf-deposit-qty';
            input.min = '1';
            input.max = String(item.count);
            input.step = '1';
            input.value = String(item.count);
            input.title = '存入数量（最多 ' + item.count + ' 个）';
            input.setAttribute('aria-label', '存入数量');
            input.addEventListener('input', () => {
                const max = Math.max(1, Number(item.count) || 1);
                let n = parseInt(input.value, 10);
                if (!Number.isFinite(n) || n < 1) return; // 允许暂时清空输入
                if (n > max) { n = max; input.value = String(n); }
            });
            box.append(label, input);
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'da-btn dnf-deposit-btn';
        btn.textContent = '存仓';
        btn.title = '存入共享仓库';

        const msg = document.createElement('div');
        msg.className = 'dnf-deposit-msg';
        if (reason) {
            btn.disabled = true;
            btn.title = '无法存入：' + reason;
            msg.textContent = reason;
            msg.classList.add('is-err');
        }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            depositDetailItem(store, box);
        });
        box.append(btn, msg);
        actions.appendChild(box);
    }

    /* ============================================================
     * 仓库装备「点击看详情 + 确认取出」（v5.77）
     *
     * 原行为：点击仓库装备格子 = 直接调
     *   POST /api/characters/{charId}/warehouse-equip-withdraw { instance_id }
     * 立即取出（游戏模板里格子的 onClick 就是 warehouseEquipWithdraw）。
     *
     * 现需求：单击只弹该装备详情（字段/排版与背包点装备完全一致），
     * 详情下方给「确认取出」，点确认才真正请求。
     *
     * 实现要点：
     *   - 捕获阶段拦截仓库装备格子（.bag-slot.wh-action 且 title 含「（存入者：」），
     *     stopImmediatePropagation 阻止 Vue 绑定的原生取出，单击绝不触发取出；
     *   - 详情直接复用游戏自己的弹窗（store.showDetail / detailItem），
     *     与背包详情同一套渲染，字段完全一致；
     *   - 在详情底部动作区追加插件自己的「确认取出 / 取消」浮层，按 instance_id
     *     去重，切装备重建、关弹窗清理，不重复注入；
     *   - 取消（遮罩 / 关闭 / ESC / 取消按钮）只关闭弹窗，不发任何请求；
     *   - 只在失败（仓库已空、背包满、HTTP 非 2xx、超时）时提示，不假成功；
     *   - 不改、不隐藏任何游戏原生节点。
     * ============================================================ */
    const WH_WITHDRAW_TIMEOUT_MS = 12000;
    let _whWithdrawBusy = false;

    /** 仓库装备对象补 kind（浅拷贝，保证详情按装备渲染，不改原对象） */
    function asWarehouseEquip(item) {
        if (!item) return null;
        if (item.kind === 'equipment') return item;
        return Object.assign({}, item, { kind: 'equipment' });
    }

    /** 由格子反查装备：优先按 DOM 顺序对齐 warehouseEquipFiltered，失败再用 title 匹配 */
    function warehouseEquipFromCell(store, cell) {
        if (!store) return null;
        const wh = store.warehouse ? store.warehouse.value : null;
        const filtered = store.warehouseEquipFiltered ? store.warehouseEquipFiltered.value : null;
        const list = Array.isArray(filtered) && filtered.length
            ? filtered
            : (wh && Array.isArray(wh.equipment) ? wh.equipment : []);
        if (!list.length) return null;

        const title = cell.getAttribute('title') || '';
        const name = title.split('（存入者：')[0].trim();
        const grid = cell.parentElement;
        if (grid) {
            const idx = Array.prototype.indexOf.call(grid.children, cell);
            const hit = idx >= 0 ? list[idx] : null;
            if (hit && Number(hit.instance_id) > 0 && (!name || hit.name === name)) {
                return asWarehouseEquip(hit);
            }
        }
        const ownerMatch = /（存入者：([^，]*)，/.exec(title);
        const owner = ownerMatch ? ownerMatch[1] : '';
        const found = list.find(x => x && x.name === name && (!owner || !x.owner_name || x.owner_name === owner));
        return found ? asWarehouseEquip(found) : null;
    }

    /** 打开游戏原生详情弹窗（与背包点击同一套 detailItem 渲染） */
    function openWarehouseEquipDetail(store, item) {
        if (!store || !item) return false;
        const inst = Number(item.instance_id) || 0;
        if (!inst) return false;
        const current = store.detailItem ? store.detailItem.value : null;
        // 已经是同一件：保持当前弹窗，不重复打开
        if (current && Number(current.instance_id) === inst) return true;
        try {
            if (typeof store.showDetail === 'function') store.showDetail(item);
            else if (store.detailItem) store.detailItem.value = item;
            else return false;
        } catch (err) {
            log('[仓库取出] 打开详情失败:', err && err.message);
            return false;
        }
        return true;
    }

    function closeGameDetail(store) {
        try { if (store && store.detailItem) store.detailItem.value = null; } catch (_) { }
    }

    /** 捕获阶段拦截仓库装备格子：只开详情，绝不触发原生取出 */
    function initWarehouseEquipDetailGuard() {
        if (document.__dnfWhDetailGuard577) return;
        document.__dnfWhDetailGuard577 = true;

        document.addEventListener('click', (e) => {
            const node = e.target;
            if (!node || !node.closest) return;
            const cell = node.closest('.bag-slot.wh-action');
            if (!cell) return;
            // 仓库材料/消耗品格子同样是 .wh-action，但 title 没有「（存入者：」——保持原行为
            const title = cell.getAttribute('title') || '';
            if (title.indexOf('（存入者：') === -1) return;

            // 先阻断，Vue 绑定在格子上的 warehouseEquipWithdraw 不会再执行
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();

            const store = getGameStore();
            const item = warehouseEquipFromCell(store, cell);
            if (!item) { showTip('无法读取该装备信息，请刷新页面后重试'); return; }
            if (!openWarehouseEquipDetail(store, item)) showTip('打开装备详情失败，请刷新页面后重试');
        }, true);

        // ESC = 取消：只关弹窗，不发请求
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' && e.key !== 'Esc') return;
            if (!document.querySelector('.dnf-withdraw-box')) return;
            const store = getGameStore();
            if (!store || !store.detailItem || !store.detailItem.value) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            closeGameDetail(store);
        }, true);
    }

    function withdrawDisabledReason(store, item) {
        if (!item) return '没有可取出的装备';
        const inst = Number(item.instance_id) || 0;
        if (!inst) return '该装备没有实例编号，无法取出';
        const wh = store.warehouse ? store.warehouse.value : null;
        if (wh && Array.isArray(wh.equipment) && !wh.equipment.some(x => Number(x.instance_id) === inst)) {
            return '该装备已不在仓库';
        }
        if (store.bagIsFull && store.bagIsFull.value) return '背包已满，请先清理背包';
        return '';
    }

    function setWithdrawMsg(box, text, isError) {
        const msg = box && box.querySelector('.dnf-withdraw-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.classList.toggle('is-err', !!text && !!isError);
        msg.classList.toggle('is-ok', !!text && !isError);
    }

    async function withdrawWarehouseEquip(store, item, box) {
        if (_whWithdrawBusy) return;
        if (!store || !item) return;
        const inst = Number(item.instance_id) || 0;

        const reason = withdrawDisabledReason(store, item);
        if (reason) { setWithdrawMsg(box, reason, true); return; }

        const btn = box.querySelector('.dnf-withdraw-btn');
        const cancel = box.querySelector('.dnf-withdraw-cancel');
        _whWithdrawBusy = true;
        if (btn) { btn.disabled = true; btn.textContent = '取出中…'; }
        if (cancel) cancel.disabled = true;
        setWithdrawMsg(box, '', false);

        try {
            const data = await postCharacterApi(store, 'warehouse-equip-withdraw',
                { instance_id: inst }, WH_WITHDRAW_TIMEOUT_MS, '取出失败');

            // 接口返回的 view 就是最新仓库容量/列表，先写入避免等待第二次请求
            if (data && data.view && store.warehouse) store.warehouse.value = data.view;

            // 装备已离开仓库，关闭详情，避免继续展示旧数据
            closeGameDetail(store);
            showTip('已取出到背包：' + (item.name || '装备'));

            try {
                const tasks = [];
                if (typeof store.loadInventory === 'function') tasks.push(store.loadInventory());
                if (typeof store.loadWarehouse === 'function') tasks.push(store.loadWarehouse());
                if (tasks.length) await Promise.all(tasks);
            } catch (refreshErr) {
                log('[仓库取出] 已取出但刷新失败:', refreshErr && refreshErr.message);
            }
        } catch (err) {
            const msg = (err && err.message) ? err.message : '取出失败，请稍后重试';
            setWithdrawMsg(box, msg, true);
            if (btn) { btn.disabled = false; btn.textContent = '确认取出'; }
            if (cancel) cancel.disabled = false;
        } finally {
            _whWithdrawBusy = false;
        }
    }

    /** 详情弹窗底部维护「确认取出 / 取消」浮层（只加自己的节点） */
    function applyWarehouseWithdrawBox() {
        const store = getGameStore();
        const panel = document.querySelector('.modal-mask .modal.panel');
        const detail = store && store.detailItem ? store.detailItem.value : null;
        const inst = detail ? Number(detail.instance_id) || 0 : 0;
        const wh = store && store.warehouse ? store.warehouse.value : null;
        const isWarehouseItem = !!(inst && wh && Array.isArray(wh.equipment) &&
            wh.equipment.some(x => Number(x.instance_id) === inst));

        // 弹窗关闭 / 切到背包物品：清掉插件浮层
        document.querySelectorAll('[data-dnf-wh-withdraw]').forEach(box => {
            if (!isWarehouseItem || !panel || !panel.contains(box)) box.remove();
        });
        if (!isWarehouseItem || !panel) return;

        const reason = withdrawDisabledReason(store, detail);
        const key = [inst, detail.locked ? 1 : 0, detail.count || 1, reason].join('|');

        // 挂在弹窗最下方的动作区（游戏的原生 actions 是 sticky 底栏，保证按钮可见）
        const acts = panel.querySelectorAll('.detail-actions');
        const host = acts.length ? acts[acts.length - 1] : panel;

        const existing = panel.querySelector('[data-dnf-wh-withdraw]');
        if (existing && existing.dataset.whKey === key && host.contains(existing)) return;
        if (existing) existing.remove();

        const box = document.createElement('div');
        box.className = 'dnf-withdraw-box';
        box.setAttribute('data-dnf-wh-withdraw', '1');
        box.dataset.whKey = key;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dnf-withdraw-btn';
        btn.textContent = '确认取出';
        btn.title = reason || '取出到背包';
        if (reason) btn.disabled = true;

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dnf-withdraw-cancel';
        cancel.textContent = '取消';
        cancel.title = '关闭详情（不会发起取出请求）';

        const msg = document.createElement('div');
        msg.className = 'dnf-withdraw-msg';
        if (reason) { msg.textContent = reason; msg.classList.add('is-err'); }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            withdrawWarehouseEquip(store, detail, box);
        });
        cancel.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeGameDetail(store);
        });

        box.append(btn, cancel, msg);
        host.appendChild(box);
    }

    /* ============================================================
     * 仓库材料「自选数量取出」（v5.80）
     * ------------------------------------------------------------
     * 游戏原生点击仓库材料 = 整组一次性取出，无法选数量。
     * 这里在捕获阶段拦截「材料格子」（.bag-slot.wh-action 且 title
     * 含「（点击取出）」、不含「（存入者：」），弹出插件自己的数量弹窗：
     *   - 默认值 = 当前持有数，范围 1..持有数，超限自动回填，提交前再 clamp；
     *   - 取消 / 遮罩 / ESC 不发任何请求；
     *   - 只有点「确认取出」才调原生 POST /warehouse-withdraw { item_id, count }；
     *   - 成功用返回的 view 刷新仓库、再刷背包，toast；失败明确报错不假成功。
     * 不修改、不隐藏任何游戏原生节点。
     * ============================================================ */
    const WH_MATERIAL_TIMEOUT_MS = 12000;
    let _whMatQtyBusy = false;
    let _whMatQtyMask = null;

    function closeWarehouseMaterialQty() {
        if (_whMatQtyMask && _whMatQtyMask.parentNode) _whMatQtyMask.parentNode.removeChild(_whMatQtyMask);
        _whMatQtyMask = null;
    }

    /** 从仓库材料格子反查 store.warehouse.items 里的条目 */
    function warehouseMaterialFromCell(store, cell) {
        const wh = store && store.warehouse ? store.warehouse.value : null;
        const list = wh && Array.isArray(wh.items) ? wh.items : [];
        if (!list.length) return null;
        const title = cell.getAttribute('title') || '';
        const name = title.split('×')[0].trim();

        // 优先按格子在同组中的位置取（材料网格与 items 顺序一致）
        const grid = cell.parentElement;
        if (grid) {
            const idx = Array.prototype.indexOf.call(grid.children, cell);
            const hit = idx >= 0 ? list[idx] : null;
            if (hit && hit.item_id && (!name || !hit.name || hit.name === name)) return hit;
        }
        // 退路：按名字唯一匹配
        const named = list.filter(x => x && x.item_id && x.name === name);
        if (named.length === 1) return named[0];
        return null;
    }

    function openWarehouseMaterialQty(store, item) {
        closeWarehouseMaterialQty();
        const held = Math.max(1, Math.floor(Number(item.count) || 1));

        const mask = document.createElement('div');
        mask.className = 'dnf-qty-mask';
        mask.setAttribute('data-dnf-wh-qty', '1');
        _whMatQtyMask = mask;

        const panel = document.createElement('div');
        panel.className = 'dnf-qty-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '取出材料数量');

        const title = document.createElement('div');
        title.className = 'dnf-qty-title';
        title.textContent = '取出材料';

        const sub = document.createElement('div');
        sub.className = 'dnf-qty-sub';
        sub.textContent = (item.name || '材料') + ' · 仓库持有 ' + held;

        const row = document.createElement('div');
        row.className = 'dnf-qty-row';
        const label = document.createElement('span');
        label.className = 'dnf-qty-label';
        label.textContent = '取出数量';
        const input = document.createElement('input');
        input.className = 'dnf-qty-input';
        input.type = 'number';
        input.inputMode = 'numeric';
        input.min = '1';
        input.max = String(held);
        input.step = '1';
        input.value = String(held);
        const range = document.createElement('span');
        range.className = 'dnf-qty-label';
        range.textContent = '1 ~ ' + held;
        row.append(label, input, range);

        const msg = document.createElement('div');
        msg.className = 'dnf-qty-msg';

        const actions = document.createElement('div');
        actions.className = 'dnf-qty-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'dnf-qty-cancel';
        cancelBtn.textContent = '取消';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'dnf-qty-ok';
        okBtn.textContent = '确认取出';
        actions.append(cancelBtn, okBtn);

        const clamp = () => {
            let n = parseInt(input.value, 10);
            if (!isFinite(n) || n < 1) n = 1;
            if (n > held) n = held;
            input.value = String(n);
            return n;
        };

        input.addEventListener('input', () => {
            const raw = String(input.value || '').trim();
            if (!raw) return;                       // 允许清空后重新输入
            const n = parseInt(raw, 10);
            if (isFinite(n) && n > held) input.value = String(held);   // 超限自动回填
        });
        input.addEventListener('change', clamp);
        input.addEventListener('blur', clamp);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
        });

        cancelBtn.addEventListener('click', () => closeWarehouseMaterialQty());
        mask.addEventListener('click', (e) => { if (e.target === mask) closeWarehouseMaterialQty(); });
        panel.addEventListener('click', (e) => e.stopPropagation());

        okBtn.addEventListener('click', () => {
            withdrawWarehouseMaterial(store, item, clamp(), { input, okBtn, cancelBtn, msg });
        });

        panel.append(title, sub, row, msg, actions);
        mask.appendChild(panel);
        document.body.appendChild(mask);
        setTimeout(() => { try { input.focus(); input.select(); } catch (_) { } }, 30);
    }

    async function withdrawWarehouseMaterial(store, item, count, ui) {
        if (_whMatQtyBusy) return;
        const held = Math.max(1, Math.floor(Number(item.count) || 1));
        let n = Math.floor(Number(count) || 1);
        if (!isFinite(n) || n < 1) n = 1;
        if (n > held) n = held;                    // 提交前再 clamp 一次
        const itemId = Number(item.item_id) || 0;
        if (!itemId) {
            if (ui.msg) { ui.msg.textContent = '该材料缺少 item_id，无法取出'; ui.msg.classList.add('is-err'); }
            return;
        }

        _whMatQtyBusy = true;
        if (ui.okBtn) { ui.okBtn.disabled = true; ui.okBtn.textContent = '取出中…'; }
        if (ui.cancelBtn) ui.cancelBtn.disabled = true;
        if (ui.input) ui.input.disabled = true;
        if (ui.msg) { ui.msg.textContent = ''; ui.msg.classList.remove('is-err'); }

        try {
            const data = await postCharacterApi(store, 'warehouse-withdraw',
                { item_id: itemId, count: n }, WH_MATERIAL_TIMEOUT_MS, '取出失败');

            // 接口返回的 view 即最新仓库，先写入避免等待
            if (data && data.view && store.warehouse) store.warehouse.value = data.view;

            showTip('已取出 ' + n + ' 个 ' + (item.name || '材料'));
            closeWarehouseMaterialQty();

            try {
                const tasks = [];
                if (typeof store.loadInventory === 'function') tasks.push(store.loadInventory());
                if (typeof store.loadWarehouse === 'function') tasks.push(store.loadWarehouse());
                if (tasks.length) await Promise.all(tasks);
            } catch (refreshErr) {
                log('[仓库材料取出] 已取出但刷新失败:', refreshErr && refreshErr.message);
            }
        } catch (err) {
            const text = (err && err.message) ? err.message : '取出失败，请稍后重试';
            if (ui.msg) { ui.msg.textContent = text; ui.msg.classList.add('is-err'); }
            if (ui.okBtn) { ui.okBtn.disabled = false; ui.okBtn.textContent = '确认取出'; }
            if (ui.cancelBtn) ui.cancelBtn.disabled = false;
            if (ui.input) ui.input.disabled = false;
        } finally {
            _whMatQtyBusy = false;
        }
    }

    function initWarehouseMaterialQtyGuard() {
        if (window.__dnfWhMatQtyGuard580) return;
        window.__dnfWhMatQtyGuard580 = true;

        document.addEventListener('click', (e) => {
            const node = e.target && e.target.closest ? e.target.closest('.bag-slot.wh-action') : null;
            if (!node) return;
            const title = node.getAttribute('title') || '';
            if (title.indexOf('（存入者：') !== -1) return;          // 装备走 v5.77 详情流程
            if (title.indexOf('（点击取出）') === -1) return;        // 只拦仓库材料
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();

            const store = getGameStore();
            const item = warehouseMaterialFromCell(store, node);
            if (!item) { showTip('无法读取该材料信息，请刷新页面后重试'); return; }
            openWarehouseMaterialQty(store, item);
        }, true);

        // ESC = 取消，不发请求
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' && e.key !== 'Esc') return;
            if (!_whMatQtyMask) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            closeWarehouseMaterialQty();
        }, true);
    }

    /* ============================================================
     * 通关秘宝盒「全开」（v5.71：按原生批量 10 个、每批可见）
     *
     * v5.70 逐个开虽然实时，但请求量太大、速度慢；v5.69 则是整段闷头连发、
     * 结束才刷新，像卡住。v5.71 取中间：
     *   - 每批 Math.min(10, 剩余) 个，与游戏原生 Math.min(10,count) 一致，
     *     调用 store 原生 openClearBox(item_id, n)（内部即 clearbox-open 接口）；
     *   - 原生方法每批结束会自动刷新背包并把整批奖励写入原生结果面板，
     *     我们再等「数量签名变化或新结果面板出现」后给一个短暂展示窗口，
     *     因此每批都能在界面上看到数量递减和本批掉落；
     *   - 拿不到原生方法时回退到直接调 clearbox-open + loadInventory。
     *
     * 安全逻辑（保留 v5.69/v5.70 全部约束）：
     *   - 以点击时 store.clearBoxItems 的持有数为总上限，开完即止，不会多开；
     *   - 单批 15s 硬超时；失败/背包满/冷却/次数不足/超时立即停止，已开物品保留；
     *   - 运行期间按钮变「停止」，再次点击只置停止标志，不再发新请求；
     *   - 结束后刷新背包，数量与列表随之更新；不复制/隐藏任何游戏节点。
     * ============================================================ */
    const CLEARBOX_BATCH = 10;
    const CLEARBOX_TIMEOUT_MS = 15000;      // 单批请求硬超时
    const CLEARBOX_FEEDBACK_MAX_MS = 2500;  // 每批后等待界面反馈的上限
    // v5.72：批间展示窗口 250 → 120ms。每批 10 个，原生面板一次就整批刷新，
    // 120ms 足够看清数量递减与本批掉落，同时把批间节奏再压一档。
    const CLEARBOX_FEEDBACK_SHOW_MS = 120;
    const CLEARBOX_FEEDBACK_POLL_MS = 50;   // 反馈轮询间隔（比 70ms 更细，减少空等）
    let _clearBoxBusy = false;
    let _clearBoxStop = false;
    // v5.72：记录每批请求发起时间戳，结束/停止时输出实测批间间隔（便于核对节奏）
    let _clearBoxBatchStamps = [];

    const clearBoxSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function setClearBoxButtonState(btn) {
        if (!btn) return;
        btn.textContent = _clearBoxBusy ? '停止' : '全开';
        btn.dataset.busy = _clearBoxBusy ? '1' : '0';
        btn.title = _clearBoxBusy
            ? '正在按批开箱（每批最多 10 个），点击停止；已开出的物品会保留'
            : '按原生批量打开当前全部通关秘宝盒（每批最多 10 个，可随时停止）';
    }

    // 数据层签名：item_id:count。原生 openClearBox 内部 await 刷新背包，
    // 签名变化即代表这一个真的开成功了（比只看 DOM 更可靠）。
    function clearBoxStoreSignature(store) {
        const items = (store && store.clearBoxItems && store.clearBoxItems.value) || [];
        return items.map(x => String(x.item_id) + ':' + String(x.count)).sort().join('|');
    }

    /**
     * 开完一批后等待界面反馈再继续（v5.72 只保留一个完成判定）：
     *  - 唯一判据 = store.clearBoxItems 的 item_id:count 签名变化。
     *    原生 openClearBox 内部会 await 刷新背包/秘宝盒，签名变化即代表这一批
     *    真的开成功了，比看 DOM 面板更可靠；不再同时等「新结果面板出现」，
     *    去掉双重等待，批间只剩 120ms 展示窗口。
     *  - 用户点停止 → 立即返回 'stop'（不再发下一个请求）；
     *  - 超过上限仍无变化 → 'nochange'（背包满/冷却/次数不足/网络失败）。
     */
    async function waitClearBoxFeedback(store, beforeSig) {
        const start = Date.now();
        while (Date.now() - start < CLEARBOX_FEEDBACK_MAX_MS) {
            if (_clearBoxStop) return 'stop';
            if (clearBoxStoreSignature(store) !== beforeSig) {
                await clearBoxSleep(CLEARBOX_FEEDBACK_SHOW_MS);
                return 'ok';
            }
            await clearBoxSleep(CLEARBOX_FEEDBACK_POLL_MS);
        }
        return 'nochange';
    }

    // 开一批：优先走游戏原生 openClearBox（内部 clearbox-open + 原生结果面板 + 刷新背包/秘宝盒），
    // 拿不到原生方法时回退到直接调接口。原生方法本身会把 count 夹在 1–10。
    async function openClearBoxBatch(store, charId, token, itemId, count) {
        if (typeof store.openClearBox === 'function') {
            await Promise.race([
                store.openClearBox(itemId, count),
                clearBoxSleep(CLEARBOX_TIMEOUT_MS).then(() => { throw new Error('开箱请求超时'); })
            ]);
            return;
        }
        const data = await postClearBoxOpen(charId, token, itemId, count);
        if (data && data.gold_left !== undefined && store.character && store.character.value) {
            store.character.value.gold = data.gold_left;
        }
        if (typeof store.loadInventory === 'function') await store.loadInventory();
    }

    async function postClearBoxOpen(charId, token, itemId, count) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CLEARBOX_TIMEOUT_MS);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            const res = await fetch('/api/characters/' + charId + '/clearbox-open', {
                method: 'POST',
                headers,
                body: JSON.stringify({ item_id: itemId, count }),
                signal: controller.signal
            });
            let data = null;
            try { data = await res.json(); } catch (_) {}
            if (!res.ok) {
                const msg = (data && (data.error || data.message)) || ('开箱失败（HTTP ' + res.status + '）');
                throw new Error(msg);
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    async function runClearBoxAll(btn) {
        // 运行中再次点击 = 请求停止（只落标志，不再发请求）
        if (_clearBoxBusy) { _clearBoxStop = true; return; }

        const store = getGameStore();
        if (!store || !store.clearBoxItems) return;
        const boxes = (store.clearBoxItems.value || [])
            .filter(x => x && Number(x.count) > 0)
            .map(x => ({ item_id: x.item_id, remaining: Math.floor(Number(x.count)) }))
            .filter(x => x.remaining > 0);
        if (!boxes.length) return;
        const charId = store.charId ? store.charId.value : null;
        if (!charId) return;
        const token = localStorage.getItem('dnf_idle_token') || '';
        // 不手动占用 store.busy：原生 openClearBox 自己会置 busy 并在结束后释放，
        // 手动占用反而可能把原生按钮/结果面板一起压住。

        _clearBoxBusy = true;
        _clearBoxStop = false;
        _clearBoxBatchStamps = [];
        setClearBoxButtonState(btn);
        const totalBoxes = boxes.reduce((n, b) => n + b.remaining, 0);
        showTip('开始全开：共 ' + totalBoxes + ' 个通关秘宝盒，每批 ' + CLEARBOX_BATCH + ' 个');

        let opened = 0;
        let lastLabel = '';
        try {
            for (const box of boxes) {
                while (box.remaining > 0) {
                    if (_clearBoxStop) break;
                    // 与游戏原生一致：每批最多 10 个，最后一批按剩余数收口
                    const batch = Math.min(CLEARBOX_BATCH, box.remaining);
                    const beforeSig = clearBoxStoreSignature(store);
                    // 记录本批请求发起前的秘宝盒数量，用于核对“无漏批/无重复”
                    lastLabel = box.item_id + ' 剩余 ' + box.remaining;
                    _clearBoxBatchStamps.push(Date.now());
                    await openClearBoxBatch(store, charId, token, box.item_id, batch);
                    if (_clearBoxStop) break;
                    // 只等一个完成判定：数量签名变化 → 展示 120ms → 下一批
                    const feedback = await waitClearBoxFeedback(store, beforeSig);
                    if (feedback === 'stop') break;
                    if (feedback === 'nochange') {
                        throw new Error('开箱未生效（背包已满 / 冷却中 / 次数不足或网络失败）');
                    }
                    box.remaining -= batch;
                    opened += batch;
                }
            }
        } catch (err) {
            // 失败/超时/冷却/背包满：立即停止，已开出的物品保留
            log('[全开] 已停止：' + ((err && err.message) || err) + '（本次已开 ' + opened + ' 个）');
        } finally {
            // 输出实测节奏：批数、平均批间间隔、最小/最大间隔，便于核对抓包时间戳
            if (_clearBoxBatchStamps.length) {
                const gaps = [];
                for (let i = 1; i < _clearBoxBatchStamps.length; i++) {
                    gaps.push(_clearBoxBatchStamps[i] - _clearBoxBatchStamps[i - 1]);
                }
                const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
                log('[全开] 结束：' + (lastLabel || '') + '，共 ' + _clearBoxBatchStamps.length + ' 批，已开 ' + opened +
                    ' 个（每批 ' + CLEARBOX_BATCH + '）' +
                    (gaps.length ? '；批间实测 avg ' + avg + 'ms / min ' + Math.min(...gaps) + 'ms / max ' + Math.max(...gaps) + 'ms' : ''));
            }
            showTip('全开结束：本次已开 ' + opened + ' 个' + (totalBoxes > opened ? '（已停止，剩余 ' + (totalBoxes - opened) + ' 个）' : ''));
            _clearBoxBusy = false;
            _clearBoxStop = false;
            try {
                if (typeof store.loadInventory === 'function') await store.loadInventory();
            } catch (_) {}
            setClearBoxButtonState(btn);
        }
    }

    function applyClearBoxAllButton() {
        // 清理不在秘宝盒面板里的残留按钮（面板被移除时整块会一起销毁）
        document.querySelectorAll('.dnf-clearbox-head').forEach(head => {
            if (!head.closest('.clearbox-panel')) head.remove();
        });

        const panel = document.querySelector('.bag-tab > .clearbox-panel') ||
            document.querySelector('.clearbox-panel');
        if (!panel) return;

        let head = panel.querySelector('.dnf-clearbox-head');
        if (!head) {
            head = document.createElement('div');
            head.className = 'dnf-clearbox-head';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sm dnf-clearbox-all';
            btn.setAttribute('data-dnf-clearbox-all', '1');
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                runClearBoxAll(btn);
            });
            head.appendChild(btn);
            panel.insertBefore(head, panel.firstChild);
        }
        setClearBoxButtonState(head.querySelector('.dnf-clearbox-all'));
    }

    /* ============================================================
     * HP / MP 血条实时同步（v5.47）
     *
     * 现象：经验条会随进度实时增长，但 HP / MP 条永远满格，看起来像张贴图。
     * 真正原因：游戏 CSS 里 `.hp-bar span` 命中了条内「所有 span」，
     *   连那条 position:absolute; inset:0 的文字层 .bar-label 也被刷上了
     *   整条的橙/蓝渐变。文字层铺满整条、盖在填充层上面，所以下面那条
     *   真正按血量缩放的填充层完全看不见了。经验条没有文字层 → 正常。
     * 修复：
     *   1) 把文字层背景抹掉（关键，一条 CSS 就解决）。
     *   2) 保险起见仍然读「HP 2878 / 3784」反推百分比，用 CSS 变量 + !important
     *      把宽度写到填充层上，万一哪天填充层宽度也坏了还能顶上。
     *   3) 如果填充层量出来还是满格、或结构里根本没有填充层，就盖一层
     *      自己画的轨道+填充+文字兜底。
     * 当前识别结果会显示在 HUD 的「血条同步」一行，方便排查。
     * ============================================================ */
    const barOverlayNeeded = new WeakSet();   // 需要走 overlay 兜底的条容器
    const barCheckState = new WeakMap();      // 填充层宽度校验的时间戳
    let barTargetsCache = [];                 // 兜底扫描的缓存（结构不固定时）
    let barTargetsScanAt = 0;

    function cssOf(el) { return (document.defaultView || window).getComputedStyle(el); }
    function parseBarPct(text) {
        const m = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(text || '');
        if (!m) return null;
        const cur = parseInt(m[1].replace(/,/g, ''), 10);
        const max = parseInt(m[2].replace(/,/g, ''), 10);
        if (!isFinite(cur) || !isFinite(max) || max <= 0) return null;
        return Math.max(0, Math.min(100, cur / max * 100));
    }
    // 在条容器里找"填充层"：排除文字层后的第一个 span/div
    function findBarFill(container, labelEl) {
        for (const el of container.children) {
            if (el === labelEl) continue;
            if (el.classList && el.classList.contains('bar-label')) continue;
            if (el.classList && el.classList.contains('dnf-bar-ov')) continue;
            if (el.tagName === 'SPAN' || el.tagName === 'DIV') return el;
        }
        return null;
    }
    function findBarLabel(container) {
        for (const el of container.children) {
            if (el.classList && el.classList.contains('bar-label')) return el;
        }
        return null;
    }
    // 一次性样式：填充层宽度由 CSS 变量驱动；.dnf-bar-ov 是兜底覆盖层
    function ensureBarSyncStyle() {
        if (document.getElementById('dnf-bar-sync-style')) return;
        const st = document.createElement('style');
        st.id = 'dnf-bar-sync-style';
        st.textContent = [
            // 病根：游戏里 `.hp-bar span` 这条规则会作用到「所有 span」，
            // 包括那条 position:absolute; inset:0 的文字层 .bar-label。
            // 于是文字层被刷成了整条的橙/蓝渐变，铺满整条、盖住下面真正
            // 按血量缩放的填充层 → 血掉到 76% 看着还是满格。经验条没有
            // 文字层，所以它一直是正常的。这里把文字层背景抹掉即可。
            '.hp-bar .bar-label,.mp-bar .bar-label,.exp-bar .bar-label{',
            'background:transparent!important;background-image:none!important}',
            '.dnf-bar-sync{width:var(--dnf-bar-w,auto)!important;transition:width .35s ease!important}',
            '.dnf-bar-nomove{transition:none!important}',
            '.dnf-bar-ov{position:absolute;left:0;top:0;right:0;bottom:0;display:block;',
            'border-radius:inherit;overflow:hidden;pointer-events:none;z-index:5}',
            '.dnf-bar-ov>i{position:absolute;top:0;bottom:0;left:0;display:block}',
            '.dnf-bar-ov>i.t{right:0}',
            '.dnf-bar-ov>i.f{border-radius:inherit;transition:width .35s ease}',
            '.dnf-bar-ov>span.l{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;',
            'align-items:center;color:#fff;text-shadow:0 1px 2px #000;white-space:nowrap;line-height:1}'
        ].join('');
        (document.head || document.documentElement).appendChild(st);
    }
    function writeBarWidth(fill, pct) {
        const w = pct.toFixed(1) + '%';
        ensureBarSyncStyle();
        // 先写变量再加类，避免出现"有类没变量 → width:auto 满格"的一帧
        if (fill.style.getPropertyValue('--dnf-bar-w') !== w) fill.style.setProperty('--dnf-bar-w', w);
        // Vue 重渲染时会整个重写 class，所以每轮都补一次
        if (!fill.classList.contains('dnf-bar-sync')) fill.classList.add('dnf-bar-sync');
    }
    function parseRgb(str) {
        const m = /rgba?\(([^)]+)\)/.exec(str || '');
        if (!m) return null;
        const p = m[1].split(',').map(v => parseFloat(v));
        if (p.length < 3 || !isFinite(p[0])) return null;
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    // 轨道底色：把 45% 的黑叠到最近一层不透明父背景上，取个实色，
    // 这样覆盖层是不透明的，能彻底盖住原条（半透明会透出原来的满格色块）
    function trackColorFor(container) {
        let el = container.parentElement;
        let bg = null;
        while (el && el !== document.documentElement) {
            const c = parseRgb(cssOf(el).backgroundColor);
            if (c && c.a >= 0.99) { bg = c; break; }
            el = el.parentElement;
        }
        if (!bg) bg = { r: 26, g: 18, b: 8 };
        const a = 0.45;
        return 'rgb(' + Math.round(bg.r * (1 - a)) + ',' +
            Math.round(bg.g * (1 - a)) + ',' + Math.round(bg.b * (1 - a)) + ')';
    }
    function drawBarOverlay(container, pct, kind, text, labelEl) {
        ensureBarSyncStyle();
        let ov = null;
        for (const el of container.children) {
            if (el.classList && el.classList.contains('dnf-bar-ov')) { ov = el; break; }
        }
        if (!ov) {
            if (cssOf(container).position === 'static') container.style.position = 'relative';
            ov = document.createElement('div');
            ov.className = 'dnf-bar-ov';
            const track = document.createElement('i');
            track.className = 't';
            track.style.background = trackColorFor(container);
            const fill = document.createElement('i');
            fill.className = 'f';
            fill.style.background = kind === 'mp'
                ? 'linear-gradient(90deg,#3b82f6,#38bdf8)'
                : 'linear-gradient(90deg,#e04f4f,#f58a42)';
            const label = document.createElement('span');
            label.className = 'l';
            const cs = labelEl ? cssOf(labelEl) : null;
            if (cs) {
                label.style.fontSize = cs.fontSize;
                label.style.fontWeight = cs.fontWeight;
                // 原条文字如果是居中就用居中，否则左对齐（游戏里实际是左对齐）
                const jc = (cs.display || '').indexOf('flex') === 0 ? cs.justifyContent : 'flex-start';
                const useCenter = jc && jc !== 'normal' && jc !== 'flex-start';
                label.style.justifyContent = useCenter ? jc : 'flex-start';
                if (!useCenter) label.style.paddingLeft = '6px';
            } else {
                label.style.fontSize = '11px';
                label.style.paddingLeft = '6px';
            }
            ov.appendChild(track);
            ov.appendChild(fill);
            ov.appendChild(label);
            container.appendChild(ov);
        }
        const fill = ov.querySelector('i.f');
        const label = ov.querySelector('span.l');
        const w = pct.toFixed(1) + '%';
        if (fill && fill.style.width !== w) fill.style.width = w;
        if (label && label.textContent !== text) label.textContent = text;
    }
    // 收集需要同步的条：先走 class 快路径，找不到再按文字兜底（结果缓存 2 秒）
    function collectBarTargets() {
        const out = [];
        for (const bar of document.querySelectorAll('.hp-bar, .mp-bar')) {
            const text = (bar.textContent || '').trim();
            const pct = parseBarPct(text);
            if (pct == null) continue;
            out.push({
                container: bar, pct, text,
                kind: /^\s*MP/i.test(text) ? 'mp' : 'hp',
                labelEl: findBarLabel(bar)
            });
        }
        if (out.length) return out;

        const now = Date.now();
        if (!barTargetsCache.length || now - barTargetsScanAt > CONFIG.hpBarFallbackScanMs) {
            barTargetsScanAt = now;
            barTargetsCache = [];
            for (const el of document.querySelectorAll('span,div,b,i,em,strong')) {
                if (el.classList && (el.classList.contains('dnf-bar-ov') || el.classList.contains('bar-label'))) continue;
                if (el.children.length > 1) continue;
                const t = (el.textContent || '').trim();
                if (!t || t.length > 32) continue;
                if (!/^(HP|MP)\s*[\d,]+\s*\/\s*[\d,]+$/.test(t)) continue;
                // 往上找一个"条状"容器：矮（<=42px）、够宽、里面还有别的元素
                let node = el.parentElement;
                let container = null;
                for (let i = 0; i < 3 && node && node !== document.body; i++) {
                    const r = node.getBoundingClientRect();
                    if (r.height > 4 && r.height <= 44 && r.width >= 80 && node.children.length >= 2) {
                        container = node;
                        break;
                    }
                    node = node.parentElement;
                }
                if (!container) continue;
                if (barTargetsCache.some(c => c.container === container)) continue;
                barTargetsCache.push({ container, labelEl: el });
            }
        }
        for (const c of barTargetsCache) {
            if (!c.container.isConnected) continue;
            const text = (c.container.textContent || '').trim();
            const pct = parseBarPct(text);
            if (pct == null) continue;
            out.push({
                container: c.container, pct, text,
                kind: /^\s*MP/i.test(text) ? 'mp' : 'hp',
                labelEl: c.labelEl
            });
        }
        return out;
    }
    function applyBarToTarget(t) {
        const { container, pct, kind, text, labelEl } = t;
        const fill = barOverlayNeeded.has(container) ? null : findBarFill(container, labelEl);
        if (fill) {
            writeBarWidth(fill, pct);
            // 隔一段时间量一次：如果填充层还是接近整条宽，说明宽度没生效
            // → 标记该条改用覆盖层（量之前临时关掉过渡，否则量到动画中间值）
            const now = Date.now();
            const st = barCheckState.get(container);
            if (!st) {
                barCheckState.set(container, { next: now + CONFIG.barCheckFirstMs });
            } else if (now >= st.next) {
                st.next = now + CONFIG.barCheckEveryMs;
                const cw = container.getBoundingClientRect().width;
                if (cw > 60 && pct < 88) {
                    fill.classList.add('dnf-bar-nomove');
                    const fw = fill.getBoundingClientRect().width;
                    fill.classList.remove('dnf-bar-nomove');
                    if (fw > cw * 0.94) barOverlayNeeded.add(container);
                }
            }
        } else {
            barOverlayNeeded.add(container);
        }
        if (barOverlayNeeded.has(container)) drawBarOverlay(container, pct, kind, text, labelEl);
    }
    function syncHpMpBars() {
        if (!CONFIG.hpBarSync || !document.body) return;
        // 只在游戏页内跑：登录/选角/排行榜等页面没有血条，没必要 400ms 扫一次
        if (!isInGame()) return;
        let targets = [];
        try {
            targets = collectBarTargets();
        } catch (e) {
            bloodBarStatusText = '识别异常: ' + (e && e.message ? e.message : e);
            return;
        }
        if (!targets.length) {
            bloodBarStatusText = '未找到 HP/MP 条（页面结构不匹配）';
            return;
        }
        const parts = [];
        let overlayCount = 0;
        for (const t of targets) {
            try {
                applyBarToTarget(t);
            } catch (e) { /* 单条失败不影响另一条 */ }
            if (barOverlayNeeded.has(t.container)) overlayCount++;
            parts.push((t.kind === 'mp' ? 'MP ' : 'HP ') + Math.round(t.pct) + '%');
        }
        bloodBarStatusText = parts.join(' / ') +
            (overlayCount ? '（覆盖模式 ' + overlayCount + '）' : '（原生填充）');
    }

    /* ============================================================
     * 扫描调度（模块级：角色软重置时也能调用，避免作用域引用错误）
     *  - runScans（全量）：1s 轮询；含死亡/登录/结算等检测
     *  - runLightScans（轻量）：DOM 变化时执行，只做纯 DOM 维护
     * ============================================================ */
    function runScans() {
        relocateTabsAfterSettlement();
        applyModuleOrder();
        applyHideUnlearnedSkills();
        applyUiTheme();
        applyGameAssistantVisibility();
        if (CONFIG.enableReviveHud) {
            checkLoginAndReset();
            scanSettlement();
            scanBattleLog();
            scanLevelExp();
            scanAssistStats();
        }
    }
    function runLightScans() {
        relocateTabsAfterSettlement();
        applyModuleOrder();
        applyHideUnlearnedSkills();
        applyUiTheme();
        applyGameAssistantVisibility();
    }

    /* ============================================================
     * 启动
     * ============================================================ */
    function start() {
        // 防止脚本被重复注入（Tampermonkey 更新 / SPA 重载）后出现多套定时器
        if (window.__dnfHelperStarted) return;
        window.__dnfHelperStarted = true;
        log('脚本已加载：挂机统计 HUD（v' + VERSION + '）');
        showTip('脚本 v' + VERSION + ' 已启动');
        // 注入样式（怪物血条约束 + 史诗弹窗动画）
        injectStyles();
        // 0. 初始化 HUD（body 可能还没生成，延后到 DOM 就绪）
        const initHud = () => {
            // 启动时先尝试识别角色并加载对应设置；识别不到（没进 GameView）就用默认值
            checkAndSwitchCharacter();
            if (CONFIG.enableReviveHud) ensureHud();
        };
        if (document.body) initHud();
        else document.addEventListener('DOMContentLoaded', initHud);

        // 0.1 v5.75：监听游戏真实红字（div.error），出现/改字时同步到插件贴顶 toast
        startGameErrorSync();

        // 详情弹窗「打造」跳转修复（游戏原实现先清空 detailItem 再读派生状态，必然失效）
        initDetailCraftFix();

        // v5.77：仓库装备格子点击只开详情（捕获阶段拦截原生直接取出），详情底部「确认取出」
        initWarehouseEquipDetailGuard();

        // v5.80：仓库材料点击弹出「自选数量」再取出（默认整组，取消不发请求）
        initWarehouseMaterialQtyGuard();

        // v5.80：怪物血条按文本里的 cur/max 提升到 5 位小数百分比，避免百万血时进度条长时间不动
        initMonsterHpPrecision();

        // v5.81：启动后延迟 8s 静默检查更新（只提示不执行；设置面板可关闭）
        scheduleUpdateCheck();

        // 1. 扫描分层，避免背包/装备列表渲染风暴拖慢加载：
        //  - runScans（全量）：只在 1s 定时轮询执行；含需要读取页面文本的检测
        //    （死亡/登录/结算），文本读取成本高，不做高频触发。
        //  - runLightScans（轻量）：DOM 变化时执行，只做纯 DOM 维护，不读取页面文本。
        const runScans = () => {
            relocateTabsAfterSettlement();
            applyModuleOrder();
            applyHideUnlearnedSkills();
            applyUiTheme();
            applyGameAssistantVisibility();
            applyWarehouseOrder();
            applyDetailDepositButton();
            applyWarehouseWithdrawBox();
            applyClearBoxAllButton();
            if (CONFIG.enableReviveHud) {
                checkLoginAndReset();
                scanSettlement();
                scanBattleLog();
                scanLevelExp();
                scanAssistStats();
            }
        };
        const runLightScans = () => {
            relocateTabsAfterSettlement();
            applyModuleOrder();
            applyHideUnlearnedSkills();
            applyUiTheme();
            applyGameAssistantVisibility();
            applyWarehouseOrder();
            applyDetailDepositButton();
            applyWarehouseWithdrawBox();
            applyClearBoxAllButton();
        };
        // DOM 变化去抖：合并为一轮轻量扫描
        let lightScanScheduled = false;
        const scheduleLightScan = () => {
            if (lightScanScheduled) return;
            lightScanScheduled = true;
            setTimeout(() => { lightScanScheduled = false; runLightScans(); }, 300);
        };

        // 1.0 定时轮询（兜底）：稳态下每秒一次全量扫描
        setInterval(() => {
            checkAndSwitchCharacter();   // 每次都查角色有没有换；进 GameView 时也会触发
            runScans();
        }, CONFIG.pollInterval);

        // 1.1 挂机时长每秒刷新显示（不重新扫描，只重渲染 HUD）
        if (CONFIG.enableReviveHud) {
            setInterval(() => {
                if (!hudEl) return;
                renderHud();
            }, 1000);
        }

        // 2. 监听 DOM 变化（SPA 动态插入）—— 去抖 + 仅轻量扫描，避免高频重排
        //    不监听 characterData：逐字符变更过密，且稳态轮询足以覆盖
        const observer = new MutationObserver(scheduleLightScan);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        // 3. 监听 SPA 路由变化（hash 路由）
        let lastHash = location.hash;
        window.addEventListener('hashchange', () => {
            log('路由变化:', lastHash, '->', location.hash);
            lastHash = location.hash;
            // 路由切换后给页面一点渲染时间，再统一扫描
            setTimeout(() => {
                lastRelocateAt = 0;
                runScans();
            }, 400);
        });

        // 4. 首次执行
        runScans();
        // 布局调整（首次）
        relocateTabsAfterSettlement();

        // HP / MP 血条实时同步：血量变化通常 1 秒内推送，400ms 轮询足够跟手
        syncHpMpBars();
        setInterval(syncHpMpBars, 400);
    }

    // @run-at document-start：等 DOM 就绪后再启动主逻辑
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
