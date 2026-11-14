// ==UserScript==
// @name         DNF挂机助手
// @namespace    http://tampermonkey.net/
// @version      5.87
// @description  挂机统计浮窗（首次默认左上角、折叠胶囊可拖动/左右贴边吸附并记忆位置、窄屏自适应不溢出；设置面板移动端完整可见可滚动）+ 掉落/技能日志 + 怪物血条线性百分比（5 位小数精度，百万血不再卡住不动）+ HP/MP 血条修复 + 打造跳转修复 + 仓库装备/仓库材料置顶 + 背包详情「存仓」按钮（锁定装备也可存）+ 仓库装备「点击先看详情、再确认取出」（取消不发请求）+ 仓库材料「自选数量取出」（默认整组、超限回填、取消不发请求）+ 通关秘宝盒「按批全开」（每批 10 个、批间约 120ms、可停止）+ 游戏红字同步提示（监听游戏 .error，把文案用插件原样式贴顶提示）+ 屏蔽游戏自带挂机浮窗（可开关）+ 联网检查更新（只提示不执行，点击跳转下载页；设置面板可手动检查/关闭自动检查；按 ghproxy→raw→jsDelivr 多源依次取 version.json，下载链接跟随实际成功源）+ 装备图鉴（HUD 日志旁入口：按游戏「大类/职业/部位/甲种」分类筛选 + 搜索 + 详情）+ 顶部重复「世界BOSS」按钮移除 + 「兑换码」移到商店「通用制作」旁（以上两项仅移动端 ≤760px 生效，桌面端保持游戏原样）+ 移除仓库区块排序 + 宝珠图鉴（161 条，属性类型/可附魔部位/稀有度三级筛选，数据来自 /api/orbs，图标按 id 补齐并本地缓存）。
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
    const VERSION = '5.87';

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
     * 联网检查更新（v5.81 引入，v5.86 改为多源取 version.json）
     * ------------------------------------------------------------
     * 背景：jsDelivr 的 @main 别名会长期卡在旧 commit（实测卡了 5 天不刷新），
     * 而 cdn.jsdelivr.net 在部分网络下经常连接被重置，原先只有一个取源，
     * 一失败就完全查不到更新。
     * 现在按顺序尝试，每源独立超时，全部失败才判定失败：
     *   ① ghproxy.net 转发 raw.githubusercontent.com（实测能读到最新）
     *   ② raw.githubusercontent.com 直连
     *   ③ cdn.jsdelivr.net/gh/<owner>/<repo>@main（别名可能滞后，放最后）
     * 下载地址跟随「本次实际成功的源」，不再写死 jsDelivr，
     * 保证弹窗里「点击更新」能下到与 version.json 一致的最新脚本。
     * 安全红线不变：只读 JSON + 提示 + 跳转，不 eval、不远程执行、
     * 不自动替换本地脚本，也不碰任何游戏接口。
     * 自动检查失败静默；手动检查才给明确提示。
     * ============================================================ */
    const UPDATE_OWNER = '1694385621';
    const UPDATE_REPO = 'DNF-js';
    const UPDATE_BRANCH = 'main';
    const RAW_FILE_BASE = 'https://raw.githubusercontent.com/' + UPDATE_OWNER + '/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/';
    const GHPROXY_PREFIX = 'https://ghproxy.net/';
    const JSDELIVR_FILE_BASE = 'https://cdn.jsdelivr.net/gh/' + UPDATE_OWNER + '/' + UPDATE_REPO + '@' + UPDATE_BRANCH + '/';

    const UPDATE_SOURCES = [
        {
            id: 'ghproxy',
            name: 'ghproxy 转发 raw',
            versionUrl: GHPROXY_PREFIX + RAW_FILE_BASE + 'version.json',
            scriptUrl: GHPROXY_PREFIX + RAW_FILE_BASE + 'dnf-helper.js',
            timeout: 8000,
        },
        {
            id: 'raw',
            name: 'raw.githubusercontent',
            versionUrl: RAW_FILE_BASE + 'version.json',
            scriptUrl: RAW_FILE_BASE + 'dnf-helper.js',
            timeout: 8000,
        },
        {
            id: 'jsdelivr',
            name: 'jsDelivr @main',
            versionUrl: JSDELIVR_FILE_BASE + 'version.json',
            scriptUrl: JSDELIVR_FILE_BASE + 'dnf-helper.js',
            timeout: 6000,
        },
    ];
    // 兜底跳转地址：第一优先源（所有源都失败时仍给用户一个可点的入口）
    const UPDATE_SCRIPT_URL = UPDATE_SOURCES[0].scriptUrl;
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

    /**
     * 从单个源拉 version.json（独立超时 + 时间戳绕缓存）。
     * 成功返回 {version,url,notes,source}，任何失败（断网/404/超时/JSON 坏/字段非法）返回 null。
     * 下载地址一律用「本源的 scriptUrl」，不采用 JSON 里的 url：
     * 那份 url 往往还写着滞后的 jsDelivr 地址，会把用户引到旧脚本。
     */
    async function fetchManifestFromSource(src) {
        if (typeof fetch !== 'function') return null;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) { } }, src.timeout) : 0;
        try {
            const url = src.versionUrl + '?_t=' + Date.now();
            const resp = await fetch(url, {
                cache: 'no-store',
                credentials: 'omit',
                signal: ctrl ? ctrl.signal : undefined,
            });
            if (!resp || !resp.ok) return null;
            const data = await resp.json();
            if (!data || typeof data !== 'object') return null;
            const version = typeof data.version === 'string' ? data.version.trim() : '';
            if (!/^\d+(\.\d+)*$/.test(version.replace(/^v/i, ''))) return null;
            const notes = typeof data.notes === 'string' ? data.notes.trim() : '';
            return { version: version, url: src.scriptUrl, notes: notes, source: src.id, sourceName: src.name };
        } catch (_) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 依次尝试所有源；任一成功即返回，全部失败返回 null */
    async function fetchUpdateManifest() {
        for (let i = 0; i < UPDATE_SOURCES.length; i++) {
            const src = UPDATE_SOURCES[i];
            const info = await fetchManifestFromSource(src);
            if (info) {
                log('更新源命中：' + src.name + ' → v' + info.version);
                return info;
            }
            log('更新源不可用：' + src.name);
        }
        return null;
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
                log('检查更新失败：所有更新源均不可用（已静默忽略）');
                if (statusEl) statusEl.textContent = '检查失败：所有更新源均不可用';
                if (manual) showTip('检查更新失败：所有更新源均不可用');
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
    // ===== v5.86 UPDATE CHECK END =====



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
        // v5.83：装备图鉴按钮（紧挨日志按钮，沿用同一套圆形图标样式）
        const atlasBtn = document.createElement('span');
        atlasBtn.title = '史诗图鉴（装备查询）';
        atlasBtn._colorStyle = 'color:#ffd76b';
        atlasBtn.style.cssText = btnBase + atlasBtn._colorStyle;
        atlasBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z"/>' +
            '<path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>' +
            '<path d="M7 8h2M7 12h2M15 8h2M15 12h2"/>' +
            '</svg>';
        applyHover(atlasBtn);
        atlasBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleEquipAtlas(); });
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
        rightGroup.appendChild(atlasBtn);
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
            [logBtn, atlasBtn, resetBtn, gearBtn, toggleSpan].forEach((el, i) => {
                el.style.cssText = btnBase + (el._colorStyle || '') +
                    (hudCollapsed && i < 4 ? ';display:none !important' : '');
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
    /* ============================================================
     * 装备图鉴（v5.83）
     * ------------------------------------------------------------
     * 并入自独立脚本「DNF 史诗图鉴 2.3.0」（原作者 DSH），只保留装备数据与
     * 面板本体；入口统一走 HUD 标题栏「日志」右侧的圆形按钮，不再生成独立胶囊，
     * 避免出现两套重复入口。样式 id 沿用 dnf-guide85-style：若用户同时装着原
     * 独立脚本，谁先注入谁生效（规则完全一致），后注入的自动跳过，不会冲突。
     * 只读本地静态数据，不发任何请求、不写游戏接口。
     * ============================================================ */
    const ATLAS_API = (function () {
        'use strict';
    const ITEMS = [{"id":100050203,"name":"逝魔之疾咒长袍","level":85,"slot":"coat","armor":"cloth","wg":"","type":"布甲上衣","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_coat_cloth_coat_21.png","atk":"","matk":"","ind":0,"pdef":"1224~1116","mdef":"","str":0,"intel":46,"vit":0,"spr":46,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["施放技能时， 可以通过消耗自身1%的MP值， 增加15%的魔法攻击力和独立攻击力， 效果持续60秒。"],"set":""},{"id":100050204,"name":"封霜雪影长袍","level":85,"slot":"coat","armor":"cloth","wg":"","type":"布甲上衣","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_coat_cloth_coat_22.png","atk":"","matk":"","ind":0,"pdef":"1224~1116","mdef":"","str":0,"intel":46,"vit":0,"spr":46,"elem":"","addDmg":0,"incDmg":0,"affix":"魔法暴击 +5%　水属性攻击 +10%","skills":[],"explain":["装备时， 可以使300px范围内的所有敌人减少44点的冰属性抗性。"],"set":""},{"id":100060131,"name":"暗魅之影上衣","level":85,"slot":"coat","armor":"leather","wg":"","type":"皮甲上衣","icon":"/assets/icons/sprite_item_new_equipment_03_leather_coat_leather_coat_22.png","atk":"","matk":"","ind":0,"pdef":"2448~2232","mdef":"","str":84,"intel":84,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":18,"affix":"","skills":[],"explain":["背击攻击时，有1%的几率使自身进入伪装状态5秒。 (冷却时间5秒)","攻击时伤害 +18%"],"set":""},{"id":100060132,"name":"战术之王的御敌胸甲","level":85,"slot":"coat","armor":"leather","wg":"","type":"皮甲上衣","icon":"/assets/icons/sprite_item_new_equipment_03_leather_coat_leather_coat_23.png","atk":"","matk":"","ind":0,"pdef":"2448~2232","mdef":"","str":69,"intel":69,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +2%　stuck resistance +2%","skills":[],"explain":["装备时，可以使300px范围内的队员增加80点物理攻击力。","装备时，可以使300px范围内的队员增加80点魔法攻击力。","装备时，可以使300px范围内的队员增加80点独立攻击力。"],"set":""},{"id":100070158,"name":"天御雷罚战甲","level":85,"slot":"coat","armor":"light","wg":"","type":"轻甲上衣","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_coat_larmor_coat_21.png","atk":"59~59","matk":"59~59","ind":67,"pdef":"3672~3348","mdef":"","str":46,"intel":31,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%　魔法暴击 +3%　光属性攻击 +20%","skills":[],"explain":["攻击时， 有5%的几率发动雷电之怒。 (冷却时间0.5秒)","攻击时， 有5%的几率发动雷电之怒攻击400px范围内的所有敌人。 (冷却时间15秒)"],"set":""},{"id":100070159,"name":"最佳球手的暴走战衣","level":85,"slot":"coat","armor":"light","wg":"","type":"轻甲上衣","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_coat_larmor_coat_22.png","atk":"","matk":"","ind":0,"pdef":"3672~3348","mdef":"","str":46,"intel":31,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":18,"affix":"","skills":[],"explain":["攻击时， 增加18%的伤害。"],"set":""},{"id":100080138,"name":"誓血之盟铠甲","level":85,"slot":"coat","armor":"heavy","wg":"","type":"重甲上衣","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_coat_harmor_coat_20.png","atk":"","matk":"","ind":0,"pdef":"4896~4464","mdef":"","str":242,"intel":231,"vit":39,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["HP为100%时， 会减少15%的HP值。","HP从100%起每减少1%时， 会额外增加10点力量和智力、 0.7%的攻击速度和1.1%的施放速度。"],"set":""},{"id":100080139,"name":"千蛛碎影之毒牙胸甲","level":85,"slot":"coat","armor":"heavy","wg":"","type":"重甲上衣","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_coat_harmor_coat_21.png","atk":"","matk":"","ind":0,"pdef":"4896~4464","mdef":"","str":182,"intel":171,"vit":39,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 有10%的几率使敌人进入中毒状态。","攻击中毒状态的敌人时， 敌人的防御力减少， 效果持续10秒。","地下城中：中毒伤害 +20%"],"set":""},{"id":100090074,"name":"魔战无双胸甲","level":85,"slot":"coat","armor":"plate","wg":"","type":"板甲上衣","icon":"/assets/icons/sprite_item_new_equipment_06_plate_coat_plate_coat_21.png","atk":"","matk":"","ind":0,"pdef":"6120~5580","mdef":"","str":39,"intel":39,"vit":42,"spr":0,"elem":"","addDmg":0,"incDmg":10,"affix":"施放速度 +5%　最大MP +300%","skills":[],"explain":["所有技能MP消耗量 +15%","所有技能冷却时间 -12%","对敌人的伤害 +10%"],"set":""},{"id":100090075,"name":"霸域英豪胸甲","level":85,"slot":"coat","armor":"plate","wg":"","type":"板甲上衣","icon":"/assets/icons/sprite_item_new_equipment_06_plate_coat_plate_coat_22.png","atk":"","matk":"","ind":0,"pdef":"6120~5580","mdef":"","str":89,"intel":89,"vit":42,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["被物理攻击时， 使自身进入霸体状态5秒。 (冷却时间5秒)","物理攻击时， 有10%的几率使自身进入霸体状态5秒。 (冷却时间5秒)","该装备的霸体效果发动后， 使自身时增加100点物理攻击力、 100点魔法攻击力和100点独立攻击力。","(解除装备后效果消失)"],"set":""},{"id":100100133,"name":"逝魔之暴烈长裤","level":85,"slot":"pants","armor":"cloth","wg":"","type":"布甲下装","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_pants_cloth_pants_19.png","atk":"","matk":"","ind":0,"pdef":"1020~930","mdef":"","str":0,"intel":46,"vit":0,"spr":46,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["攻击和施放技能时， 消耗1%的MP值， 增加15%的魔法暴击伤害， 效果持续60秒。"],"set":""},{"id":100100134,"name":"火殒灭炎长裤","level":85,"slot":"pants","armor":"cloth","wg":"","type":"布甲下装","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_pants_cloth_pants_20.png","atk":"","matk":"","ind":0,"pdef":"1020~930","mdef":"","str":0,"intel":46,"vit":0,"spr":46,"elem":"","addDmg":0,"incDmg":0,"affix":"魔法暴击 +5%　火属性攻击 +10%","skills":[],"explain":["装备时， 可以使300px范围内的所有敌人减少44点的火属性抗性。"],"set":""},{"id":100110119,"name":"血舞之牙护腿","level":85,"slot":"pants","armor":"leather","wg":"","type":"皮甲下装","icon":"/assets/icons/sprite_item_new_equipment_03_leather_pants_leather_pants_18.png","atk":"","matk":"","ind":0,"pdef":"2040~1860","mdef":"","str":84,"intel":84,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["破招攻击时， 有1%的几率进入伪装状态5秒。 (冷却时间5秒)","暴击伤害 +15%"],"set":""},{"id":100110120,"name":"战术之王的御敌腿甲","level":85,"slot":"pants","armor":"leather","wg":"","type":"皮甲下装","icon":"/assets/icons/sprite_item_new_equipment_03_leather_pants_leather_pants_19.png","atk":"","matk":"","ind":0,"pdef":"2040~1860","mdef":"","str":69,"intel":69,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +2%　stuck resistance +2%","skills":[],"explain":["装备时，可以使300px范围内的队员增加10%的物理暴击率。","装备时，可以使300px范围内的队员增加10%的魔法暴击率。"],"set":""},{"id":100120151,"name":"天御炎袭护腿","level":85,"slot":"pants","armor":"light","wg":"","type":"轻甲下装","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_pants_larmor_pants_19.png","atk":"59~59","matk":"59~59","ind":67,"pdef":"3060~2790","mdef":"","str":46,"intel":31,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%　魔法暴击 +3%　火属性攻击 +20%","skills":[],"explain":["攻击时， 有5%的几率生成烈焰攻击敌人。 (冷却时间0.5秒)","攻击时， 有5%的几率生成烈焰攻击400px范围内的所有敌人。 (冷却时间15秒)"],"set":""},{"id":100120152,"name":"最佳球手的奇袭长裤","level":85,"slot":"pants","armor":"light","wg":"","type":"轻甲下装","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_pants_larmor_pants_20.png","atk":"","matk":"","ind":0,"pdef":"3060~2790","mdef":"","str":46,"intel":31,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["暴击伤害 +15%","背击攻击时， 暴击伤害 +20%"],"set":""},{"id":100130132,"name":"誓血之盟腿甲","level":85,"slot":"pants","armor":"heavy","wg":"","type":"重甲下装","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_pants_harmor_pants_18.png","atk":"","matk":"","ind":0,"pdef":"4080~3720","mdef":"","str":42,"intel":31,"vit":39,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +15%　魔法暴击 +15%","skills":[],"explain":["MP为100%时， 会减少15%的MP值。","MP从100%起每减少1%时， 会增加1%的物理暴击率和魔法暴击率。"],"set":""},{"id":100130133,"name":"千蛛碎影之蛛网护腿","level":85,"slot":"pants","armor":"heavy","wg":"","type":"重甲下装","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_pants_harmor_pants_19.png","atk":"","matk":"","ind":0,"pdef":"4080~3720","mdef":"","str":182,"intel":173,"vit":39,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["攻击时有10%的几率使敌人进入束缚状态。","攻击束缚状态的敌人时， 敌人的防御力减少， 效果持续10秒。"],"set":""},{"id":100140069,"name":"魔战无双腿甲","level":85,"slot":"pants","armor":"plate","wg":"","type":"板甲下装","icon":"/assets/icons/sprite_item_new_equipment_06_plate_pants_plate_pants_18.png","atk":"","matk":"","ind":0,"pdef":"5100~4650","mdef":"","str":39,"intel":39,"vit":42,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +5%　移动速度 +5%","skills":[],"explain":["所有技能冷却时间 -10%"],"set":""},{"id":100140070,"name":"霸域英豪护腿","level":85,"slot":"pants","armor":"plate","wg":"","type":"板甲下装","icon":"/assets/icons/sprite_item_new_equipment_06_plate_pants_plate_pants_19.png","atk":"","matk":"","ind":0,"pdef":"5100~4650","mdef":"","str":89,"intel":89,"vit":42,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["被魔法攻击时， 可以进入霸体状态5秒。 (冷却时间5秒)","魔法攻击时， 有10%的几率发动霸体状态,， 效果持续5秒。 (冷却时间5秒)","该装备的霸体状态下， 增加100点物理攻击力、 魔法攻击力和独立攻击力。","(解除装备后效果消失)"],"set":""},{"id":100150124,"name":"逝魔之灵悟肩甲","level":85,"slot":"shoulder","armor":"cloth","wg":"","type":"布甲头肩","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_neck_cloth_neck_17.png","atk":"","matk":"","ind":0,"pdef":"816~744","mdef":"","str":0,"intel":37,"vit":0,"spr":37,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["每10秒减少1%的MP值。","攻击和施放技能时， 增加2%的魔法攻击力和独立攻击力， 效果持续60秒。"],"set":""},{"id":100150125,"name":"蚀日无辉肩甲","level":85,"slot":"shoulder","armor":"cloth","wg":"","type":"布甲头肩","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_neck_cloth_neck_18.png","atk":"","matk":"","ind":0,"pdef":"816~744","mdef":"","str":0,"intel":77,"vit":0,"spr":37,"elem":"","addDmg":0,"incDmg":0,"affix":"光属性攻击 +10%","skills":[],"explain":["装备时， 可以使300px范围内的所有敌人减少44点的光属性抗性。"],"set":""},{"id":100160086,"name":"冥殇之刃肩甲","level":85,"slot":"shoulder","armor":"leather","wg":"","type":"皮甲头肩","icon":"/assets/icons/sprite_item_new_equipment_03_leather_neck_leather_neck_17.png","atk":"","matk":"","ind":0,"pdef":"1632~1488","mdef":"","str":61,"intel":61,"vit":0,"spr":34,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +5%　魔法暴击 +5%","skills":[],"explain":["攻击时， 有1%的几率进入伪装状态5秒。 (冷却时间5秒)","攻击时， 使自身增加15%的攻击速度、 10%的物理暴击率和魔法暴击率， 效果持续10秒。 (冷却时间10秒)"],"set":""},{"id":100160087,"name":"战术之王的御敌肩甲","level":85,"slot":"shoulder","armor":"leather","wg":"","type":"皮甲头肩","icon":"/assets/icons/sprite_item_new_equipment_03_leather_neck_leather_neck_18.png","atk":"","matk":"","ind":0,"pdef":"1632~1488","mdef":"","str":61,"intel":61,"vit":0,"spr":34,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +10%　stuck resistance +1%","skills":[],"explain":["装备时，可以使300px范围内的队员增加10%的攻击速度。","装备时，可以使300px范围内的队员增加15%的施放速度。","装备时，可以使300px范围内的队员增加10%的移动速度。"],"set":""},{"id":100170142,"name":"天御虫噬护肩","level":85,"slot":"shoulder","armor":"light","wg":"","type":"轻甲头肩","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_neck_larmor_neck_17.png","atk":"59~59","matk":"59~59","ind":67,"pdef":"2448~2232","mdef":"","str":37,"intel":25,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%　魔法暴击 +3%　暗属性攻击 +20%","skills":[],"explain":["攻击时， 有5%的几率召唤出黑色蜂群攻击敌人。 (冷却时间0.5秒)","攻击时， 有5%的几率召唤出黑色蜂群攻击400px范围内的所有敌人。 (冷却时间15秒)"],"set":""},{"id":100170143,"name":"最佳球手的反击护具","level":85,"slot":"shoulder","armor":"light","wg":"","type":"轻甲头肩","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_neck_larmor_neck_18.png","atk":"","matk":"","ind":0,"pdef":"2448~2232","mdef":"","str":337,"intel":325,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +350%","skills":[],"explain":["被击时， 使自身进入霸体状态2秒。"],"set":""},{"id":100180124,"name":"誓血之盟肩甲","level":85,"slot":"shoulder","armor":"heavy","wg":"","type":"重甲头肩","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_neck_harmor_neck_18.png","atk":"","matk":"","ind":0,"pdef":"3264~2976","mdef":"","str":34,"intel":25,"vit":31,"spr":0,"elem":"","addDmg":0,"incDmg":15,"affix":"最大MP +500%","skills":[],"explain":["所有技能MP消耗量 +15%","对敌人的伤害 +15%"],"set":""},{"id":100180125,"name":"千蛛碎影之蛛丝肩甲","level":85,"slot":"shoulder","armor":"heavy","wg":"","type":"重甲头肩","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_neck_harmor_neck_19.png","atk":"","matk":"","ind":0,"pdef":"3264~2976","mdef":"","str":134,"intel":125,"vit":31,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 有10%的几率使敌人进入感电状态。","攻击感电状态的敌人时， 敌人的防御力减少， 效果持续10秒。","地下城中：感电伤害 +20%"],"set":""},{"id":100190058,"name":"魔战无双肩甲","level":85,"slot":"shoulder","armor":"plate","wg":"","type":"板甲头肩","icon":"/assets/icons/sprite_item_new_equipment_06_plate_neck_plate_neck_17.png","atk":"","matk":"","ind":0,"pdef":"4080~3720","mdef":"","str":31,"intel":31,"vit":34,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +12%　施放速度 +15%　移动速度 +5%","skills":[],"explain":["攻击时， 有5%几率发动提升3.5倍攻击力效果的[基础精通]。"],"set":""},{"id":100190059,"name":"霸域英豪护肩","level":85,"slot":"shoulder","armor":"plate","wg":"","type":"板甲头肩","icon":"/assets/icons/sprite_item_new_equipment_06_plate_neck_plate_neck_18.png","atk":"","matk":"","ind":0,"pdef":"4080~3720","mdef":"","str":31,"intel":31,"vit":34,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +7%　魔法暴击 +7%","skills":[],"explain":["被远程攻击时， 可以使自身进入霸体状态5秒。 (冷却时间5秒)","远程攻击时， 可以使自身进入霸体状态5秒。 (冷却时间5秒)","在该装备的霸体状态下， 增加15%暴击伤害。","(解除装备后效果消失)"],"set":""},{"id":100200104,"name":"逝魔之灵心腰带","level":85,"slot":"belt","armor":"cloth","wg":"","type":"布甲腰带","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_belt_cloth_belt_17.png","atk":"","matk":"","ind":0,"pdef":"408~372","mdef":"","str":0,"intel":28,"vit":0,"spr":28,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["攻击时， 可以通过消耗自身1%的MP值， 增加20%的魔法暴击率， 效果持续60秒。"],"set":""},{"id":100200105,"name":"暗殇绝影腰带","level":85,"slot":"belt","armor":"cloth","wg":"","type":"布甲腰带","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_belt_cloth_belt_18.png","atk":"","matk":"","ind":0,"pdef":"408~372","mdef":"","str":0,"intel":68,"vit":0,"spr":28,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%　暗属性攻击 +10%","skills":[],"explain":["装备时， 可以使300px范围内的所有敌人减少44点的暗属性抗性。"],"set":""},{"id":100210108,"name":"亡灵之帐腰带","level":85,"slot":"belt","armor":"leather","wg":"","type":"皮甲腰带","icon":"/assets/icons/sprite_item_new_equipment_03_leather_belt_leather_belt_18.png","atk":"","matk":"","ind":0,"pdef":"816~744","mdef":"","str":53,"intel":53,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["施放技能时， 有5%的几率使自身进入伪装状态5秒。 (冷却时间5秒)","攻击时， 增加100点物理攻击力、 魔法攻击力和独立攻击力， 效果持续30秒。"],"set":""},{"id":100210109,"name":"战术之王的御敌腰带","level":85,"slot":"belt","armor":"leather","wg":"","type":"皮甲腰带","icon":"/assets/icons/sprite_item_new_equipment_03_leather_belt_leather_belt_19.png","atk":"","matk":"","ind":0,"pdef":"816~744","mdef":"","str":53,"intel":53,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +1%　stuck resistance +1%　inventory limit +3000%","skills":[],"explain":["装备后， 可以使300px范围内的队员暗属性强化增加20。","装备后， 可以使300px范围内的队员光属性强化增加20。","装备后， 可以使300px范围内的队员火属性强化增加20。","装备后， 可以使300px范围内的队员冰属性强化增加20。"],"set":""},{"id":100220137,"name":"天御凝霜腰带","level":85,"slot":"belt","armor":"light","wg":"","type":"轻甲腰带","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_belt_larmor_belt_17.png","atk":"59~59","matk":"59~59","ind":67,"pdef":"1224~1116","mdef":"","str":28,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%　物理暴击 +3%　魔法暴击 +3%　水属性攻击 +20%","skills":[],"explain":["攻击时， 有5%的几率生成冰霜爆炸。 (冷却时间0.5秒)","攻击时， 有5%的几率生成冰霜爆炸攻击400px范围内的所有敌人。 (冷却时间15秒)"],"set":""},{"id":100220138,"name":"最佳球手的冲锋腰带","level":85,"slot":"belt","armor":"light","wg":"","type":"轻甲腰带","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_belt_larmor_belt_18.png","atk":"","matk":"","ind":0,"pdef":"1224~1116","mdef":"","str":28,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +5%　stuck resistance +5%　inventory limit +3000%　物理暴击 +15%　魔法暴击 +15%","skills":[],"explain":["破招攻击时， 有10%的几率使自身进入霸体状态， 效果持续20秒。"],"set":""},{"id":100230124,"name":"誓血之盟腰带","level":85,"slot":"belt","armor":"heavy","wg":"","type":"重甲腰带","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_belt_harmor_belt_18.png","atk":"","matk":"","ind":0,"pdef":"1632~1488","mdef":"","str":25,"intel":18,"vit":23,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +1000%　inventory limit +3000%","skills":[],"explain":["消灭敌人时， 增加10点体力和100点HP最大值。","每400点HP最大值增加10点物理攻击力、魔法攻击力和独立攻击力。"],"set":""},{"id":100230125,"name":"千蛛碎影之蛛刺腰带","level":85,"slot":"belt","armor":"heavy","wg":"","type":"重甲腰带","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_belt_harmor_belt_19.png","atk":"","matk":"","ind":0,"pdef":"1632~1488","mdef":"","str":125,"intel":118,"vit":23,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["攻击时， 有10%的几率使敌人进入灼伤状态。","攻击灼伤状态的敌人时， 敌人的防御力减少， 效果持续10秒。","地下城中：灼伤伤害 +20%"],"set":""},{"id":100240061,"name":"魔战无双腰带","level":85,"slot":"belt","armor":"plate","wg":"","type":"板甲腰带","icon":"/assets/icons/sprite_item_new_equipment_06_plate_belt_plate_belt_17.png","atk":"","matk":"","ind":0,"pdef":"2040~1860","mdef":"","str":23,"intel":23,"vit":25,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +500%　MP regen speed +26%　inventory limit +3000%","skills":[],"explain":["MP为70%以上时， 技能冷却时间将缩短10%。"],"set":""},{"id":100240062,"name":"霸域英豪腰带","level":85,"slot":"belt","armor":"plate","wg":"","type":"板甲腰带","icon":"/assets/icons/sprite_item_new_equipment_06_plate_belt_plate_belt_18.png","atk":"","matk":"","ind":0,"pdef":"2040~1860","mdef":"","str":173,"intel":173,"vit":173,"spr":150,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["被攻击时， 使自身进入霸体状态5秒。 (冷却时间5秒)","霸体状态下受到的伤害 -30%","(解除装备后效果消失)"],"set":""},{"id":100250109,"name":"逝魔之风速短靴","level":85,"slot":"shoes","armor":"cloth","wg":"","type":"布甲鞋","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_shoes_cloth_shoes_17.png","atk":"","matk":"","ind":0,"pdef":"612~558","mdef":"","str":0,"intel":28,"vit":0,"spr":28,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%","skills":[],"explain":["前冲时， 可以消耗1%的MP， 使自身增加10%的移动速度、 25%的施放速度， 以及20点所有属性强化， 效果持续60秒。"],"set":""},{"id":100250110,"name":"闲云碎步短靴","level":85,"slot":"shoes","armor":"cloth","wg":"","type":"布甲鞋","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_shoes_cloth_shoes_18.png","atk":"","matk":"","ind":0,"pdef":"612~558","mdef":"","str":0,"intel":68,"vit":0,"spr":28,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　所有属性强化 +25%","skills":[],"explain":["装备时， 可以使300px范围内的所有敌人生成移动速度减少25%的光环。","装备时， 可以使300px范围内的所有敌人生成攻击速度减少25%的光环"],"set":""},{"id":100260110,"name":"黄泉之风战靴","level":85,"slot":"shoes","armor":"leather","wg":"","type":"皮甲鞋","icon":"/assets/icons/sprite_item_new_equipment_03_leather_shoes_leather_shoes_17.png","atk":"","matk":"","ind":0,"pdef":"1224~1116","mdef":"","str":53,"intel":53,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +7%","skills":[],"explain":["施放技能时， 有5%的几率使自身进入伪装状态5秒。","背击攻击时， 可以增加15%的攻击速度和8点所有属性强化， 效果持续10秒。","破招攻击时， 可以增加15%的移动速度和8点所有属性强化， 效果持续10秒。"],"set":""},{"id":100260111,"name":"战术之王的御敌长靴","level":85,"slot":"shoes","armor":"leather","wg":"","type":"皮甲鞋","icon":"/assets/icons/sprite_item_new_equipment_03_leather_shoes_leather_shoes_18.png","atk":"","matk":"","ind":0,"pdef":"1224~1116","mdef":"","str":53,"intel":53,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +4%　硬直 +1%　stuck resistance +1%","skills":[],"explain":["装备时， 可以使300px范围内的队员增加120点力量。","装备时， 可以使300px范围内的队员增加120点智力。"],"set":""},{"id":100270134,"name":"天御风行战靴","level":85,"slot":"shoes","armor":"light","wg":"","type":"轻甲鞋","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_shoes_larmor_shoes_17.png","atk":"59~59","matk":"59~59","ind":67,"pdef":"1836~1674","mdef":"","str":28,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　施放速度 +12%　移动速度 +12%　物理暴击 +3%　魔法暴击 +3%　所有属性强化 +12%","skills":[],"explain":["攻击时， 有5%的几率生成飓风。 (冷却时间0.5秒)","攻击时， 有5%的几率生成飓风攻击400px范围内的所有敌人。 (冷却时间15秒)"],"set":""},{"id":100270135,"name":"最佳球手的逆袭跑鞋","level":85,"slot":"shoes","armor":"light","wg":"","type":"轻甲鞋","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_shoes_larmor_shoes_18.png","atk":"","matk":"","ind":0,"pdef":"1836~1674","mdef":"","str":28,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%","skills":[],"explain":["施放[受身蹲伏]时， 使自身进入霸体状态， 效果持续5秒。","前冲状态时， 施放霸体护甲并增加移动速度。","Y轴移动速度 +20%"],"set":""},{"id":100280110,"name":"誓血之盟战靴","level":85,"slot":"shoes","armor":"heavy","wg":"","type":"重甲鞋","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_shoes_harmor_shoes_17.png","atk":"80~80","matk":"80~80","ind":100,"pdef":"2448~2232","mdef":"","str":25,"intel":18,"vit":23,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +7%　移动速度 +9%　所有属性强化 +12%","skills":[],"explain":["保持站立或行走状态时， 每10秒使自身减少1%的HP。"],"set":""},{"id":100280111,"name":"千蛛碎影之利齿战靴","level":85,"slot":"shoes","armor":"heavy","wg":"","type":"重甲鞋","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_shoes_harmor_shoes_18.png","atk":"","matk":"","ind":0,"pdef":"2448~2232","mdef":"","str":125,"intel":118,"vit":23,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%","skills":[],"explain":["攻击时有10%的几率使敌人进入出血状态。","攻击出血状态的敌人时， 敌人的防御力减少， 效果持续10秒。","地下城中：出血伤害 +20%"],"set":""},{"id":100290064,"name":"魔战无双短靴","level":85,"slot":"shoes","armor":"plate","wg":"","type":"板甲鞋","icon":"/assets/icons/sprite_item_new_equipment_06_plate_shoes_plate_shoes_17.png","atk":"","matk":"","ind":0,"pdef":"3060~2790","mdef":"","str":103,"intel":103,"vit":25,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　最大MP +200%　物理暴击 +5%　魔法暴击 +5%","skills":[],"explain":["连击数达到20次时， 增加4%的物理、 魔法和独立攻击力， 效果持续30秒。"],"set":""},{"id":100290065,"name":"霸域英豪战靴","level":85,"slot":"shoes","armor":"plate","wg":"","type":"板甲鞋","icon":"/assets/icons/sprite_item_new_equipment_06_plate_shoes_plate_shoes_18.png","atk":"","matk":"","ind":0,"pdef":"3060~2790","mdef":"","str":23,"intel":23,"vit":25,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +2%　施放速度 +3%　移动速度 +6%　物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["前冲、 跳跃状态时， 可以进入霸体状态， 效果持续5秒。","该装备的霸体状态时， 增加30%的所有速度。"],"set":""},{"id":100300212,"name":"贪食之影","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_172.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":9,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 附加9%的伤害。"],"set":""},{"id":100300213,"name":"源助力 - 克洛","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_171.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["荒古遗尘武器技能攻击力 +15%。"],"set":""},{"id":100300221,"name":"无尽贪食之影","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_170.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":25,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 附加25%的伤害。"],"set":""},{"id":100310527,"name":"被囚者的染血手铐","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_96.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":300,"intel":300,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +30%　魔法暴击 +30%","skills":[],"explain":["每存在1个束缚状态的敌人， 可增加自身10%的物理暴击率和魔法暴击率。(最多增加30%)","攻击时， 有5%的几率投掷罗网(冷却3秒)","被攻击时， 可使500px范围内的所有敌人进入束缚状态5秒(冷却30秒，若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)"],"set":""},{"id":100310528,"name":"冰雪公主的霜语手镯","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_97.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":37,"intel":0,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性攻击 +18%","skills":[],"explain":["攻击时， 赋予武器冰属性， 效果持续20秒。","被攻击时， 使500px范围内的所有敌人进入冰冻状态。"],"set":""},{"id":100310532,"name":"精炼的毁伤魔石手环","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_101.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":96,"intel":55,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["技能攻击力 +7%"],"set":""},{"id":100310606,"name":"焚天祭手环","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_98.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":87,"intel":50,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":18,"affix":"火属性攻击 +10%　物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["攻击时，伤害 +18%","(以上伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)","攻击时， 有5%的几率使被击敌人周围200px范围内的敌人进入束缚状态4秒。(冷却10秒)","攻击时， 有5%的几率使被击敌人周围250px范围内的敌人进入灼烧状态4秒(冷却5秒)；灼伤状态下的敌人，每0.5秒受到2500点伤害。","(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)"],"set":""},{"id":100310785,"name":"刀锋女王的铁血项链","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_104.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":0,"incDmg":20,"affix":"MP regen speed +1%　物理暴击 +2%　魔法暴击 +2%","skills":[],"explain":["装备后， 每20秒使自身进入出血状态， 效果持续20秒。出血状态下，每0.5秒受到20点伤害。(若自身高于Lv86，则减少进入异常的几率和效果，反之则增加几率和效果。装备10秒后生效)","攻击时伤害 +20%(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":100310786,"name":"冰雪公主的霜语项链","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_105.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":0,"incDmg":0,"affix":"MP regen speed +1%　水属性攻击 +25%","skills":[],"explain":["施放时， 有5%的几率使周围250px范围内的所有敌人进入冰冻状态2秒,冷却5秒。","装备时， 会对周围300px范围内的所有敌人产生冰冻光环。"],"set":""},{"id":100310790,"name":"精炼的混沌魔石项链","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_109.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":0,"incDmg":20,"affix":"","skills":[],"explain":["HP低于50%时， 会使自身进入混乱状态， 效果持续30秒。","增加20%的攻击伤害。"],"set":""},{"id":100310870,"name":"执刑者的刺杀项链","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_106.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"8160~7440","str":0,"intel":37,"vit":0,"spr":93,"elem":"","addDmg":0,"incDmg":65,"affix":"攻击速度 +5%　施放速度 +5%　物理暴击 +7%　魔法暴击 +7%","skills":[],"explain":["攻击HP为70%以上的敌人时， 增加15%的伤害。","攻击HP为20%以上70%以下的敌人时， 增加20%的伤害。","攻击HP为20%以下的敌人时， 增加30%的伤害。","(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":100312095,"name":"贪食之力","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_167.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":37,"intel":0,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":15,"affix":"物理暴击 +5%　魔法暴击 +5%","skills":[],"explain":["攻击伤害 +15%"],"set":""},{"id":100312096,"name":"源助力 - 玛特伽","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_166.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":37,"intel":0,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["荒古遗尘武器技能攻击力 +15%"],"set":""},{"id":100312103,"name":"无尽贪食之力","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_165.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4896~4464","str":37,"intel":0,"vit":93,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["攻击伤害 +30%"],"set":""},{"id":100320591,"name":"冰雪公主的霜语戒指","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_144.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性攻击 +25%","skills":[],"explain":["攻击时， 有2%的几率使被命中敌人250px范围内的所有敌人进入冰冻状态， 效果持续2秒。"],"set":""},{"id":100320595,"name":"精炼的遗忘魔石戒指","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_148.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["施放技能时， 有15%的几率重置自身技能的冷却时间； 但只能随机重置一个已进入冷却时间的技能。","施放技能时， 有2%的几率重置自身使用过的所有技能的冷却时间。"],"set":""},{"id":100320697,"name":"暗杀者的锋芒戒指","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_145.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +7%　魔法暴击 +7%","skills":[],"explain":["攻击HP为70%以上的敌人时， 暴击伤害增加12%。","攻击HP为20%以上70%以下的敌人时， 暴击伤害增加20%。","攻击HP为20%以下的敌人时， 暴击伤害增加30%。","(暴击伤害加成效果取最高值，且无法叠加)"],"set":""},{"id":100321954,"name":"贪食之殇","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_217.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +5%　魔法暴击 +5%","skills":[],"explain":["暴击伤害 +15%"],"set":""},{"id":100321955,"name":"源助力 - 内尔贝","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_216.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["荒古遗尘武器技能攻击力 +15%"],"set":""},{"id":100321962,"name":"无尽贪食之殇","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_215.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3264~2976","str":56,"intel":56,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["暴击伤害 +30%"],"set":""},{"id":100350657,"name":"空城泪 - 旧王愁","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_124.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":112,"intel":112,"vit":112,"spr":112,"elem":"","addDmg":18,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 附加18%的伤害。"],"set":""},{"id":100352106,"name":"贪食之源","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_169.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":55,"intel":55,"vit":55,"spr":55,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +40%","skills":[],"explain":[],"set":""},{"id":100352107,"name":"源助力 - 艾格尼丝","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_168.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":110,"intel":110,"vit":110,"spr":110,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["荒古遗尘武器技能攻击力 +20%"],"set":""},{"id":100352113,"name":"无尽贪食之源","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_167.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":55,"intel":55,"vit":55,"spr":55,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +65%","skills":[],"explain":[],"set":""},{"id":100352114,"name":"贪食之主","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_169.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":135,"intel":135,"vit":135,"spr":135,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100352115,"name":"无尽贪食之主","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_167.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":220,"intel":220,"vit":220,"spr":220,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100352814,"name":"杰克爆弹的记忆","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_209.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":57,"intel":57,"vit":57,"spr":57,"elem":"","addDmg":0,"incDmg":0,"affix":"火属性攻击 +50%　火属性抗性 +20%","skills":[],"explain":[],"set":""},{"id":100352815,"name":"冰霜雪人的记忆","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_210.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":57,"intel":57,"vit":57,"spr":57,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性攻击 +50%　水属性抗性 +20%","skills":[],"explain":[],"set":""},{"id":100352818,"name":"光电鳗的记忆","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_211.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":57,"intel":57,"vit":57,"spr":57,"elem":"","addDmg":0,"incDmg":0,"affix":"光属性攻击 +50%　光属性抗性 +20%","skills":[],"explain":[],"set":""},{"id":100352819,"name":"暗影夜猫的记忆","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_212.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":57,"intel":57,"vit":57,"spr":57,"elem":"","addDmg":0,"incDmg":0,"affix":"暗属性攻击 +50%　暗属性抗性 +20%","skills":[],"explain":[],"set":""},{"id":100352820,"name":"卡巴拉的记忆","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_213.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":57,"intel":57,"vit":57,"spr":57,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +50%　all elemental resistance +20%","skills":[],"explain":[],"set":""},{"id":101000199,"name":"天丛云","level":85,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_107.png","atk":"912~783","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":27,"incDmg":0,"affix":"施放速度 +2%　stuck resistance +5%　魔法暴击 +2%","skills":["[心眼] +3级"],"explain":["攻击时， 附加27%的伤害"],"set":""},{"id":101000200,"name":"阴剑 - 莫邪","level":85,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_108.png","atk":"912~783","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"水属性","addDmg":0,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +2%　水属性攻击 +35%　水属性抗性 +15%","skills":[],"explain":["↑↓+[宠物技能键]时， 发动阴气气息， 持续60秒， 阴气气息 :","- 赋予所有人暗属性和冰属性攻击","- 增加10%魔暴和30点冰强","- 每1点冰属性强化， 使自身增加1点暗属性强化(最多增加70点)","- 暴击伤害 +15%","- 攻击时， 附加5%冰属性伤害"],"set":""},{"id":101000497,"name":"荒古遗尘短剑","level":85,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_140.png","atk":"912~783","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":101010327,"name":"别云剑 - 无用","level":85,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_119.png","atk":"1177~1104","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":50,"affix":"攻击速度 +3%　施放速度 -2%　硬直 -5%","skills":[],"explain":["攻击速度 +12%","对敌人的伤害 +50%","攻击Miss时， 会有50%的几率减少自身20%的力量和智力， 持续15秒(冷却时间15秒，解除装备后效果不会消失)"],"set":""},{"id":101010328,"name":"阳剑 - 干将","level":85,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_120.png","atk":"1152~989","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"攻击速度 -9%　施放速度 -2%　火属性攻击 +35%　火属性抗性 +15%","skills":[],"explain":["↑↓+[宠物技能键]时， 发动阳气气息， 持续60秒， 阳气气息 :","- 赋予所有人光属性和火属性攻击","- 增加10%物暴和30点火强","- 每1点火属性强化， 使自身增加1点光属性强化(最多增加70点)","- 暴击伤害 +15%","- 攻击时， 附加5%火属性伤害"],"set":""},{"id":101010653,"name":"荒古遗尘太刀","level":85,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_151.png","atk":"912~783","matk":"1008~865","ind":589,"pdef":"","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　施放速度 +4%　硬直 -1%　物理暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":101020256,"name":"三一真神","level":85,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_116.png","atk":"912~783","matk":"1008~865","ind":589,"pdef":"","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":33,"incDmg":0,"affix":"攻击速度 +8%　施放速度 +4%　硬直 -1%　物理暴击 +3%　魔法暴击 +3%","skills":[],"explain":["攻击时， 附加33%伤害","物理、 魔法、 独立攻击力 +3%","攻击时， 有33%几率增加3%的三速、 33点力量、 智力， 持续33秒(冷却3秒， 可叠加2次， 解除装备后效果消失)","施放技能时， 有33%几率消耗1个无色重置一个剩余冷却时间最长的技能","HP为33%以上时， 被击有33%几率向敌人返还33%所受到的伤害(冷却33秒)"],"set":""},{"id":101020258,"name":"名刀 - 观世正宗","level":85,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_118.png","atk":"1003~803","matk":"1109~909","ind":648,"pdef":"","mdef":"","str":72,"intel":107,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　施放速度 +4%　硬直 -1%　物理暴击 +20%　魔法暴击 +20%","skills":["[破极兵刃] +2级"],"explain":["物理背击暴击率 +30%","魔法背击暴击率 +30%","暴击伤害 +32%"],"set":""},{"id":101020259,"name":"御魂 - 七支刀","level":85,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_117.png","atk":"1040~911","matk":"1130~993","ind":717,"pdef":"","mdef":"","str":115,"intel":147,"vit":0,"spr":0,"elem":"","addDmg":18,"incDmg":0,"affix":"攻击速度 +18%　移动速度 +10%　施放速度 +19%　硬直 -1%　物理暴击 +8%　魔法暴击 +8%","skills":[],"explain":["攻击速度 +10%","攻击时， 附加18%伤害","施放技能时， 增加700点力量、 智力， 持续30秒(冷却30秒)","施放技能时， [冥炎之卡洛]、 [不动明王阵]、 [黑暗冥王阵]、 [崩山裂地斩]剩余冷却时间减少30%(冷却10秒)"],"set":""},{"id":101020459,"name":"荒古遗尘骨棒","level":85,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_133.png","atk":"1056~906","matk":"912~783","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":101030212,"name":"米斯特汀","level":85,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_103.png","atk":"1056~906","matk":"912~783","ind":589,"pdef":"","mdef":"","str":152,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":22,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%　暗属性攻击 +45%　暗属性抗性 +35%","skills":[],"explain":["攻击时， 附加22%的伤害","攻击时， 有2%几率使敌人眩晕3秒"],"set":""},{"id":101030215,"name":"梁月的钝剑","level":85,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_134.png","atk":"1056~906","matk":"912~783","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%","skills":[],"explain":["攻击时， 附加30%的伤害","全部Lv85~85  技能 Lv+1 (图内生效)","装备时， 增加15%攻击、 移动速度"],"set":""},{"id":101030517,"name":"荒古遗尘巨剑","level":85,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_149.png","atk":"1152~989","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -9%　施放速度 -2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":101040146,"name":"雷剑 - 苦轮","level":85,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_96.png","atk":"893~766","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":15,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["攻击时， 附加15%光属性伤害","↑↓+[宠物技能键]时， 对敌人发动雷电效果， 持续60秒， 雷电效果 :","- 攻击时， 有5%几率对500范围内敌人发动闪电(冷却5秒)","- 施放技能时， 有10%几率对400范围内所有敌人发动闪电(冷却15秒)","- 被击时， 对800px范围内所有敌人发动闪电(冷却30秒)"],"set":""},{"id":101040148,"name":"巴鲁姆克之剑","level":85,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_97.png","atk":"893~766","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　最大HP +500%","skills":["[破极兵刃] +2级"],"explain":["攻击时，有概率附加60%伤害；技能冷却时间 -10%；携带技能越多，触发概率越低。"],"set":""},{"id":101040332,"name":"荒古遗尘光剑","level":85,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_125.png","atk":"893~766","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":102000135,"name":"千鸟 - 雷切","level":85,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_119.png","atk":"1003~903","matk":"1214~1114","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":20,"affix":"攻击速度 +10%　施放速度 +2%　光属性攻击 +45%","skills":["[螺旋念气场] +3级","[念兽 : 龙虎啸] +3级","[念兽 : 猛虎震地] +3级","[螺旋念气场] +3级","[念兽 : 龙虎啸] +3级","[念兽 : 雷龙出海] +3级"],"explain":["对敌人的伤害 +20%(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)","[念兽 : 龙虎啸]攻击速度 +15%","[念兽 : 龙虎啸]大小 +15%","[螺旋念气场]多段攻击速度 +25%","施放念兽技能后， 在技能持续期间，攻击时有20%的几率落下闪电攻击敌人。"],"set":""},{"id":102000136,"name":"拳风传奇","level":85,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_120.png","atk":"1003~903","matk":"1214~1114","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +15%　施放速度 +10%　最大HP +500%","skills":[],"explain":["攻击速度 +5%","攻击时， 增加6%的物理攻击力， 魔法攻击力和独立攻击力， 同时减少6%的防御力， 效果持续60秒。(效果可叠加，但增加或减少的上限为60%，冷却1秒)"],"set":""},{"id":102000327,"name":"荒古遗尘手套","level":85,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_148.png","atk":"912~783","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":102010190,"name":"疾虎之力","level":85,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_104.png","atk":"1267~1167","matk":"950~850","ind":648,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":20,"affix":"攻击速度 -8%　硬直 +1%　物理暴击 +10%","skills":[],"explain":["暴击伤害 +20%(暴击伤害加成效果取最高值，且无法叠加)","攻击时， 使自身增加20%的物理攻击力和20%的独立攻击力， 效果持续30秒。(冷却30秒，无法叠加，解除装备后效果消失)","施放技能时， 使自身增加50%的攻击速度， 效果持续30秒。(冷却30秒，无法叠加，解除装备后效果消失)"],"set":""},{"id":102010191,"name":"未完成的研发者臂铠","level":85,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_103.png","atk":"1267~1167","matk":"950~850","ind":648,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":25,"incDmg":0,"affix":"攻击速度 -8%　硬直 +1%","skills":["[铁山靠] +2级","[蹲伏] +2级","[擒月炎] +2级","[碎骨] +2级","[后踢] +2级","[下段踢] +2级","[钢筋铁骨] +2级","[分身] +2级","[膝击] +2级","[连环抓取] +2级","[雷霆膝击] +2级","[念气波] +2级","[抛沙] +2级","[伏虎霸王拳] +2级","[狮子吼] +2级","[螺旋念气场] +2级","[鹰踏] +2级","[浮空凌云踢] +2级","[冲膝] +2级","[霸体护甲] +2级","[强制 - 念气波] +2级","[摔技强化] +2级","[飞燕旋风] +2级","[强袭重击] +2级","[光之亲和] +2级","[光之兵刃] +2级","[风之气息] +2级","[烈日光辉] +2级","[强拳] +2级","[毒瓶投掷] +2级","[弱点感知] +2级","[念气环绕] +2级","[烈焰焚步] +2级","[念气罩] +2级","[双重投掷] +2级","[挑衅] +2级","[爪精通] +2级","[前踢] +2级","[抛投] +2级","[暴力抓取] +2级","[滑行抓取] +2级","[罗网投掷] +2级","[野蛮冲撞] +2级","[抓轰炮] +2级","[散打轻甲专精] +2级","[柔道家轻甲专精] +2级","[旋风腿] +2级","[砖块投掷] +2级","[强制 - 投掷] +2级","[空绞锤] +2级","[死亡旋律] +2级","[烈焰燃烧] +2级","[念兽 : 审判之金雷虎] +2级","[闪电之舞] +2级","[幻影爆碎] +2级","[街霸重甲专精] +2级","[狂 · 霸王拳] +2级","[毒针投掷] +2级","[毒雷引爆] +2级","[血色风暴] +2级","[蓄念炮] +2级","[念兽 : 龙虎啸] +2级","[肘击] +2级","[折颈] +2级","[瞬影连环踢] +2级","[炽焰旋风腿] +2级","[疾风追击] +2级","[疾风连击] +2级","[金刚碎] +2级","[霹雳旋踢] +2级","[裂石破天] +2级","[地狱风火轮] +2级","[念兽 : 猛虎震地] +2级","[柔化肌肉] +2级","[气功师布甲专精] +2级","[天崩地裂] +2级","[螺旋滑铲] +2级","[瞬步] +2级","[投掷强化] +2级","[自动填充] +2级","[念气环绕 : 袭 ] +2级","[念气环绕 : 御] +2级","[念之奥义] +2级","[力之奥义] +2级","[千手奥义] +2级","[念之战矛] +2级","[彗星冲击] +2级","[冲云念气场] +2级","[武莲华] +2级","[旋风碎心踢] +2级","[千丝乱舞] +2级","[霹雳三重踢] +2级","[后跳] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[附魔] +2级","[制作召唤人偶] +2级","[炼金术] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[命中精通] +2级","[回避精通] +2级","[HP恢复精通] +2级","[MP恢复精通] +2级","[奔雷螺旋击] +2级","[月辉念气破] +2级","[月华万象] +2级","[烈火强踢] +2级","[烈火强拳] +2级","[极武霸皇踢] +2级","[暗街夺命锁] +2级","[飞沙走石] +2级","[诡诈之道] +2级","[黑震旋风] +2级","[疾风闪电] +2级","[一字传承 : 极义震天破] +2级","[傲天之怒] +2级","[诡诈之道] +2级","[风雷引] +2级","[风雷啸] +2级","[念皇之证] +2级","[极武皇之证] +2级","[暗街之王之证] +2级","[宗师之证] +2级","[极武皇 · 奥义] +2级","[暗街之王 · 奥义] +2级","[铁山靠] +2级","[蹲伏] +2级","[擒月炎] +2级","[碎骨] +2级","[上勾拳] +2级","[下段踢] +2级","[钢筋铁骨] +2级","[分身] +2级","[背摔] +2级","[背摔强化] +2级","[雷霆背摔] +2级","[念气波] +2级","[抛沙] +2级","[伏虎霸王拳] +2级","[狮子吼] +2级","[螺旋念气场] +2级","[鹰踏] +2级","[螺旋彗星落] +2级","[寸拳] +2级","[霸体护甲] +2级","[强制 - 念气波] +2级","[摔技强化] +2级","[光之亲和] +2级","[光之兵刃] +2级","[风之气息] +2级","[烈日光辉] +2级","[强拳] +2级","[涂毒] +2级","[弱点感知] +2级","[念气环绕] +2级","[念气分解] +2级","[念气罩] +2级","[双重投掷] +2级","[挑衅] +2级","[爪精通] +2级","[前踢] +2级","[抛投] +2级","[暴力抓取] +2级","[滑行抓取] +2级","[投网] +2级","[野蛮冲撞] +2级","[抓轰炮] +2级","[武斗轻甲专精] +2级","[柔道家家轻甲专精] +2级","[旋风腿] +2级","[砖袭] +2级","[空绞锤] +2级","[末日风暴] +2级","[死亡毒雾] +2级","[猛毒之血] +2级","[抓取奥义] +2级","[千莲怒放] +2级","[闪电之舞] +2级","[幻影爆碎] +2级","[武神步] +2级","[武神强踢] +2级","[乱舞 · 千叶花] +2级","[街霸重甲专精] +2级","[狂 · 霸王拳] +2级","[毒影针] +2级","[毒雷引爆] +2级","[街头风暴] +2级","[蓄念炮] +2级","[念兽 : 龙虎啸] +2级","[崩拳] +2级","[折颈] +2级","[纷影连环踢] +2级","[升龙拳] +2级","[疾风追击] +2级","[ 疾风连击] +2级","[金刚碎] +2级","[霹雳肘击] +2级","[裂石破天] +2级","[地狱摇篮] +2级","[念兽 : 雷龙出海] +2级","[柔化肌肉] +2级","[斗气师布甲专精] +2级","[究极念气罩] +2级","[猛毒擒月炎] +2级","[狂狮怒吼] +2级","[空绞连锤] +2级","[破碎拳] +2级","[升龙霸拳] +2级","[爆碎砖裂] +2级","[死亡摇篮] +2级","[裂地飞沙] +2级","[极手奥义] +2级","[猛毒之伤] +2级","[后跳] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[魔法赋予] +2级","[制作召唤人偶] +2级","[炼金术] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[奔雷掌] +2级","[奇袭幻影] +2级","[聚能念气炮] +2级","[念帝旋天破] +2级","[回天连环击] +2级","[虎啸神拳] +2级","[无影脚] +2级","[极尽 : 霸皇断空拳] +2级","[连环毒爆弹] +2级","[毒龙轰天雷] +2级","[万毒噬心诀] +2级","[禁技 : 万毒蛇窟] +2级","[末日摇篮] +2级","[风暴之舞] +2级","[苍宇彗星落] +2级","[随机应变] +2级","[心之念意] +2级","[神武之力] +2级","[随机应变] +2级","[格斗专精] +2级","[无情抓取] +2级","[唤醒] +2级","[念帝之证] +2级","[极武圣之证] +2级","[毒神绝之证] +2级","[风暴女皇之证] +2级"],"explain":["攻击时附加25%的伤害。"],"set":""},{"id":102010193,"name":"生死轮盘 - 玩命","level":85,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_105.png","atk":"1322~1222","matk":"950~850","ind":701,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +1%","skills":[],"explain":["攻击时， 有66%的几率增加66%的伤害。(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)","自身HP高于20%时，输入↑↓+[宠物技能键]时，可随机发动以下特殊效果中的任意一种，效果持续20秒(冷却20秒)","- 胜利：自身防御力变为2倍，攻击时附加35%的伤害。","- 失败：自身防御力变为0，同时减少20%的HP，攻击时附加20%的伤害。","(解除装备后效果消失)"],"set":""},{"id":102010392,"name":"荒古遗尘臂铠","level":85,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_135.png","atk":"1152~989","matk":"864~742","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":102020126,"name":"双子物语","level":85,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_109.png","atk":"1056~956","matk":"1056~956","ind":648,"pdef":"","mdef":"","str":72,"intel":35,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%","skills":["[挑衅] +2级，范围+20%","[千手奥义] +2级","[挑衅] +2级，范围+20%","[猛毒之血] +2级"],"explain":["[挑衅]效果范围 +20%","攻击异常状态下的敌人时， 附加30%的伤害。","攻击时， 使敌人减少5点所有异常状态抗性， 效果持续20秒。 (可叠加5次；冷却时间1秒)","攻击异常状态的敌人时，有20%的几率使敌人进入石化、混乱、冰冻、失明、减速和诅咒状态中的一种。","- 使敌人进入石化状态7秒，解除石化时造成24000点伤害。","- 使敌人进入混乱和冰冻状态7秒。","- 使敌人进入失明状态7秒，减少90%的视野和10%的命中率。","- 使敌人进入减速状态7秒，减少20%的移动速度和10%的攻击速度。","- 使敌人进入诅咒状态7秒，减少75点力量、智力、体力和精神。"],"set":""},{"id":102020127,"name":"天魔之爪 - 怒风","level":85,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_110.png","atk":"960~824","matk":"960~824","ind":589,"pdef":"","mdef":"","str":215,"intel":185,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%","skills":["[爪精通] +1级","[爪精通] +1级"],"explain":["攻击时， 使敌人减少10%的攻击速度， 并使自身增加相应的攻击速度， 效果持续30秒。","攻击时， 使敌人减少5%的移动速度， 并使自身增加相应的移动速度， 效果持续30秒。","攻击时， 使敌人减少20点力量和智力， 并使自身增加相应的力量和智力， 效果持续60秒。","对500px范围内的所有敌人发动光环， 可以减少敌人50点异常状态抗性。","攻击恶魔族敌人时， 附加30%的伤害。","地下城中：出血伤害 +35%，中毒伤害 +35%，灼伤伤害 +35%"],"set":""},{"id":102020300,"name":"荒古遗尘利爪","level":85,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_137.png","atk":"960~824","matk":"960~824","ind":589,"pdef":"","mdef":"","str":65,"intel":32,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":102030152,"name":"无轩之黄金东方棍","level":85,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_102.png","atk":"1003~903","matk":"1056~956","ind":648,"pdef":"1001~901","mdef":"","str":72,"intel":107,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"攻击速度 +5%　硬直 +2%　stuck resistance +3%　所有属性强化 +25%","skills":[],"explain":["攻击时， 附加20%的伤害。","↑↓+[宠物技能键]可使队员进入无敌状态2秒， 但需消耗10个无色小晶体。(冷却时间50秒)","施放技能时， 有40%的几率使包括自身在的队员增加12%的物理攻击力、魔法攻击力和独立攻击力， 效果持续40秒。(冷却10秒，解除装备后效果消失)"],"set":""},{"id":102030153,"name":"聚金雕翎","level":85,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_103.png","atk":"912~783","matk":"960~824","ind":589,"pdef":"910~910","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　移动速度 +10%　硬直 +2%　stuck resistance +3%　jump power +50%","skills":["[裂石破天] 冷却-30%","[跃翔] 冷却-10%","[裂石破天] 冷却-30%，范围+40%","[跃翔] 冷却-10%"],"explain":["在高于150px的位置施放[裂石破天]时， 冲击波范围增加40%。","[裂石破天]落下速度 +50%","[裂石破天]攻击力 +30%","[跃翔]冷却时间 -10%","在空中普通攻击时， 附加45%的伤害， 效果持续60秒。"],"set":""},{"id":102030331,"name":"荒古遗尘拳套","level":85,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_122.png","atk":"1008~865","matk":"912~783","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":102040097,"name":"卑劣肾击者","level":85,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_93.png","atk":"1109~1009","matk":"1003~903","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　物理暴击 +15%","skills":["[弱点感知] +1级","[弱点感知] +1级"],"explain":["物理背击暴击率 +30%","暴击伤害 +30%","背击攻击时， 暴击伤害增加50%。","(暴击伤害加成效果取最高值，且无法叠加)","攻击时， 有2%的几率使敌人进入眩晕状态2秒。(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)"],"set":""},{"id":102040099,"name":"神隐者","level":85,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_95.png","atk":"1109~1009","matk":"1003~903","ind":648,"pdef":"","mdef":"","str":182,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"移动速度 +3%　暗属性攻击 +30%","skills":[],"explain":["攻击速度 +3%","装备后， 每30秒会使自身进入伪装状态。(装备后立即生效)","- 伪装效果 -","攻击时， 会增加30%的伤害， 12%的攻击速度和移动速度，持续3秒(冷却3秒)","攻击时， 有2%的几率使敌人进入眩晕状态2秒。(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)","(解除装备后效果消失)"],"set":""},{"id":102040100,"name":"小霸王 - 其乐无穷","level":85,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_94.png","atk":"1109~1009","matk":"1003~903","ind":648,"pdef":"","mdef":"","str":227,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":15,"incDmg":0,"affix":"攻击速度 +15%　光属性攻击 +35%　物理暴击 +10%","skills":["[烈焰焚步] +3级","[武神强踢] +3级"],"explain":["攻击速度 +5%","攻击时， 附加15%的光属性伤害。","施放特定技能时， 会发动强力的闪电爆炸。","- 女散打 - [寸拳]、[闪电之舞]、[破碎拳]、[铁山靠]、[碎骨]","- 男散打 - [闪电之舞]、[瞬影连环踢]、[霹雳三重踢]、[铁山靠]、[碎骨]","攻击时， 有2%的几率使敌人进入眩晕状态2秒。(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)"],"set":""},{"id":102040364,"name":"荒古遗尘东方棍","level":85,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_133.png","atk":"912~783","matk":"960~824","ind":589,"pdef":"910~910","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　硬直 +2%　stuck resistance +3%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":104000153,"name":"弹幕之雨","level":85,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_99.png","atk":"988~888","matk":"831~731","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":10,"incDmg":0,"affix":"物理暴击 +7%　魔法暴击 +5%　光属性攻击 +39%","skills":["[银弹] +5级","[强化 - 银弹] +1级","[银弹] +5级","[强化 - 银弹] +1级"],"explain":["[银弹]子弹数变为无限。","攻击时，附加10%的光属性伤害。"],"set":""},{"id":104000154,"name":"漫游之王","level":85,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_100.png","atk":"988~888","matk":"831~731","ind":648,"pdef":"","mdef":"","str":60,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":45,"affix":"最大HP +500%　物理暴击 +12%　魔法暴击 +10%","skills":[],"explain":["攻击时增加45%的伤害。(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":104000341,"name":"荒古遗尘左轮枪","level":85,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_128.png","atk":"957~749","matk":"805~630","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":104010135,"name":"战神之怒","level":85,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_106.png","atk":"692~592","matk":"1015~915","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 -1%","skills":["[机械改良] +4级","[空投支援] 攻击力+30%","[G-1科罗纳] 攻击力+25%","[改装 : G-2旋雷者] 攻击力+25%","[改装 : G-3捕食者] 攻击力+25%","[机械改良] +4级","[空投支援] 攻击力+30%"],"explain":["[空投支援]攻击力 +30%","物理攻击力 +25%","魔法攻击力 +25%","独立攻击力 +25%","神枪手(女)","[改装 : G-1科罗纳]攻击力 +25%","[改装 : G-2旋雷者]攻击力 +25%","[改装 : G-3捕食者]攻击力 +25%"],"set":""},{"id":104010138,"name":"全面开战 - 总攻","level":85,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_107.png","atk":"692~592","matk":"1015~915","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 -1%　火属性攻击 +35%　光属性攻击 +35%","skills":["[RX-78追击者] +3级","[Ez-8自爆者] +3级","[Ex-S毒蛇炮] +3级","[机械引爆] +3级","[空投支援] 追击者个数 +10","[空战机械 : 狂风] +3级","[拦截机工厂] 持续+10秒","[RX-78追击者] +3级","[Ez-8自爆者] +3级","[Ex-S毒蛇炮] +3级","[机械引爆] +3级","[空投支援] 追击者个数 +10","[空战机械 : 风暴] +3级","[拦截机工厂] 持续+10秒"],"explain":["[空投支援]追击者个数 +10","[拦截机工厂]持续时间 +10秒","施放[机械引爆]时霸体。","施放[G-1科罗纳]时霸体。","施放技能时，有10%的几率增加24点光属性和火属性强化，以及16%的攻击力，效果持续60秒。(解除装备后效果消失)"],"set":""},{"id":104010322,"name":"荒古遗尘自动手枪","level":85,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_137.png","atk":"671~525","matk":"984~770","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 -1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":104020145,"name":"最高指挥官战弩","level":85,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_98.png","atk":"831~731","matk":"923~823","ind":648,"pdef":"","mdef":"","str":237,"intel":200,"vit":0,"spr":0,"elem":"","addDmg":22,"incDmg":0,"affix":"攻击速度 +2%　硬直 +1%　物理暴击 +3%","skills":["[冰冻弹] +5级","[银弹] +5级","[弹药改良] +2级","[步枪精通] +5级","[冰冻弹] +5级","[银弹] +5级","[弹药改良] +2级","[步枪精通] +5级"],"explain":["攻击时， 附加22%的伤害。","装备时， 增加6%的物理、 魔法和独立攻击力。"],"set":""},{"id":104020146,"name":"冰火之莲","level":85,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_121.png","atk":"831~731","matk":"923~823","ind":648,"pdef":"","mdef":"","str":73,"intel":35,"vit":0,"spr":0,"elem":"水属性","addDmg":30,"incDmg":0,"affix":"攻击速度 +12%　硬直 +1%　物理暴击 +3%　水属性攻击 +40%　火属性攻击 +40%","skills":[],"explain":["攻击速度 +10%","装备时，赋予武器火属性","↑↓+[宠物技能键]时，发动灼伤、冰冻buff，效果持续60秒(冷却60秒，解除装备后效果消失)","- 攻击时，有5%的几率使敌人进入冰冻状态2秒。","- 攻击时， 有5%的几率使敌人进入灼伤状态3秒，灼伤状态下敌人每0.5秒受到1000点伤害","(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)","冰属性攻击时， 附加15%的伤害。","火属性攻击时， 附加15%的伤害。"],"set":""},{"id":104020323,"name":"荒古遗尘步枪","level":85,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_132.png","atk":"1028~805","matk":"894~700","ind":589,"pdef":"","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":104030143,"name":"神秘代号 608","level":85,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_103.png","atk":"1028~805","matk":"894~700","ind":589,"pdef":"","mdef":"","str":65,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":15,"affix":"","skills":["[闪击地雷] +5级，攻击力+30%，范围+30%","[M-61地雷] +2级，攻击力+30%，范围+30%","[闪击地雷] +5级，攻击力+30%，范围+30%","[M-61地雷] +2级，攻击力+30%，范围+30%"],"explain":["[闪击地雷]攻击力 +30%","[闪击地雷]范围 +30%","[M-61地雷]攻击力 +30%","[M-61地雷]范围 +30%","攻击伤害 +15%","攻击时， 附加20%的伤害。"],"set":""},{"id":104030145,"name":"拇指规则 MBA","level":85,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_104.png","atk":"1062~962","matk":"923~823","ind":648,"pdef":"","mdef":"","str":209,"intel":244,"vit":0,"spr":0,"elem":"","addDmg":28,"incDmg":0,"affix":"攻击速度 +5%　物理暴击 +10%　魔法暴击 +10%","skills":["[光子爆弹] +4级","[尼尔狙击] +4级","[M-61地雷] +4级","[聚合弹] +4级","[地狱烈炎] +4级","[尼尔狙击] +4级","[M-61地雷] +4级","[聚合弹] +4级"],"explain":["攻击速度 +5%","攻击时，附加28%的伤害。"],"set":""},{"id":104030327,"name":"荒古遗尘手炮","level":85,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_132.png","atk":"1118~875","matk":"671~525","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":104040154,"name":"无轩之黄金手炮","level":85,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_102.png","atk":"1154~1054","matk":"692~592","ind":648,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"所有属性强化 +30%","skills":[],"explain":["↑↓+[宠物技能键]时，可使队员进入无敌状态2秒， 但需消耗10个无色小晶体。(冷却50秒)","施放技能时， 有40%的几率使包括自身在的队员增加12%的物理攻击力、魔法攻击力和独立攻击力， 效果持续40秒。(冷却40秒)","(解除装备后效果消失)","攻击时，附加20%的伤害。"],"set":""},{"id":104040156,"name":"激光狂热者","level":85,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_103.png","atk":"1154~1054","matk":"692~592","ind":648,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":12,"incDmg":0,"affix":"光属性攻击 +35%","skills":["[激光炮] +5级，范围+22%","[蓄电激光炮] +2级，充电时间上限 -40%，充电时间上限 +30%","[远古粒子炮] +2级，冷却-20%","[激光炮] +5级，范围+22%","[蓄电激光炮] +2级，充电时间上限 -40%，充电时间上限 +30%","[卫星射线] +2级，冷却-20%"],"explain":["[卫星射线]冷却时间 -20%","[远古粒子炮]冷却时间 -20%","[激光炮]厚度 +60%","[激光炮]射程 +22%","[蓄电激光炮]充电时间上限 -0.4秒","[蓄电激光炮]攻击力增加率 +30%","攻击时， 附加12%的光属性伤害。"],"set":""},{"id":104040343,"name":"荒古遗尘手弩","level":85,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_129.png","atk":"805~630","matk":"894~700","ind":589,"pdef":"","mdef":"","str":65,"intel":32,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +2%　硬直 +1%　物理暴击 +3%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":106000090,"name":"未完成的研发者之矛","level":85,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_117.png","atk":"1267~1167","matk":"898~798","ind":648,"pdef":"","mdef":"","str":107,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":25,"incDmg":0,"affix":"攻击速度 -5%　硬直 +1%　物理暴击 +2%","skills":["[魔法旋风] +2级","[雷光链] +2级","[冰晶坠] +2级","[暗域扩张] +2级","[属性变换] +2级","[地炎] +2级","[冰霜之径] +2级","[冰魄剑] +2级","[幽冥火] +2级","[破冰飞刃] +2级","[旋炎破] +2级","[冰魄锤击] +2级","[冰雪风暴] +2级","[冰晶之浴] +2级","[旋冰穿刺] +2级","[冰魄之弓] +2级","[擒拿掌] +2级","[魔法炮] +2级","[元素环绕] +2级","[瞬移] +2级","[寒冰连枪] +2级","[发现] +2级","[冰魄旋枪] +2级","[黑暗禁域] +2级","[魔球连射] +2级","[魔法冰球] +2级","[旋火盾] +2级","[魔力燃烧] +2级","[雷光屏障] +2级","[元素轰炸] +2级","[寒冰之境] +2级","[极冰绽放] +2级","[不死之身] +2级","[属性保护] +2级","[冰之印] +2级","[元素爆破师布甲专精] +2级","[冰结师皮甲专精] +2级","[千旋冰轮破] +2级","[幻魔四重奏] +2级","[冰封奥义] +2级","[元素唤醒] +2级","[冰凌破] +2级","[元素浓缩球] +2级","[元素幻灭] +2级","[千里冰封] +2级","[扫把掌握] +2级","[后跳] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[制作召唤人偶] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[元素禁域] +2级","[聚能魔炮] +2级","[末日湮灭] +2级","[碎冰破] +2级","[极冰领域] +2级","[冰之技艺] +2级","[湮灭之瞳之证] +2级","[刹那永恒之证] +2级","[刹那永恒 · 奥义] +2级","[龙花霸] +2级","[魔法秀] +2级","[替身草人] +2级","[龙牙] +2级","[炫纹 : 无属性] +2级","[炫纹 : 火属性] +2级","[炫纹 : 冰属性] +2级","[炫纹 : 暗属性] +2级","[炫纹 : 光属性] +2级","[炫纹强压] +2级","[魔法星弹] +2级","[天击] +2级","[碎霸] +2级","[落花掌] +2级","[杰克爆弹] +2级","[冰霜雪人] +2级","[光电鳗] +2级","[暗影夜猫] +2级","[魔法记忆] +2级","[鞭挞] +2级","[精灵召唤 : 亚德炎] +2级","[精灵召唤 : 冰奈斯] +2级","[精灵召唤 : 瑟冥特克] +2级","[精灵召唤 : 雷沃斯] +2级","[契约召唤 : 赫德尔] +2级","[虚无之球] +2级","[杰克降临] +2级","[驱散魔法] +2级","[元素点燃] +2级","[召唤兽跟随] +2级","[雷旋] +2级","[元素奥义] +2级","[魔道学助手] +2级","[矛精通] +2级","[棍棒精通] +2级","[魔法护盾] +2级","[移动施法] +2级","[炫纹发射] +2级","[自动炫纹] +2级","[远古魔法书] +2级","[空中施放  : 杰克爆弹] +2级","[挑衅人偶 : 舒露露] +2级","[契约召唤 :黑骑士 桑德尔] +2级","[契约召唤：魔界花袄索] +2级","[契约召唤 :露易丝姐姐 ] +2级","[精灵召唤：精灵王伊伽贝拉] +2级","[召唤兽强化] +2级","[精灵献祭] +2级","[魔力印记] +2级","[献祭攻击 : 亚德炎] +2级","[献祭攻击 : 冰奈斯] +2级","[献祭攻击 : 瑟冥特克] +2级","[献祭攻击 : 雷沃斯] +2级","[天雷] +2级","[冰墙] +2级","[烈焰冲击] +2级","[黑洞] +2级","[极冰盛宴] +2级","[魔法护盾强化] +2级","[火系精通] +2级","[冰系精通] +2级","[暗系精通] +2级","[光系精通] +2级","[圆舞棍] +2级","[流星闪影击] +2级","[魔斗士皮甲专精] +2级","[强袭流星打] +2级","[煌龙偃月刀] +2级","[元素集中] +2级","[属性轰炸] +2级","[灵魂支配] +2级","[精灵召唤 : 亡魂默克尔] +2级","[精灵召唤 : 极光格雷林] +2级","[精灵召唤 : 冰影阿奎利斯] +2级","[精灵召唤 : 火焰赫瑞克] +2级","[契约召唤 : 弗利特] +2级","[召唤兽狂化] +2级","[契约召唤 : 征服者卡西利亚斯] +2级","[变身贝亚娜] +2级","[斗神意志] +2级","[亲和 - 暗影夜猫] +2级","[亲和 - 光电鳗] +2级","[亲和 - 冰霜雪人] +2级","[亲和 - 杰克爆弹] +2级","[冰冻粉] +2级","[剧毒粉] +2级","[扫把掌握] +2级","[暗影斗篷] +2级","[改造舒露露] +2级","[变异苍蝇拍] +2级","[幸运棒棒糖] +2级","[旋转扫把] +2级","[魔道酸雨云] +2级","[改良魔法星弹] +2级","[熔岩药瓶] +2级","[魔道学者皮甲专精] +2级","[反重力装置] +2级","[冰霜钻孔车] +2级","[电鳗碰撞机] +2级","[暴炎加热炉] +2级","[元素师布甲专精] +2级","[召唤师布甲专精] +2级","[技艺融合] +2级","[成功预感] +2级","[光电冰墙] +2级","[流星雷连击] +2级","[虚无火山] +2级","[弹跳旋转扫把] +2级","[超级苍蝇拍] +2级","[召唤兽净化] +2级","[炫纹碎霸] +2级","[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 拉特利亚] +2级","[精灵召唤 : 瑟利斯特] +2级","[精灵召唤 : 希德] +2级","[精灵召唤 : 艾丽西娅] +2级","[炫纹融合] +2级","[强制 - 炫纹融合] +2级","[双重锤击] +2级","[咒令 : 逆月之蚀] +2级","[定时炸弹] +2级","[召唤解除] +2级","[连击精通] +2级","[光电兔] +2级","[雪人刨冰] +2级","[超级棒棒糖] +2级","[乌洛波洛斯之环] +2级","[传说召唤 : 月蚀之影] +2级","[契约召唤 : 牛头王库鲁塔] +2级","[咒令 : 愤怒咆哮] +2级","[精灵召唤 : 融合精灵海伊伦] +2级","[传说召唤 : 逆月者拉莫斯] +2级","[强化 - 下级精灵] +2级","[后跳] +2级","[取消 - 后跳] +2级","[取消 - 投掷] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[魔法赋予] +2级","[制作召唤人偶] +2级","[链金术] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[炫纹簇] +2级","[使徒之舞] +2级","[闪击碎霸] +2级","[使徒化身] +2级","[解除变身] +2级","[星纹陨爆] +2级","[煌龙乱舞] +2级","[元素之幕] +2级","[元素震荡] +2级","[圣灵水晶] +2级","[元素之门] +2级","[第六元素] +2级","[唤醒] +2级","[元素圣灵之证] +2级","[月蚀之证] +2级","[伊斯塔战灵之证] +2级","[古灵精怪之证] +2级","[月蚀 · 奥义] +2级"],"explain":["攻击时附加25%的伤害。"],"set":""},{"id":106000093,"name":"胜利女神之矛","level":85,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_118.png","atk":"1267~1067","matk":"898~698","ind":648,"pdef":"","mdef":"","str":97,"intel":0,"vit":15,"spr":0,"elem":"","addDmg":0,"incDmg":35,"affix":"硬直 +1%　物理暴击 +2%","skills":["[冰雪风暴] 攻击力+15%","[发现] +1级","[极冰绽放] 攻击力+15%","[冰封奥义] +2级","[矛精通] +1级","[变身贝亚娜] 攻击力+30%，冷却+30%，移动速度增加量 +30%，多段攻击次数 +30%","[斗神意志] +2级"],"explain":["攻击速度 +5%","[旋冰穿刺]攻击力 +15%","[冰雪风暴]攻击力 +15%","[变身贝亚娜]攻击力 +30%","攻击时，对敌人的伤害 +35%(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":106000279,"name":"荒古遗尘战矛","level":85,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_148.png","atk":"1152~989","matk":"816~700","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　硬直 +1%　物理暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":106010125,"name":"精灵王之庇护","level":85,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_106.png","atk":"950~750","matk":"1162~962","ind":648,"pdef":"","mdef":"","str":0,"intel":97,"vit":0,"spr":0,"elem":"水属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +5%　硬直 -1%　所有属性强化 +31%","skills":["[冰雪风暴] 攻击力+30%，冷却-10%，风暴数量+2","[精灵召唤：精灵王伊伽贝拉] 冷却-180%，持续-60%，召唤数量上限 +1"],"explain":["召唤高级精灵时，无需牺牲低级精灵。","[精灵召唤:伊伽贝拉]存在时间-60%","[精灵召唤:伊伽贝拉]召唤数量+1","[精灵召唤:伊伽贝拉]攻击冷却时间-30%。","[冰雪风暴]风暴数量+2","[冰雪风暴]攻击力+30%","[冰雪风暴]冷却时间-10%"],"set":""},{"id":106010128,"name":"牧童之谎 - 狼来了","level":85,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_107.png","atk":"950~850","matk":"1162~1062","ind":648,"pdef":"","mdef":"","str":0,"intel":107,"vit":0,"spr":0,"elem":"","addDmg":25,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +5%　硬直 -1%　所有属性强化 +28%","skills":[],"explain":["装备时， 每40秒随机发动以下效果中的一种，效果持续40秒。(消耗2个无色小晶块，装备10秒后生效)","- 真实： 增加20%的魔法暴击率，恢复10%的HP。(对话气泡： 狼真的来了！！！)","- 谎言： 增加10%的魔法暴击率。(对话气泡： 狼来了！)","攻击时，附加25%的伤害。"],"set":""},{"id":106010307,"name":"荒古遗尘长棍","level":85,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_135.png","atk":"1036~890","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　硬直 +1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":106020090,"name":"炫纹大师","level":85,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_106.png","atk":"1140~1040","matk":"950~850","ind":648,"pdef":"","mdef":"","str":72,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　硬直 +1%　所有属性强化 +22%","skills":["[属性变换] +3级","[棍棒精通] +3级"],"explain":["物理攻击力 +30%","魔法攻击力 +30%","独立攻击力 +30%","生成炫纹时， 有100%的几率生成大炫纹。"],"set":""},{"id":106020091,"name":"爱之闪耀魔法少女棒","level":85,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_105.png","atk":"1140~1040","matk":"950~850","ind":648,"pdef":"","mdef":"","str":72,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":18,"incDmg":0,"affix":"攻击速度 +5%　硬直 +1%","skills":["[属性变换] +2级","[幻魔四重奏] +1级","[元素唤醒] +2级","[棍棒精通] +2级","[变身贝亚娜] +1级","[斗神意志] +2级"],"explain":["攻击时， 附加18%的伤害。","攻击时， 使敌人减少25%的防御力，效果持续40秒。(冷却5秒)","装备时，增加5%的攻击速度、移动速度和8%的施放速度。"],"set":""},{"id":106020368,"name":"荒古遗尘魔杖","level":85,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_136.png","atk":"864~742","matk":"1056~906","ind":589,"pdef":"","mdef":"","str":0,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +5%　硬直 -1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":106030126,"name":"智者千虑","level":85,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_116.png","atk":"1003~903","matk":"1267~1167","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":16,"incDmg":0,"affix":"攻击速度 -10%　施放速度 +10%　魔法暴击 +10%　所有属性强化 +29%","skills":["[属性变换] +5级","[魔力燃烧] +3级","[魔法秀] +3级","[远古魔法书] +5级"],"explain":["施放[远古记忆]时，使自身增加20点所有属性强化，效果持续30秒。(解除装备后效果消失)","攻击时， 附加16%的伤害。"],"set":""},{"id":106030128,"name":"贤者之杖","level":85,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_117.png","atk":"1003~903","matk":"1267~1167","ind":648,"pdef":"","mdef":"","str":0,"intel":292,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　最大HP +550%　最大MP +550%　所有属性强化 +26%","skills":["[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级","[远古记忆] +5级"],"explain":["魔法攻击力 +12%","独立攻击力 +12%","智力 +15%","触发[不死之身]技能时，复活时额外恢复20%的HP。"],"set":""},{"id":106030403,"name":"荒古遗尘法杖","level":85,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_147.png","atk":"912~783","matk":"1152~989","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":106040094,"name":"小美人鱼的苍蝇拍","level":85,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_93.png","atk":"1056~856","matk":"1162~962","ind":648,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":28,"affix":"攻击速度 +6%　移动速度 +3%","skills":["[魔法旋风] +2级","[雷光链] +2级","[冰晶坠] +2级","[暗域扩张] +2级","[属性变换] +2级","[地炎] +2级","[冰霜之径] +2级","[冰魄剑] +2级","[幽冥火] +2级","[破冰飞刃] +2级","[旋炎破] +2级","[冰魄锤击] +2级","[冰雪风暴] +2级","[冰晶之浴] +2级","[旋冰穿刺] +2级","[冰魄之弓] +2级","[擒拿掌] +2级","[魔法炮] +2级","[元素环绕] +2级","[瞬移] +2级","[寒冰连枪] +2级","[发现] +2级","[冰魄旋枪] +2级","[黑暗禁域] +2级","[魔球连射] +2级","[魔法冰球] +2级","[旋火盾] +2级","[魔力燃烧] +2级","[雷光屏障] +2级","[元素轰炸] +2级","[寒冰之境] +2级","[极冰绽放] +2级","[不死之身] +2级","[属性保护] +2级","[冰之印] +2级","[元素爆破师布甲专精] +2级","[冰结师皮甲专精] +2级","[千旋冰轮破] +2级","[幻魔四重奏] +2级","[冰封奥义] +2级","[元素唤醒] +2级","[冰凌破] +2级","[元素浓缩球] +2级","[元素幻灭] +2级","[千里冰封] +2级","[扫把掌握] +2级","[后跳] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[制作召唤人偶] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[湮灭之瞳之证] +2级","[刹那永恒之证] +2级","[龙花霸] +2级","[魔法秀] +2级","[替身草人] +2级","[龙牙] +2级","[炫纹 : 无属性] +2级","[炫纹 : 火属性] +2级","[炫纹 : 冰属性] +2级","[炫纹 : 暗属性] +2级","[炫纹 : 光属性] +2级","[炫纹强压] +2级","[魔法星弹] +2级","[天击] +2级","[碎霸] +2级","[落花掌] +2级","[杰克爆弹] +2级","[冰霜雪人] +2级","[光电鳗] +2级","[暗影夜猫] +2级","[魔法记忆] +2级","[鞭挞] +2级","[精灵召唤 : 亚德炎] +2级","[精灵召唤 : 冰奈斯] +2级","[精灵召唤 : 瑟冥特克] +2级","[精灵召唤 : 雷沃斯] +2级","[契约召唤 : 赫德尔] +2级","[虚无之球] +2级","[杰克降临] +2级","[驱散魔法] +2级","[元素点燃] +2级","[召唤兽跟随] +2级","[雷旋] +2级","[元素奥义] +2级","[魔道学助手] +2级","[矛精通] +2级","[棍棒精通] +2级","[魔法护盾] +2级","[移动施法] +3级","[炫纹发射] +2级","[自动炫纹] +2级","[远古魔法书] +2级","[空中施放  : 杰克爆弹] +2级","[挑衅人偶 : 舒露露] +2级","[契约召唤 :黑骑士 桑德尔] +2级","[契约召唤：魔界花袄索] +2级","[契约召唤 :露易丝姐姐 ] +2级","[精灵召唤：精灵王伊伽贝拉] +2级","[召唤兽强化] +2级","[精灵献祭] +2级","[魔力印记] +2级","[献祭攻击 : 亚德炎] +2级","[献祭攻击 : 冰奈斯] +2级","[献祭攻击 : 瑟冥特克] +2级","[献祭攻击 : 雷沃斯] +2级","[天雷] +2级","[冰墙] +2级","[烈焰冲击] +2级","[黑洞] +2级","[极冰盛宴] +2级","[魔法护盾强化] +2级","[火系精通] +2级","[冰系精通] +2级","[暗系精通] +2级","[光系精通] +2级","[圆舞棍] +2级","[流星闪影击] +2级","[魔斗士皮甲专精] +2级","[强袭流星打] +2级","[煌龙偃月刀] +2级","[元素集中] +2级","[属性轰炸] +2级","[灵魂支配] +2级","[精灵召唤 : 亡魂默克尔] +2级","[精灵召唤 : 极光格雷林] +2级","[精灵召唤 : 冰影阿奎利斯] +2级","[精灵召唤 : 火焰赫瑞克] +2级","[契约召唤 : 弗利特] +2级","[召唤兽狂化] +2级","[契约召唤 : 征服者卡西利亚斯] +2级","[变身贝亚娜] +2级","[斗神意志] +2级","[亲和 - 暗影夜猫] +2级","[亲和 - 光电鳗] +2级","[亲和 - 冰霜雪人] +2级","[亲和 - 杰克爆弹] +2级","[冰冻粉] +2级","[剧毒粉] +2级","[扫把掌握] +2级","[暗影斗篷] +2级","[改造舒露露] +2级","[变异苍蝇拍] +2级","[幸运棒棒糖] +3级","[旋转扫把] +2级","[魔道酸雨云] +2级","[改良魔法星弹] +2级","[熔岩药瓶] +2级","[魔道学者皮甲专精] +2级","[反重力装置] +2级","[冰霜钻孔车] +2级","[电鳗碰撞机] +2级","[暴炎加热炉] +2级","[元素师布甲专精] +2级","[召唤师布甲专精] +2级","[技艺融合] +2级","[成功预感] +2级","[光电冰墙] +2级","[流星雷连击] +2级","[虚无火山] +2级","[弹跳旋转扫把] +2级","[超级苍蝇拍] +2级","[召唤兽净化] +2级","[炫纹碎霸] +2级","[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 拉特利亚] +2级","[精灵召唤 : 瑟利斯特] +2级","[精灵召唤 : 希德] +2级","[精灵召唤 : 艾丽西娅] +2级","[炫纹融合] +2级","[强制 - 炫纹融合] +2级","[双重锤击] +2级","[咒令 : 逆月之蚀] +2级","[定时炸弹] +2级","[召唤解除] +2级","[连击精通] +2级","[光电兔] +2级","[雪人刨冰] +2级","[超级棒棒糖] +2级","[乌洛波洛斯之环] +2级","[传说召唤 : 月蚀之影] +2级","[契约召唤 : 牛头王库鲁塔] +2级","[咒令 : 愤怒咆哮] +2级","[精灵召唤 : 融合精灵海伊伦] +2级","[传说召唤 : 逆月者拉莫斯] +2级","[强化 - 下级精灵] +2级","[后跳] +2级","[取消 - 后跳] +2级","[取消 - 投掷] +2级","[轻甲精通] +2级","[重甲精通] +2级","[基础精通] +2级","[跃翔] +2级","[远古记忆] +2级","[投掷精通] +2级","[物理背击] +2级","[物品分解] +2级","[不屈意志] +2级","[精工] +2级","[纺织] +2级","[机械] +2级","[炼金] +2级","[皮甲精通] +2级","[物理暴击] +2级","[布甲精通] +2级","[魔法暴击] +2级","[魔法背击] +2级","[受身蹲伏] +2级","[魔法赋予] +2级","[制作召唤人偶] +2级","[链金术] +2级","[开启分解商店] +2级","[板甲精通] +2级","[攻击类型转换] +2级","[公会 : 增加角色属性] +2级","[极速成长] +2级","[炫纹簇] +2级","[使徒之舞] +2级","[闪击碎霸] +2级","[使徒化身] +2级","[解除变身] +2级","[星纹陨爆] +2级","[煌龙乱舞] +2级","[元素之幕] +2级","[元素震荡] +2级","[圣灵水晶] +2级","[元素之门] +2级","[第六元素] +2级","[唤醒] +2级","[元素圣灵之证] +2级","[月蚀之证] +2级","[伊斯塔战灵之证] +2级","[古灵精怪之证] +2级","[月蚀 · 奥义] +2级"],"explain":["施放[变异苍蝇拍]、[超级苍蝇拍]时，每次均大成功","对敌人的伤害 +28%(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":106040095,"name":"浣熊吸尘器","level":85,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_92.png","atk":"960~824","matk":"1056~906","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":28,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%　所有属性强化 +22%","skills":["[技艺融合] 攻击力+20%，范围+30%"],"explain":["[反重力装置]扩大率 +30%","[技艺融合]吸附敌人范围 +30%","[技艺融合]攻击力 +20%","攻击时， 附加28%的伤害。"],"set":""},{"id":106040096,"name":"雪落千寒","level":85,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_95.png","atk":"1056~956","matk":"1162~1062","ind":648,"pdef":"","mdef":"","str":0,"intel":72,"vit":0,"spr":0,"elem":"水属性","addDmg":20,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%　魔法暴击 +12%　水属性攻击 +40%　水属性抗性 +18%","skills":["[亲和 - 冰霜雪人] +5级","[冰霜钻孔车] 攻击力+100%，冷却-25秒，持续+8秒"],"explain":["[冰霜钻孔车]100%大成功","[冰霜钻孔车]吸附力 +40%","[冰霜钻孔车]持续时间 +8秒","[冰霜钻孔车]冷却时间 -25秒","[冰霜钻孔车]攻击力 +100%","装备时， 可使500px范围内的敌人冰属性抗性降低10点。","攻击时， 附加20%伤害。"],"set":""},{"id":106040097,"name":"异魔封神扫把","level":85,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_94.png","atk":"960~824","matk":"1056~906","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%　最大MP +1500%","skills":[],"explain":["每300点MP增加3点智力。 (最多增加210点)","每400点MP增加4点魔法攻击力。 (最多增加280点)","每500点MP增加5点独立攻击力。 (最多增加350点)","攻击时， 附加20%的伤害。"],"set":""},{"id":106040284,"name":"荒古遗尘扫把","level":85,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_123.png","atk":"960~824","matk":"1056~906","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":108000102,"name":"神之天佑","level":85,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_96.png","atk":"1000~900","matk":"1000~900","ind":600,"pdef":"1000~900","mdef":"1000~900","str":0,"intel":80,"vit":80,"spr":80,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +2%　移动速度 +2%","skills":["[武器祝福] +5级","[荣誉祝福] +5级","[天使祝福] +5级"],"explain":["HP为50%以下时， 增加313点体力。","MP为50%以下时， 增加313点精神。","施放技能时， 有10%的几率对自身施放Lv8的[圣光守护]。","施放技能时， 有10%的几率对500px范围内，包括自身在以及队员施放Lv13的[圣光守护]。"],"set":""},{"id":108000104,"name":"被诅咒的十字架 - 图卢瓦","level":85,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_97.png","atk":"1056~956","matk":"1003~903","ind":648,"pdef":"1001~901","mdef":"1001~901","str":0,"intel":72,"vit":85,"spr":85,"elem":"暗属性","addDmg":40,"incDmg":0,"affix":"施放速度 +2%","skills":["[荣誉祝福] +4级","[天启之珠] +1级"],"explain":["攻击时， 附加40%伤害。","攻击时，有5%的几率使敌人进入诅咒状态10秒。","↑↓+[宠物技能键]时，消耗自身10%的HP，生成光环。(冷却5秒)","- 使500px范围内的敌人减少30点诅咒抗性。","- 使500px范围内的敌人进入诅咒状态10秒。","诅咒状态下的敌人将减少100点力量、智力、体力、精神。(若敌人高于Lv92，则减少进入异常的几率和效果，反之则增加几率和效果)"],"set":""},{"id":108000315,"name":"荒古遗尘十字架","level":85,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_126.png","atk":"960~824","matk":"912~783","ind":589,"pdef":"910~910","mdef":"910~910","str":0,"intel":65,"vit":77,"spr":77,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +2%","skills":["[圣光十字] 范围+30%"],"explain":["[武器祝福]物理攻击力 +20","[天使祝福]魔法攻击力 +10","[天使祝福]智力增加量 +20","[荣誉祝福]力量和智力增加量 +20","[天堂谐音]HP上限增加量 +10%","[圣光十字]Buff范围 +30%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":108010089,"name":"无轩之黄金念珠","level":85,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_90.png","atk":"950~850","matk":"1214~1114","ind":648,"pdef":"","mdef":"","str":0,"intel":107,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +8%　魔法暴击 +2%　所有属性强化 +30%","skills":[],"explain":["攻击时， 附加20%的伤害。","↑↓+[宠物技能键]可使队员进入无敌状态2秒， 但需消耗10个无色小晶体。(冷却时间50秒)","施放技能时， 有40%的几率使包括自身在的队员增加12%的物理攻击力、魔法攻击力和独立攻击力， 效果持续40秒。(冷却10秒，解除装备后效果消失)"],"set":""},{"id":108010091,"name":"大智度论","level":85,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_91.png","atk":"950~850","matk":"1214~1114","ind":648,"pdef":"","mdef":"","str":0,"intel":107,"vit":0,"spr":0,"elem":"","addDmg":28,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +5%　魔法暴击 +2%","skills":["[脉轮 : 烈焰] +3级","[脉轮 : 曜日] +3级","[巨兵精通] +3级"],"explain":["攻击时，附加28%的伤害。","施放技能时，有20%几率使自身进入霸体状态2秒， 冷却5秒。","施放技能时， 有10%的几率使自身增加10%的智力， 效果持续20秒，冷却10秒。"],"set":""},{"id":108010285,"name":"荒古遗尘念珠","level":85,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_119.png","atk":"864~742","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":97,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +5%　魔法暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":108020084,"name":"星云幻","level":85,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_103.png","atk":"1100~1000","matk":"900~800","ind":600,"pdef":"","mdef":"","str":110,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"硬直 +1%　暗属性攻击 +30%","skills":["[俯冲腹拳] 攻击力+25%","[神圣组合拳] 攻击力+30%"],"explain":["施放普通技能时， 会出现台词。","[圣拳锤击]冲击波范围 +25%","[破碎之锤]冲击波范围 +25%","[俯冲腹拳]攻击力 +25%","[神圣组合拳]攻击力 +30%","装备时， 增加30%的攻击力。"],"set":""},{"id":108020086,"name":"风涌雷煞图腾","level":85,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_104.png","atk":"1008~865","matk":"864~742","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":12,"incDmg":0,"affix":"攻击速度 +5%　移动速度 +10%　硬直 +1%　光属性攻击 +35%","skills":["[极速飓风拳] 范围+40%，移动速度 +35%","[仲裁怒击] 攻击力+20%"],"explain":["攻击速度 +5%","[泯灭神击]攻击时， 对500px范围内的随机敌人发动落雷攻击。 (最多发动5个)","[极速飓风拳]吸附范围 +20%","[极速飓风拳]吸附力 +20%","[极速飓风拳]每秒攻击次数达到上限时， 攻击速度比率 +20%","[极速飓风拳]每秒攻击次数达到上限时， 移动速度 +35%","[仲裁怒击]攻击力 +20%","攻击时， 附加12%的光属性伤害。"],"set":""},{"id":108020261,"name":"荒古遗尘图腾","level":85,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_134.png","atk":"1008~865","matk":"864~742","ind":589,"pdef":"","mdef":"","str":97,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +1%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":108030082,"name":"禁灭之槌","level":85,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_99.png","atk":"1152~989","matk":"816~700","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +2%","skills":[],"explain":["攻击时， 可以增加5点力量， 并使敌人减少2%的物理和魔法防御力， 效果持续50秒。"],"set":""},{"id":108030084,"name":"巨神之父","level":85,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_100.png","atk":"1267~1167","matk":"898~798","ind":648,"pdef":"","mdef":"","str":237,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":10,"incDmg":0,"affix":"攻击速度 -3%　硬直 +2%　物理暴击 +10%","skills":["[脉轮 : 烈焰] +3级","[巨兵精通] +2级"],"explain":["攻击速度 +5%","暴击伤害 +25%(暴击伤害加成效果取最高值，且无法叠加)","攻击时， 附加10%的伤害。"],"set":""},{"id":108030320,"name":"荒古遗尘战镰","level":85,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_127.png","atk":"912~783","matk":"960~824","ind":589,"pdef":"","mdef":"","str":65,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　硬直 -1%　物理暴击 +2%　魔法暴击 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":108040107,"name":"死亡宣告 - 契约之镰","level":85,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_98.png","atk":"912~783","matk":"960~824","ind":589,"pdef":"","mdef":"","str":65,"intel":65,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　硬直 -1%　物理暴击 +2%　魔法暴击 +10%　暗属性攻击 +35%","skills":[],"explain":["攻击时， 有2%的几率使敌人减少20%的HP，冷却时间20秒。","装备时， 角色会生成死亡光环对敌人进行死亡宣告。","攻击被附加骷髅标记的敌人时， 附加30%的伤害。"],"set":""},{"id":108040108,"name":"黑暗禁咒","level":85,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_97.png","atk":"1003~903","matk":"1056~956","ind":648,"pdef":"","mdef":"","str":72,"intel":72,"vit":0,"spr":0,"elem":"","addDmg":10,"incDmg":0,"affix":"攻击速度 +8%　硬直 -1%　物理暴击 +2%　魔法暴击 +9%","skills":["[黑暗之触] 攻击力+30%，范围+25%","[魔化 : 末日审判者] +2级","[恶魔诅咒] +2级","[堕落之魂] +3级"],"explain":["[黑暗之触]攻击力 +30%","[黑暗之触]撕裂攻击范围 +25%","装备后， 可以使500px范围内所有敌人的暗属性抗性减少22点。","攻击时， 附加10%暗属性伤害。"],"set":""},{"id":108040275,"name":"荒古遗尘战斧","level":85,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_129.png","atk":"1152~989","matk":"816~700","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +2%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":109000104,"name":"银魂","level":85,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_122.png","atk":"952~852","matk":"950~850","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":20,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%　光属性攻击 +35%","skills":["[终结追击] +2级","[月弧] +3级","[月轮舞] +2级，终结追击时剩余的连击点数 +1"],"explain":["[月轮舞]终结追击时剩余的连击点数 +1","释放[月轮舞]时， 使自身增加15%的攻击速度、 15%的移动速度，效果持续40秒。(解除装备后消失)","攻击时，附加20%的伤害。"],"set":""},{"id":109000106,"name":"耀光女王的银妆刀","level":85,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_123.png","atk":"952~852","matk":"950~850","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":45,"affix":"攻击速度 +10%　硬直 -1%　最大HP +500%　物理暴击 +10%","skills":["[终结追击] +2级","[匕首精通] +2级"],"explain":["攻击时增加45%的伤害。(该伤害加成效果按部位覆盖顺序原理取值，单件内取最高，且无法叠加)"],"set":""},{"id":109000262,"name":"荒古遗尘匕首","level":85,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_151.png","atk":"903~721","matk":"864~742","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":109010095,"name":"螺旋丸","level":85,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_117.png","atk":"1043~836","matk":"768~659","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　物理暴击 +5%","skills":["[双剑精通] +3级","[陨落螺旋刺] 冷却-30%，范围+80%"],"explain":["[陨落螺旋刺]冷却时间 -30%","[陨落螺旋刺]范围 +40%","装备时， 增加30%的技能攻击力。"],"set":""},{"id":109010096,"name":"末世双剑","level":85,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_116.png","atk":"1077~977","matk":"845~745","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"水属性","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　物理暴击 +5%　水属性攻击 +24%","skills":[],"explain":["[终结追击]每个连击点数攻击力增加比率 +50%"],"set":""},{"id":109010097,"name":"逆天命 - 无归","level":85,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_118.png","atk":"1077~977","matk":"845~745","ind":648,"pdef":"","mdef":"","str":72,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　物理暴击 +5%","skills":["[双剑精通] +2级"],"explain":["自身HP为60%以上， 攻击时附加20%的伤害。","自身HP为20%以上60%以下时， 攻击时附加30%的伤害。","自身HP为20%以下时， 攻击时附加40%的伤害。","暴击伤害 +15%(暴击伤害加成效果取最高值，且无法叠加)"],"set":""},{"id":109010251,"name":"荒古遗尘双剑","level":85,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_146.png","atk":"1043~836","matk":"768~659","ind":589,"pdef":"","mdef":"","str":65,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　物理暴击 +5%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":109020086,"name":"黑暗绝魂之杖","level":85,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_122.png","atk":"838~665","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　魔法暴击 +5%","skills":["[降临 : 暴君巴拉克] +2级，攻击力+30%","[巴拉克的愤怒] 攻击力+30%，冷却-10%","[降临 : 僵尸莱迪娅] 冷却-10%"],"explain":["[降临 : 暴君巴拉克]攻击力 +30%","[巴拉克的野心]攻击力 +30%","[巴拉克的野心]冷却时间 -10%","[巴拉克的愤怒]攻击力 +30%","[巴拉克的愤怒]冷却时间 -10%","攻击时， 附加28%的伤害。"],"set":""},{"id":109020087,"name":"蛛王权杖","level":85,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_121.png","atk":"838~665","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　魔法暴击 +5%　暗属性攻击 +30%","skills":["[暗影蛛丝阵] 持续+3秒，范围+30%","[吸魂暗劲波] 攻击力+40%，冷却-20%","[释魂暗劲波] 攻击力+40%，冷却-20%"],"explain":["[暗影蛛丝阵]持续时间 +3秒","[暗影蛛丝阵]范围 +30%","[吸魂暗劲波]攻击力 +40%","[吸魂暗劲波]冷却时间 -20%","[释魂暗劲波]攻击力 +40%","[释魂暗劲波]冷却时间 -20%","攻击时， 附加20%的伤害。"],"set":""},{"id":109030148,"name":"荒古遗尘权杖","level":85,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_151.png","atk":"838~665","matk":"1104~948","ind":589,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　魔法暴击 +5%","skills":[],"explain":["技能攻击力 +35%","每次攻击可吸收3点魔能， 最多可达100点。","自身魔能达到100点后，↑↓+[宠物技能键]时， 可释放“第七使徒 : 火焰吞噬者安徒恩”的魔能。","释放结束时， 最后还能对敌人造成魔能爆炸伤害。"],"set":""},{"id":31170,"name":"孤影流觞","level":80,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_88.png","atk":"1013~817","matk":"758~593","ind":628,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +15%","skills":["[上旋踢] +2级","[刺踢] +4级","[快速拔枪] +4级","[音速劫击] +2级","[回旋踢] +2级","[瞬踢] +4级","[快速拔枪] +4级","[浮空劫击] +2级","[花式枪术] +1级"],"explain":["施放[瞬踢]、 [刺踢]时， 使自身增加10%的移动速度， 效果持续2秒。","施放[回旋踢]、 [上旋踢]时， 使自身增加10%的攻击速度， 效果持续2秒。","[瞬踢]、 [刺踢]击退时间增加比率 +20%","施放[瞬踢]、 [刺踢]时， 会产生冲击波。","施放[瞬踢]、 [刺踢]时， 可以使自身进入霸体状态。"],"set":""},{"id":36018,"name":"极刑绝之镰","level":80,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_88.png","atk":"862~735","matk":"907~774","ind":555,"pdef":"","mdef":"","str":62,"intel":62,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　硬直 -2%　物理暴击 +20%　魔法暴击 +20%","skills":[],"explain":["暴击伤害 +22%","攻击时， 有5%的几率使敌人进入出血状态。"],"set":""},{"id":100050050,"name":"幽魂魅影长袍","level":80,"slot":"coat","armor":"cloth","wg":"","type":"布甲上衣","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_coat_cloth_coat_10.png","atk":"","matk":"","ind":0,"pdef":"1164~1056","mdef":"","str":0,"intel":44,"vit":0,"spr":44,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +100%　最大MP +200%　暗属性抗性 +12%","skills":[],"explain":["每10点暗属性抗性增加2点暗属性强化。","每10点暗属性抗性增加5点魔法攻击力和独立攻击力。"],"set":""},{"id":100060016,"name":"游龙之魂战袍","level":80,"slot":"coat","armor":"leather","wg":"","type":"皮甲上衣","icon":"/assets/icons/sprite_item_new_equipment_03_leather_coat_leather_coat_10.png","atk":"","matk":"","ind":0,"pdef":"2328~2112","mdef":"","str":37,"intel":37,"vit":0,"spr":40,"elem":"","addDmg":0,"incDmg":10,"affix":"物理暴击 +3%　魔法暴击 +3%","skills":[],"explain":["背击物理攻击时， 使敌人减少2000点物理防御力， 效果持续10秒。 (最多重叠4次)","背击魔法攻击时， 使敌人减少2000点魔法防御力，效果持续10秒。 (最多重叠4次)","攻击时， 增加10%的伤害。"],"set":""},{"id":100070009,"name":"深海熔岩胸甲","level":80,"slot":"coat","armor":"light","wg":"","type":"轻甲上衣","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_coat_larmor_coat_10.png","atk":"","matk":"","ind":0,"pdef":"3492~3168","mdef":"","str":44,"intel":29,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +350%　水属性抗性 +12%","skills":[],"explain":["火属性强化100以上时， 增加8%的物理、 魔法和独立攻击力。","攻击时， 有3%的几率对300px范围内的敌人随机发动最多3个沸腾之泉。"],"set":""},{"id":100080009,"name":"星云迷踪上衣","level":80,"slot":"coat","armor":"heavy","wg":"","type":"重甲上衣","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_coat_harmor_coat_10.png","atk":"","matk":"","ind":0,"pdef":"4656~4224","mdef":"","str":40,"intel":29,"vit":37,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +4%　魔法暴击 +4%","skills":[],"explain":["攻击时， 有5%的几率使自身进入失明状态。"],"set":""},{"id":100090009,"name":"镇魂曲 : 幽游板甲上衣","level":80,"slot":"coat","armor":"plate","wg":"","type":"板甲上衣","icon":"/assets/icons/sprite_item_new_equipment_06_plate_coat_plate_coat_10.png","atk":"","matk":"","ind":0,"pdef":"5820~528","mdef":"","str":37,"intel":37,"vit":40,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +250%　所有属性强化 +10%","skills":["[正义审判] +2级","[无双击] +2级","[不动明王阵] +2级"],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100100012,"name":"幽魂魅影长裤","level":80,"slot":"pants","armor":"cloth","wg":"","type":"布甲下装","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_pants_cloth_pants_10.png","atk":"","matk":"","ind":0,"pdef":"970~880","mdef":"","str":0,"intel":44,"vit":0,"spr":44,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +100%　最大MP +200%　暗属性抗性 +12%","skills":[],"explain":["每10点暗属性抗性增加2点暗属性强化。","每10点暗属性抗性增加10点智力。"],"set":""},{"id":100110011,"name":"游龙之魂护腿","level":80,"slot":"pants","armor":"leather","wg":"","type":"皮甲下装","icon":"/assets/icons/sprite_item_new_equipment_03_leather_pants_leather_pants_10.png","atk":"","matk":"","ind":0,"pdef":"1940~1760","mdef":"","str":37,"intel":37,"vit":0,"spr":40,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 0%　施放速度 0%　移动速度 0%　硬直 0%　stuck resistance 0%　物理暴击 0%　魔法暴击 0%","skills":[],"explain":["装备后， 使自身增加15%的攻击速度，施放速度，移动速度， 10%的物理暴击率、 魔法暴击率、"],"set":""},{"id":100120009,"name":"深海熔岩护腿","level":80,"slot":"pants","armor":"light","wg":"","type":"轻甲下装","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_pants_larmor_pants_10.png","atk":"","matk":"","ind":0,"pdef":"2910~2640","mdef":"","str":44,"intel":29,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +350%　水属性抗性 +12%","skills":[],"explain":["火属性强化100以上时， 增加8%的物理、 魔法和独立攻击力。","攻击时， 有3%的几率对300px范围内的敌人随机发动最多3个沸腾之泉。"],"set":""},{"id":100130009,"name":"星云迷踪护腿","level":80,"slot":"pants","armor":"heavy","wg":"","type":"重甲下装","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_pants_harmor_pants_10.png","atk":"","matk":"","ind":0,"pdef":"3880~3520","mdef":"","str":40,"intel":29,"vit":37,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +4%　魔法暴击 +4%","skills":[],"explain":["攻击时， 有5%的几率进入失明状态15秒。"],"set":""},{"id":100140009,"name":"镇魂曲 : 幽游板甲护腿","level":80,"slot":"pants","armor":"plate","wg":"","type":"板甲下装","icon":"/assets/icons/sprite_item_new_equipment_06_plate_pants_plate_pants_10.png","atk":"","matk":"","ind":0,"pdef":"4850~4400","mdef":"","str":37,"intel":37,"vit":40,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +250%　所有属性强化 +10%","skills":["[疾空旋风破] +2级","[忏悔之锤] +2级","[邪光波动阵] +2级"],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100150012,"name":"幽魂魅影肩甲","level":80,"slot":"shoulder","armor":"cloth","wg":"","type":"布甲头肩","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_neck_cloth_neck_10.png","atk":"","matk":"","ind":0,"pdef":"776~704","mdef":"","str":0,"intel":35,"vit":0,"spr":35,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +7%　暗属性抗性 +10%","skills":[],"explain":["每12点暗属性抗性增加2点暗属性强化。","每12点暗属性抗性增加1%的攻击速度。","每12点暗属性抗性增加1.5%的施放速度。"],"set":""},{"id":100160011,"name":"游龙之魂肩甲","level":80,"slot":"shoulder","armor":"leather","wg":"","type":"皮甲头肩","icon":"/assets/icons/sprite_item_new_equipment_03_leather_neck_leather_neck_10.png","atk":"","matk":"","ind":0,"pdef":"1552~1408","mdef":"","str":29,"intel":29,"vit":0,"spr":32,"elem":"","addDmg":0,"incDmg":0,"affix":"stuck resistance +5%","skills":[],"explain":["攻击时， 有3%的几率增加10%的物理暴击和魔法暴击， 效果持续30秒。","攻击时， 有3%的几率使自身进入伪装状态， 效果持续20秒。"],"set":""},{"id":100170009,"name":"深海熔岩肩甲","level":80,"slot":"shoulder","armor":"light","wg":"","type":"轻甲头肩","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_neck_larmor_neck_10.png","atk":"","matk":"","ind":0,"pdef":"2328~2112","mdef":"","str":35,"intel":23,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +7%　最大HP +200%　最大MP +200%　物理暴击 +15%　魔法暴击 +15%　水属性抗性 +12%","skills":[],"explain":["攻击时， 有3%的几率对300px范围内的敌人随机生成最多2个沸腾之泉。"],"set":""},{"id":100180009,"name":"星云迷踪护肩","level":80,"slot":"shoulder","armor":"heavy","wg":"","type":"重甲头肩","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_neck_harmor_neck_10.png","atk":"","matk":"","ind":0,"pdef":"3104~2816","mdef":"","str":32,"intel":23,"vit":29,"spr":0,"elem":"","addDmg":0,"incDmg":12,"affix":"攻击速度 +7%　施放速度 +10%　硬直 +5%　最大HP +300%","skills":[],"explain":["攻击时， 增加12%的伤害。"],"set":""},{"id":100190009,"name":"镇魂曲 : 幽游板甲护肩","level":80,"slot":"shoulder","armor":"plate","wg":"","type":"板甲头肩","icon":"/assets/icons/sprite_item_new_equipment_06_plate_neck_plate_neck_10.png","atk":"","matk":"","ind":0,"pdef":"3880~3520","mdef":"","str":29,"intel":29,"vit":32,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +200%　所有属性强化 +8%","skills":["[圣光球] +3级","[狂乱锤击] +3级","[爆炎 · 波动剑] +3级"],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100200013,"name":"幽魂魅影腰带","level":80,"slot":"belt","armor":"cloth","wg":"","type":"布甲腰带","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_belt_cloth_belt_10.png","atk":"","matk":"","ind":0,"pdef":"388~352","mdef":"","str":0,"intel":26,"vit":0,"spr":26,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%　暗属性抗性 +10%","skills":[],"explain":["每12点暗属性抗性增加2点暗属性强化。","每15点暗属性抗性增加1%的魔法暴击率。"],"set":""},{"id":100210012,"name":"游龙之魂腰带","level":80,"slot":"belt","armor":"leather","wg":"","type":"皮甲腰带","icon":"/assets/icons/sprite_item_new_equipment_03_leather_belt_leather_belt_10.png","atk":"","matk":"","ind":0,"pdef":"776~704","mdef":"","str":22,"intel":22,"vit":0,"spr":24,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +5%　inventory limit +3000%","skills":[],"explain":["装备时， 每20秒使自身进入伪装状态， 效果持续20秒。"],"set":""},{"id":100220009,"name":"深海熔岩腰带","level":80,"slot":"belt","armor":"light","wg":"","type":"轻甲腰带","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_belt_larmor_belt_10.png","atk":"","matk":"","ind":0,"pdef":"1164~1056","mdef":"","str":26,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +200%　最大MP +200%　inventory limit +3000%　火属性攻击 +35%　水属性抗性 +12%","skills":[],"explain":["装备时， 使自身的武器附加火属性。","攻击时， 对300px范围内的敌人随机发动沸腾之泉。 (最多发动2个)"],"set":""},{"id":100230009,"name":"星云迷踪腰带","level":80,"slot":"belt","armor":"heavy","wg":"","type":"重甲腰带","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_belt_harmor_belt_10.png","atk":"","matk":"","ind":0,"pdef":"1552~1408","mdef":"","str":24,"intel":18,"vit":22,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["自身处于失明状态时， 增加20%的命中率、 15%的物理暴击率和魔法暴击率。 (解除装备后效果消失)"],"set":""},{"id":100240009,"name":"镇魂曲 : 幽游板甲腰带","level":80,"slot":"belt","armor":"plate","wg":"","type":"板甲腰带","icon":"/assets/icons/sprite_item_new_equipment_06_plate_belt_plate_belt_10.png","atk":"","matk":"","ind":0,"pdef":"1940~1760","mdef":"","str":22,"intel":22,"vit":24,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +200%　inventory limit +3000%　所有属性强化 +8%","skills":["[圣光沁盾] +3级","[巨旋风] +3级","[冰刃 · 波动剑] +3级"],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100250013,"name":"幽魂魅影短靴","level":80,"slot":"shoes","armor":"cloth","wg":"","type":"布甲鞋","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_shoes_cloth_shoes_10.png","atk":"","matk":"","ind":0,"pdef":"582~528","mdef":"","str":0,"intel":26,"vit":0,"spr":26,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +7%　暗属性抗性 +10%","skills":[],"explain":["每12点暗属性抗性增加2点暗属性强化。","每15点暗属性抗性增加1%的移动速度。"],"set":""},{"id":100260013,"name":"游龙之魂战靴","level":80,"slot":"shoes","armor":"leather","wg":"","type":"皮甲鞋","icon":"/assets/icons/sprite_item_new_equipment_03_leather_shoes_leather_shoes_10.png","atk":"","matk":"","ind":0,"pdef":"1164~1056","mdef":"","str":22,"intel":22,"vit":0,"spr":24,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +7%","skills":[],"explain":["攻击时， 有3%的几率使包括自身在内的所有队员增加20%的攻击速度、 20%移动速度和32.5%的施放速度， 效果持续20秒。 (冷却时间20秒)"],"set":""},{"id":100270009,"name":"深海熔岩战靴","level":80,"slot":"shoes","armor":"light","wg":"","type":"轻甲鞋","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_shoes_larmor_shoes_10.png","atk":"","matk":"","ind":0,"pdef":"1746~1584","mdef":"","str":26,"intel":18,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　stuck resistance +3%　最大HP +200%　最大MP +200%　火属性攻击 +20%　水属性抗性 +12%","skills":[],"explain":["攻击时， 有3%的几率对300px范围内的敌人随机生成最多2个沸腾之泉。"],"set":""},{"id":100280009,"name":"星云迷踪战靴","level":80,"slot":"shoes","armor":"heavy","wg":"","type":"重甲鞋","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_shoes_harmor_shoes_10.png","atk":"","matk":"","ind":0,"pdef":"2328~2112","mdef":"","str":74,"intel":68,"vit":22,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +15%　移动速度 +14%","skills":[],"explain":["攻击时， 有5%的几率使自身进入失明状态15秒。"],"set":""},{"id":100290009,"name":"镇魂曲 : 幽游板甲战靴","level":80,"slot":"shoes","armor":"plate","wg":"","type":"板甲鞋","icon":"/assets/icons/sprite_item_new_equipment_06_plate_shoes_plate_shoes_10.png","atk":"","matk":"","ind":0,"pdef":"2910~2640","mdef":"","str":22,"intel":22,"vit":24,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　所有属性强化 +8%","skills":["[疾风打] +3级","[圣光十字] +3级","[波动爆发] +3级"],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100310007,"name":"风华绝世手镯","level":80,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_72.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4656~4224","str":36,"intel":0,"vit":88,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +10%","skills":[],"explain":["施放技能时， 有10%的几率使自身进入霸体状态12秒。"],"set":""},{"id":100320009,"name":"风华绝世之戒","level":80,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_91.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"3104~2816","str":53,"intel":53,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +10%","skills":[],"explain":["攻击时， 有3%的几率使自身进入霸体状态12秒。"],"set":""},{"id":100340219,"name":"诸神之智 - 剑魂","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 猛龙断空斩] +3级","[强化 - 拔刀斩] +3级","[强化 - 幻影剑舞] +3级"],"explain":[],"set":""},{"id":100340220,"name":"诸神之智 - 狂战士","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 嗜魂封魔斩] +3级","[强化 - 崩山裂地斩] +3级","[强化 - 血气之刃] +3级"],"explain":[],"set":""},{"id":100340221,"name":"诸神之智 - 鬼泣","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 残影之凯贾] +3级","[强化 - 冰霜之萨亚] +3级","[强化 - 冥炎之卡洛] +3级"],"explain":[],"set":""},{"id":100340222,"name":"诸神之智 - 阿修罗","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 爆炎 · 波动剑] +3级","[强化 - 无双波] +3级","[强化 - 不动明王阵] +3级"],"explain":[],"set":""},{"id":100340223,"name":"诸神之智 - 气功师 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 螺旋念气场] +3级","[强化 - 狮子吼] +3级","[强化 - 念兽 : 雷龙出海] +3级"],"explain":[],"set":""},{"id":100340224,"name":"诸神之智 - 散打 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 寸拳] +3级","[强化 - 闪电之舞] +3级","[强化 - 纷影连环踢] +3级"],"explain":[],"set":""},{"id":100340225,"name":"诸神之智 - 街霸 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 天罗地网] +3级","[强化 - 街头风暴] +3级","[强化 - 裂地飞沙] +3级"],"explain":[],"set":""},{"id":100340226,"name":"诸神之智 - 柔道家 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 螺旋彗星落] +3级","[强化 - 地狱摇篮] +3级","[强化 - 裂石破天] +3级"],"explain":[],"set":""},{"id":100340227,"name":"诸神之智 - 气功师 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 螺旋念气场] +3级","[强化 - 狮子吼] +3级","[强化 - 念兽 : 猛虎震地] +3级"],"explain":[],"set":""},{"id":100340228,"name":"诸神之智 - 散打 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 瞬影连环踢] +3级","[强化 - 闪电之舞] +3级","[强化 - 冲膝] +3级"],"explain":[],"set":""},{"id":100340229,"name":"诸神之智 - 街霸 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 罗网投掷] +3级","[强化 - 毒雷引爆] +3级","[强化 - 血色风暴] +3级"],"explain":[],"set":""},{"id":100340230,"name":"诸神之智 - 柔道家 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 地狱风火轮] +3级","[强化 - 浮空凌云踢] +3级","[强化 - 裂石破天] +3级"],"explain":[],"set":""},{"id":100340231,"name":"诸神之智 - 漫游枪手 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 致命射击] +3级","[强化 - 乱射] +3级","[强化 - 多重射击] +3级"],"explain":[],"set":""},{"id":100340232,"name":"诸神之智 - 枪炮师 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - FM-92刺弹炮] +3级","[强化 - X-1压缩量子炮] +3级","[强化 - 量子爆弹] +3级"],"explain":[],"set":""},{"id":100340233,"name":"诸神之智 - 机械师 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 拦截机工厂] +3级","[强化 - 空战机械 : 风暴] +3级","[强化 - 空投支援] +3级"],"explain":[],"set":""},{"id":100340234,"name":"诸神之智 - 弹药专家 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 地狱烈炎] +3级","[强化 - C4远程炸弹] +3级","[强化 - 尼尔狙击] +3级"],"explain":[],"set":""},{"id":100340235,"name":"诸神之智 - 漫游枪手 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 致命射击] +3级","[强化 - 枪舞] +3级","[强化 - 多重射击] +3级"],"explain":[],"set":""},{"id":100340236,"name":"诸神之智 - 枪炮师 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - FM-92 mk2榴弹] +3级","[强化 - X-1压缩量子炮] +3级","[强化 - 量子爆弹] +3级"],"explain":[],"set":""},{"id":100340237,"name":"诸神之智 - 机械师 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 拦截机工厂] +3级","[强化 - 空战机械 : 狂风] +3级","[强化 - 空投支援] +3级"],"explain":[],"set":""},{"id":100340238,"name":"诸神之智 - 弹药专家 (女)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 光子爆弹] +3级","[强化 - C4远程炸弹] +3级","[强化 - 尼尔狙击] +3级"],"explain":[],"set":""},{"id":100340239,"name":"诸神之智 - 元素师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 杰克降临] +3级","[强化 - 极冰盛宴] +3级","[强化 - 雷旋] +3级","[强化 - 湮灭黑洞] +3级"],"explain":[],"set":""},{"id":100340240,"name":"诸神之智 - 召唤师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 契约召唤 : 路易丝] +3级","[强化 - 精灵召唤 : 伊伽贝拉] +3级","[强化 - 契约召唤 : 袄索] +3级"],"explain":[],"set":""},{"id":100340241,"name":"诸神之智 - 战斗法师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 强袭流星打] +3级","[强化 - 炫纹强压] +3级","[强化 - 煌龙偃月] +3级"],"explain":[],"set":""},{"id":100340242,"name":"诸神之智 - 魔道学者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 反重力装置] +3级","[强化 - 冰霜钻孔车] +3级","[强化 - 电鳗碰撞机] +3级","[强化 - 暴炎加热炉] +3级"],"explain":[],"set":""},{"id":100340243,"name":"诸神之智 - 圣骑士 (男)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 忏悔之锤] +3级","[强化 - 圣光球] +3级","[强化 - 正义审判] +3级"],"explain":[],"set":""},{"id":100340244,"name":"诸神之智 - 蓝拳圣使","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 天谴飓风] +3级","[强化 - 神圣组合拳] +3级","[强化 - 极速飓风拳] +3级"],"explain":[],"set":""},{"id":100340245,"name":"诸神之智 - 驱魔师 (物理)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 疾空旋风破] +3级","[强化 - 狂乱锤击] +3级","[强化 - 无双击] +3级"],"explain":[],"set":""},{"id":100340246,"name":"诸神之智 - 驱魔师 (魔法)","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 式神·殇] +3级","[强化 - 式神 : 玄武] +3级","[强化 - 落雷符] +3级"],"explain":[],"set":""},{"id":100340247,"name":"诸神之智 - 复仇者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 恶魔之力] +3级","[强化 - 黑暗之触] +3级","[强化 - 黑暗权能] +3级"],"explain":[],"set":""},{"id":100340248,"name":"诸神之智 - 刺客","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 绝命瞬狱杀] +3级","[强化 - 螺旋穿刺] +3级","[强化 - 雷光刃影] +3级"],"explain":[],"set":""},{"id":100340249,"name":"诸神之智 - 死灵术士","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 巴拉克的野心] +3级","[强化 - 吸魂暗劲波] +3级","[强化 - 巴拉克的愤怒] +3级"],"explain":[],"set":""},{"id":100340250,"name":"诸神之智 - 元素爆破师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 旋炎破] +3级","[强化 - 黑暗禁域] +3级","[强化 - 元素轰炸] +3级"],"explain":[],"set":""},{"id":100340251,"name":"诸神之智 - 冰结师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[强化 - 冰魄锤击] +3级","[强化 - 冰雪风暴] +3级","[强化 - 极冰绽放] +3级"],"explain":[],"set":""},{"id":100340252,"name":"真神的庇护 - 剑圣","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[极 · 鬼剑术 (暴风式)] +3级","[极 · 鬼剑术 (斩铁式)] +4级","[破空拔刀斩] +3级","[破军斩龙击] +3级"],"explain":[],"set":""},{"id":100340253,"name":"真神的庇护 - 狱血魔神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[魔狱血刹] +3级","[鲜血之忆] +4级","[血气爆发] +3级","[灭魂之手] +3级"],"explain":[],"set":""},{"id":100340254,"name":"真神的庇护 - 弑魂","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[第7鬼神 : 邪神之怖拉修] +3级","[恐惧光环] +4级","[墓碑三绝阵] +3级","[冰晶之萨亚] +3级"],"explain":[],"set":""},{"id":100340255,"name":"真神的庇护 - 大暗黑天","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[暗天波动眼] +3级","[心眼] +4级","[极炎 · 裂波剑] +3级","[极冰 · 裂波剑] +3级"],"explain":[],"set":""},{"id":100340256,"name":"真神的庇护 - 百花缭乱","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[千莲怒放] +3级","[乱舞 · 千叶花] +4级","[究极念气罩] +3级","[狂狮怒吼] +3级"],"explain":[],"set":""},{"id":100340257,"name":"真神的庇护 - 武神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[武神步] +4级","[武神强踢] +3级","[破碎拳] +3级","[升龙霸拳] +3级"],"explain":[],"set":""},{"id":100340258,"name":"真神的庇护 - 毒王","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[死亡毒雾] +3级","[猛毒之血] +4级","[猛毒擒月炎] +3级","[爆碎砖裂] +3级"],"explain":[],"set":""},{"id":100340259,"name":"真神的庇护 - 暴风眼","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[末日风暴] +3级","[抓取奥义] +4级","[空绞连锤] +3级","[死亡摇篮] +3级"],"explain":[],"set":""},{"id":100340260,"name":"真神的庇护 - 狂虎帝","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[念兽 : 审判之金雷虎] +3级","[念之奥义] +4级","[念之战矛] +3级","[冲云念气场] +3级"],"explain":[],"set":""},{"id":100340261,"name":"真神的庇护 - 武极","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[烈焰焚步] +3级","[烈焰燃烧] +4级","[旋风碎心踢] +3级","[霹雳三重踢] +3级"],"explain":[],"set":""},{"id":100340262,"name":"真神的庇护 - 千手罗汉","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[天崩地裂] +3级","[千手奥义] +4级","[千丝乱舞] +3级"],"explain":[],"set":""},{"id":100340263,"name":"真神的庇护 - 风林火山","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[死亡旋律] +3级","[力之奥义] +4级","[彗星冲击] +3级","[武莲华] +3级"],"explain":[],"set":""},{"id":100340264,"name":"真神的庇护 - 枪神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[疯狂屠戮] +3级","[死亡印记] +4级","[回旋劫击] +3级","[极限多重爆头] +3级"],"explain":[],"set":""},{"id":100340265,"name":"真神的庇护 - 狂暴者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[卫星射线] +3级","[卫星定位] +4级","[寒冰喷射器] +3级","[FM-92 SW刺弹炮] +3级"],"explain":[],"set":""},{"id":100340266,"name":"真神的庇护 - 机械战神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[盖波加之拳] +3级","[斗志之歌] +4级","[Ez-10反击者] +3级","[Ex-S Zero毒蛇炮] +3级"],"explain":[],"set":""},{"id":100340267,"name":"真神的庇护 - 大将军","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[弹药主宰] +4级","[黑玫瑰特种战队] +3级","[C4飞速炸弹] +3级","[M-61地雷] +3级"],"explain":[],"set":""},{"id":100340268,"name":"真神的庇护 - 沾血蔷薇","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[隐匿切割] +4级","[血腥狂欢] +3级","[炽焰劫击] +3级","[极限多重爆头] +3级"],"explain":[],"set":""},{"id":100340269,"name":"真神的庇护 - 重炮掌控者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[超温重火器] +4级","[远古粒子炮] +3级","[寒冰喷射器] +3级","[FM-92 mk2 SW榴弹] +3级"],"explain":[],"set":""},{"id":100340270,"name":"真神的庇护 - 机械之心","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[G系扩张] +4级","[改装 : G-0战争领主] +3级","[Ez-10反击者] +3级","[Ex-S Zero毒蛇炮] +3级"],"explain":[],"set":""},{"id":100340271,"name":"真神的庇护 - 战争女神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[EMP磁暴] +3级","[弹药强化] +4级","[C4飞速炸弹] +3级","[M-61地雷] +3级"],"explain":[],"set":""},{"id":100340272,"name":"真神的庇护 - 大魔导师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[元素集中] +4级","[属性轰炸] +3级","[光电冰墙] +3级","[虚无火山] +3级"],"explain":[],"set":""},{"id":100340273,"name":"真神的庇护 - 月之女皇","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[契约召唤 : 征服者卡西利亚斯] +3级","[精灵召唤 : 拉特利亚] +3级","[精灵召唤 : 瑟利斯特] +3级","[精灵召唤 : 希德] +3级","[精灵召唤 : 艾丽西娅] +3级"],"explain":[],"set":""},{"id":100340274,"name":"真神的庇护 - 贝亚娜斗神","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[变身贝亚娜] +3级","[斗神意志] +4级","[流星雷连击] +3级","[炫纹碎霸] +3级"],"explain":[],"set":""},{"id":100340275,"name":"真神的庇护 - 魔术师","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[技艺融合] +3级","[成功预感] +4级","[弹跳旋转扫把] +3级","[超级苍蝇拍] +3级"],"explain":[],"set":""},{"id":100340276,"name":"真神的庇护 - 天启者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[天启之珠] +3级","[信念光环] +4级","[圣光琉璃碎] +3级","[双子沁盾] +3级"],"explain":[],"set":""},{"id":100340277,"name":"真神的庇护 - 神之手","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[极限燃烧] +4级","[泯灭神击] +3级","[刺拳狂击] +3级","[破坏之拳] +3级"],"explain":[],"set":""},{"id":100340278,"name":"真神的庇护 - 龙斗士","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[斗志散发] +4级","[苍龙击] +3级","[狂暴锤击] +3级","[式神 : 真玄武] +3级"],"explain":[],"set":""},{"id":100340279,"name":"真神的庇护 - 末日审判者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[魔化 : 末日审判者] +3级","[恶魔唤醒] +4级","[地狱之门] +3级","[末日浩劫] +3级"],"explain":[],"set":""},{"id":100340280,"name":"真神的庇护 - 银月","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[月弧] +4级","[月轮舞] +3级","[陨落螺旋刺] +3级","[旋刃冲击] +3级"],"explain":[],"set":""},{"id":100340281,"name":"真神的庇护 - 灵魂收割者","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[屠戮之惧] +4级","[千魂祭] +3级","[死灵之缚] +3级","[释魂暗劲波] +3级"],"explain":[],"set":""},{"id":100340282,"name":"真神的庇护 - 魔皇","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[幻魔四重奏] +3级","[元素唤醒] +4级","[元素浓缩球] +3级","[元素幻灭] +3级"],"explain":[],"set":""},{"id":100340283,"name":"真神的庇护 - 冰冻之心","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_80.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":51,"intel":51,"vit":51,"spr":51,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[千旋冰轮破] +3级","[冰封奥义] +4级","[冰凌破] +3级","[千里冰封] +3级"],"explain":[],"set":""},{"id":100340285,"name":"圣灵之咒","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_83.png","atk":"","matk":"","ind":0,"pdef":"1116~1116","mdef":"2303~2303","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["被击时所受伤害 -35%","决斗场内修正物理防御力数值","决斗场内修正魔法防御力数值"],"set":""},{"id":100340295,"name":"赫仑皇帝的杀戮手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340296,"name":"极武之魂","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340297,"name":"天才的不败拳套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340298,"name":"无间者伊奇的魔法手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340299,"name":"玛尔的贤者手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340300,"name":"风神之怒","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340301,"name":"兰蒂卢斯的指挥手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"130~130","matk":"130~130","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340302,"name":"天族米乌的战斗手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"130~130","matk":"130~130","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340303,"name":"女战士的狂暴手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"135~135","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340305,"name":"第七帝国的肩章","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_89.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":105,"intel":105,"vit":105,"spr":105,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["力量、智力 +10%"],"set":""},{"id":100340307,"name":"晨之凝露","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_92.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +35%　魔法暴击 +35%　所有属性强化 +18%","skills":[],"explain":[],"set":""},{"id":100340309,"name":"路易斯的毒王手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_95.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["技能攻击力 +8%","决斗场内出血、中毒、闪电伤害增加23%","地下城中：出血伤害 +50%，中毒伤害 +50%，感电伤害 +50%"],"set":""},{"id":100340334,"name":"赫仑的杀戮手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"155~155","matk":"155~155","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":100340345,"name":"祈求者的召唤手套","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_86.png","atk":"123~61","matk":"123~61","ind":0,"pdef":"","mdef":"","str":33,"intel":33,"vit":33,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["决斗场内修正物理攻击力 数值","决斗场内修正魔法攻击力数值"],"set":""},{"id":101000017,"name":"龙神决","level":80,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_93.png","atk":"862~735","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":62,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +2%　火属性攻击 +25%　火属性抗性 +12%","skills":[],"explain":["攻击时， 有5%的几率使敌人减少20%的HP。","火属性攻击时， 有5%的几率使自身增加10%的物理攻击力、 魔法攻击力和独立攻击力， 效果持续30秒。"],"set":""},{"id":101010035,"name":"天魔斩","level":80,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_100.png","atk":"1089~929","matk":"816~697","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":15,"incDmg":0,"affix":"攻击速度 -9%　施放速度 -2%　火属性攻击 +18%","skills":[],"explain":["攻击时， 附加15%的火属性伤害。","攻击恶魔族敌人时， 会出现火焰爆炸。","装备时， 使自身增加15点火属性强化。"],"set":""},{"id":101020037,"name":"冥炎刀 - 魂殇","level":80,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_96.png","atk":"862~735","matk":"953~813","ind":555,"pdef":"","mdef":"","str":62,"intel":92,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +13%　施放速度 +4%　硬直 -1%　物理暴击 +2%　火属性攻击 +20%　火属性抗性 +20%","skills":[],"explain":["攻击速度 +5%","攻击时， 有20%的几率附加20%的火属性伤害。","攻击时， 有10%的几率发动魂殇的觉醒， 效果持续15秒。"],"set":""},{"id":101030031,"name":"惊风之厄","level":80,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_86.png","atk":"998~851","matk":"862~735","ind":555,"pdef":"","mdef":"","str":92,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%","skills":[],"explain":["装备时， 增加30%的力量、智力。","HP减少时， 会根据剩余HP量增加自身的力量。","攻击时， 有2%的几率使敌人进入眩晕状态。"],"set":""},{"id":101040033,"name":"王之悲鸣","level":80,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_83.png","atk":"844~720","matk":"816~697","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +20%　硬直 -1%　暗属性攻击 +25%","skills":["[里 · 鬼剑术] +2级"],"explain":["攻击速度 +10%","施放[破极兵刃]、 [不屈意志]时， 在Buff持续时间内使自身被痛苦的女王附身。"],"set":""},{"id":102000043,"name":"异魔之主","level":80,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_98.png","atk":"862~735","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":62,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +2%　最大MP +1000%","skills":[],"explain":["每500点MP最大值， 可增加4点魔法攻击力和智力。 (最多增加500点)","MP高于50%时， 可增加20%的魔法暴击率。"],"set":""},{"id":102010102,"name":"堕落的恶魔之手","level":80,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_90.png","atk":"1089~929","matk":"816~697","ind":555,"pdef":"","mdef":"","str":92,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":20,"affix":"攻击速度 -8%　硬直 +1%　HP regen speed -300%　暗属性攻击 +18%","skills":[],"explain":["对敌人的伤害 +20%","攻击恶魔族敌人时， 附加25%的伤害。","击杀恶魔族敌人时， 可以恢复自身2%的HP。","装备时， 使自身增加15点暗属性强化。"],"set":""},{"id":102020036,"name":"百鬼冤灵之咒","level":80,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_93.png","atk":"907~774","matk":"907~774","ind":555,"pdef":"","mdef":"","str":62,"intel":31,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%","skills":["[爪精通] +5级","[狂 · 霸王拳] 无色小晶块消耗量 +1","[爪精通] +5级","[狂 · 霸王拳] 无色小晶块消耗量 +1"],"explain":["施放[狂 · 霸王拳]时， 附加25%的伤害， 效果持续7秒。","[狂 · 霸王拳]无色小晶块消耗量 +1","攻击不死族敌人时， 附加15%的伤害。","攻击类人型敌人时， 附加15%的伤害。"],"set":""},{"id":102030034,"name":"异魔封神棍","level":80,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_87.png","atk":"862~735","matk":"907~774","ind":555,"pdef":"860~860","mdef":"","str":62,"intel":92,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　硬直 +2%　stuck resistance +3%　MP regen speed +78%","skills":[],"explain":["MP高于75%时， 攻击时可对敌人附加30%的伤害。","MP在50%~75%之间时， 攻击时可对敌人附加15%的伤害。","MP在25%~50%之间时， 攻击时可对敌人附加5%的伤害。"],"set":""},{"id":102040036,"name":"异魔之源","level":80,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_78.png","atk":"953~813","matk":"862~735","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　最大MP +1000%","skills":[],"explain":["每500点MP最大值， 可增加4点物理攻击力和力量。 (最多增加500点)","MP高于50%时， 可增加20%的物理暴击率。","攻击时， 有2%的几率使敌人进入眩晕状态。"],"set":""},{"id":104000036,"name":"寐语者 - 残云","level":80,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_84.png","atk":"901~705","matk":"758~593","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"物理暴击 +2%","skills":["[枪舞] 攻击力-25%，发射数上限 +80%","[死亡左轮] +2级","[多重爆头] 攻击力-25%","[乱射] 攻击力-25%，发射数上限 +80%","[死亡左轮] +2级","[多重爆头] 攻击力-25%"],"explain":["[乱射]发射数上限 +80%","[乱射]攻击力 -25%","[乱射]发射速度 +30%","[枪舞]发射数上限 +80%","[枪舞]攻击力 -25%","[枪舞]发射速度 +30%","[多重射击]发射数上限 + 80%","[多重射击]攻击力 -25%","施放[乱射]、 [枪舞]、 [多重射击]时， 可对武器进行加热， 并使被击的敌人附加10%的火属性伤害， 效果持续20秒。","穿刺力 +15%"],"set":""},{"id":104010031,"name":"赤练蛇 - 火影","level":80,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_90.png","atk":"631~494","matk":"926~725","ind":555,"pdef":"","mdef":"","str":0,"intel":62,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 -1%","skills":["[RX-78追击者] +3级","[Ez-8自爆者] +3级","[G系扩张] +3级","[改装 : G-0战争领主] +2级","[RX-78追击者] +3级","[Ez-8自爆者] +3级","[盖波加之拳] +2级","[斗志之歌] +3级"],"explain":["施放[RX-78追击者]时， 多召唤1个追击者。","施放[RX-78追击者]和[Ez-8自爆者]时， 可以使自身进入霸体状态。"],"set":""},{"id":104020032,"name":"七煞星 - 狂袭","level":80,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_83.png","atk":"758~593","matk":"842~659","ind":555,"pdef":"","mdef":"","str":62,"intel":31,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +2%　硬直 +1%　物理暴击 +3%　光属性攻击 +20%","skills":["[银弹] +3级","[G-35L感电手雷] +3级","[银弹] +3级","[G-35L感电手雷] +3级"],"explain":["攻击时， 可以使敌人减少15点光属性抗性， 效果持续10秒。","攻击时， 有5%的几率对敌人召唤天谴闪电。","被攻击时， 在自身周围召唤8个天谴闪电。"],"set":""},{"id":104030037,"name":"炎龙之天罚","level":80,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_88.png","atk":"968~758","matk":"842~659","ind":555,"pdef":"","mdef":"","str":62,"intel":92,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"火属性攻击 +20%","skills":["[尼尔狙击] +2级","[尼尔狙击] +2级"],"explain":["[尼尔狙击]攻击时， 可附加30%火属性伤害， 并有50%的几率使被击敌人进入灼伤状态"],"set":""},{"id":104040035,"name":"惊雷之吼","level":80,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_87.png","atk":"1052~824","matk":"631~494","ind":555,"pdef":"","mdef":"","str":92,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":0,"incDmg":0,"affix":"火属性攻击 +18%","skills":["[反坦克炮] 攻击力+350%，冷却-1.5秒，范围+100%，爆炸次数 -2次","[反坦克炮] 攻击力-50%，冷却-1.5秒，爆炸次数 +2次"],"explain":["神枪手(男)","[反坦克炮]爆炸次数 +2次","[反坦克炮]爆炸时间 -50%","[反坦克炮]爆炸物理攻击力 -50%","[反坦克炮]冷却时间 -1.5秒","神枪手(女)","[反坦克炮]爆炸次数 -2次","[反坦克炮]爆炸时间 +0.5秒","[反坦克炮]爆炸大小比率 +50%","[反坦克炮]爆炸物理攻击力 +350%","[反坦克炮]冷却时间 -1.5秒","施放[反坦克炮]时， 附加35%的伤害。"],"set":""},{"id":106000033,"name":"天命之矛","level":80,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_104.png","atk":"1089~929","matk":"771~658","ind":555,"pdef":"","mdef":"","str":92,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　硬直 +1%　物理暴击 +10%","skills":["[碎霸] +3级，范围+35%","[煌龙偃月刀] +4级","[炫纹碎霸] +2级"],"explain":["暴击伤害 +25%","[碎霸]攻击范围 +35%","[闪击碎霸]攻击范围 +35%"],"set":""},{"id":106010034,"name":"空之无境","level":80,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_95.png","atk":"816~697","matk":"998~851","ind":555,"pdef":"","mdef":"","str":0,"intel":92,"vit":0,"spr":0,"elem":"","addDmg":15,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +5%　硬直 -1%　光属性攻击 +18%　水属性攻击 +18%","skills":["[破冰飞刃] +3级，冰碎片数量 +2","[召唤兽强化] +2级","[精灵召唤 : 极光格雷林] 攻击力+40%","[精灵召唤 : 冰影阿奎利斯] 攻击力+40%"],"explain":["攻击时， 附加15%的伤害。","[破冰飞刃]冰碎片数量 +2","[破冰飞刃]施放前僵直 -50%","施放[破冰飞刃]时， 增加25%的攻击速度， 效果持续2秒。","[精灵召唤 : 极光格雷林]攻击力 +40%","[精灵召唤 : 冰影阿奎利斯]攻击力 +40%"],"set":""},{"id":106020031,"name":"西洋棋之迷踪骑士","level":80,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_92.png","atk":"980~836","matk":"816~697","ind":555,"pdef":"","mdef":"","str":62,"intel":62,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　移动速度 +3%　硬直 +1%　暗属性攻击 +18%","skills":["[元素禁域] +3级","[棍棒精通] +3级","[强袭流星打] 攻击力+50%"],"explain":["[强袭流星打]攻击力 +50%","施放[强袭流星打]时， 附加20%的伤害， 效果持续120秒。 (最多重叠1次； 解除装备后效果消失)"],"set":""},{"id":106030036,"name":"童话之森","level":80,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_102.png","atk":"862~735","matk":"1184~1024","ind":603,"pdef":"","mdef":"","str":0,"intel":162,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　施放速度 +5%","skills":[],"explain":["装备时， 每30秒会召唤出3只牙签鸟， 自身和队友可以获得以下效果， 效果持续30秒。","- 所有属性强化 +25","- 物理、 魔法暴击率 +12%","↑↓+[宠物技能键]输入时， 可以召唤出愤怒的牙签鸟攻击敌人， 但需要消耗2个无色小晶块。"],"set":""},{"id":106040032,"name":"惊月流云扫把","level":80,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_78.png","atk":"907~774","matk":"998~851","ind":555,"pdef":"","mdef":"","str":0,"intel":62,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%　所有属性强化 +30%","skills":["[变异苍蝇拍] +3级","[超级苍蝇拍] +2级"],"explain":["[变异苍蝇拍]、 [超级苍蝇拍]、 [暴炎加热炉]、 [冰霜钻孔车]、 [电鳗碰撞机]、 [反重力装置]失败率 -10%","[变异苍蝇拍]、 [超级苍蝇拍]、 [暴炎加热炉]、 [冰霜钻孔车]、 [电鳗碰撞机]、 [反重力装置]大成功率 +10%","攻击时， 附加20%的伤害。"],"set":""},{"id":108000033,"name":"苍木之冥","level":80,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_84.png","atk":"907~774","matk":"862~735","ind":555,"pdef":"860~860","mdef":"860~860","str":0,"intel":62,"vit":73,"spr":73,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +2%","skills":["[守护徽章] +3级","[生命泉源] +4级","[圣光守护] +3级","[圣愈之风] +4级","[荣誉祝福] +4级"],"explain":[],"set":""},{"id":108010032,"name":"云梦沉香珠","level":80,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_81.png","atk":"816~697","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":92,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +5%　魔法暴击 +2%　光属性攻击 +5%","skills":["[落雷符] 攻击力+25%"],"explain":["[落雷符]闪电攻击力 +25%","施放[落雷符]时， 可以使队员增加12点光属性强化值， 效果持续20秒。"],"set":""},{"id":108010034,"name":"云梦浮生珠","level":80,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_81.png","atk":"816~697","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":92,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +5%　魔法暴击 +2%　光属性攻击 +25%","skills":["[落雷符] +3级，攻击力+30%，持续+30%，同时落下的闪电数量上限 +2"],"explain":["[落雷符]闪电攻击力 +30%","[落雷符]持续时间 +30%","[落雷符]闪电间隔减少30%","[落雷符]每次闪电数增加2","施放[落雷符]时， 可以对自身和队友赋予光属性并增加30点光属性强化， 效果持续40秒。 (最多叠加1次； 解除装备后效果消失)"],"set":""},{"id":108020031,"name":"九龙阙","level":80,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_87.png","atk":"953~813","matk":"816~697","ind":555,"pdef":"","mdef":"","str":92,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +1%　光属性攻击 +25%","skills":["[极速飓风拳] +3级","[意念驱动] +2级"],"explain":["施放[意念驱动]时， 可以使队员的武器属性变成光属性， 且增加20点光属性强化值， 效果持续60秒。 (最多重叠1次)","[极速飓风拳]攻击时， 会附加20%的光属性伤害。"],"set":""},{"id":108030032,"name":"断残蚀骨","level":80,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_88.png","atk":"1272~1112","matk":"930~817","ind":596,"pdef":"","mdef":"","str":80,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +2%　物理暴击 +15%","skills":["[狂乱锤击] 攻击力+40%，冷却-20%，范围+40%，攻击次数 +2","[狂暴锤击] 攻击力+40%，冷却-20%，攻击次数 +2"],"explain":["[狂乱锤击]攻击力 +40%","[狂乱锤击]攻击次数 +2","[狂乱锤击]冷却时间 -20%","[狂暴锤击]攻击次数 +2","[狂暴锤击]攻击力 +40%","[狂暴锤击]冷却时间 -20%"],"set":""},{"id":108040032,"name":"傲龙凌雪","level":80,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_85.png","atk":"862~735","matk":"907~774","ind":555,"pdef":"","mdef":"","str":62,"intel":62,"vit":0,"spr":0,"elem":"水属性","addDmg":12,"incDmg":0,"affix":"攻击速度 +8%　硬直 -1%　物理暴击 +2%　魔法暴击 +2%　暗属性攻击 +14%　水属性攻击 +14%","skills":["[恶魔诅咒] +3级","[黑暗权能] +3级"],"explain":["[半魔化]Z、 X、 C残影攻击力比率 +15%","攻击时， 附加12%的伤害。","[恶魔之刺]、]技能攻击时， 可以使敌人进入冰冻状态3秒。"],"set":""},{"id":109000033,"name":"潜龙渊","level":80,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_108.png","atk":"851~678","matk":"816~697","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%","skills":["[死亡风暴] +3级","[剑刃风暴] +3级，冷却-30%","[螺旋穿刺] +3级，冷却-20%","[陨落螺旋刺] +2级，冷却-30%"],"explain":["[剑刃风暴]冷却时间 -30%","[螺旋穿刺]冷却时间 -20%","[陨落螺旋刺]冷却时间 -30%","施放特定技能时， 攻击时附加25%的伤害， 效果持续60秒。"],"set":""},{"id":109010031,"name":"千月之魅","level":80,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_105.png","atk":"984~788","matk":"726~619","ind":555,"pdef":"","mdef":"","str":62,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":25,"incDmg":0,"affix":"攻击速度 -8%　物理暴击 +5%　暗属性攻击 +18%","skills":["[双剑精通] +2级","[陨落螺旋刺] +2级"],"explain":["攻击时， 有5%的几率使500px范围内的所有敌人进入失明状态5秒。","攻击时， 附加25%的伤害。"],"set":""},{"id":109020031,"name":"魂天宿 - 绝殇","level":80,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_106.png","atk":"788~625","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":62,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%　魔法暴击 +5%","skills":["[降临 : 暴君巴拉克] 攻击力+35%","[巴拉克的野心] +2级，攻击力+35%","[巴拉克的愤怒] +2级，攻击力+35%","[千魂祭] 攻击力+45%","[释魂暗劲波] 攻击力+55%"],"explain":["[降临 : 暴君巴拉克]攻击力 +35%","[巴拉克的野心]第2击魔法攻击力 +35%","[巴拉克的愤怒]第2击冲击波魔法攻击力 +35%","[千魂祭]最后爆炸魔法攻击力 +45%","[释魂暗劲波]爆炸魔法攻击力 +55%"],"set":""},{"id":2024100201,"name":"极皇拳套","level":80,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_135.png","atk":"953~813","matk":"862~735","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%","skills":[],"explain":["装备时， 发动金色光谱。"],"set":""},{"id":2024100202,"name":"魔女残影爪","level":80,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_153.png","atk":"907~774","matk":"907~774","ind":555,"pdef":"","mdef":"","str":68,"intel":34,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"物理暴击 +3%　所有属性强化 +30%　暗属性抗性 +20%","skills":[],"explain":["[↑↓+宠物技能]输入时， 使所有队员进入伪装状态， 效果持续4秒。","装备时， 发动悲伤残影光谱。"],"set":""},{"id":2024100203,"name":"青龙腾海臂铠","level":80,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_149.png","atk":"1089~929","matk":"816~697","ind":555,"pdef":"","mdef":"","str":102,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 -8%　硬直 +1%","skills":[],"explain":["装备时， 发动大地女神光谱。"],"set":""},{"id":2024100204,"name":"千莲护元","level":80,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_164.png","atk":"862~735","matk":"1128~975","ind":640,"pdef":"","mdef":"","str":0,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +2%","skills":[],"explain":["暴击时， 增加30%的伤害增加量","进入地下城时， 落下念气花瓣。"],"set":""},{"id":2024100205,"name":"飞龙幻影棍","level":80,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_148.png","atk":"862~735","matk":"907~774","ind":555,"pdef":"860~860","mdef":"","str":68,"intel":102,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 +20%　施放速度 +15%　移动速度 +10%　硬直 +2%　stuck resistance +3%","skills":[],"explain":["附加伤害 +30%","[↑↓+宠物技能]输入时， 生成吸附前方敌人的旋风。","施放技能时， 有25%的几率使自身增加速度。"],"set":""},{"id":2024100206,"name":"枪械之神 - 闪","level":80,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_152.png","atk":"631~494","matk":"926~725","ind":555,"pdef":"","mdef":"","str":0,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +10%　硬直 -1%","skills":["[空投支援] 范围-50%，爆炸数量 +30%","[空投支援] 范围-50%，爆炸数量 +30%"],"explain":["[空投支援]爆炸范围 -50%","[空投支援]爆炸数量 +30%","力量、 智力 +30%"],"set":""},{"id":2024100207,"name":"旋风斗星弩","level":80,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_144.png","atk":"758~593","matk":"842~659","ind":555,"pdef":"","mdef":"","str":68,"intel":34,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"攻击速度 +2%　硬直 +1%　物理暴击 +3%","skills":["[上旋踢] +8级，攻击次数 +2","[G-14手雷] [G-18C冰冻手雷]填充数上限 +2","[回旋踢] +8级，攻击力-50%，攻击次数 +2","[G-14手雷] [G-18C冰冻手雷]填充数上限 +2"],"explain":["[回旋踢]攻击次数 +2","[回旋踢]攻击力 -50%","[上旋踢]攻击次数 +2","[上旋踢]攻击力 -50%","[G-14手雷]、 [G-35L感电手雷]、 [G-18C冰冻手雷]填充数上限 +2","攻击时， 增加30%的伤害增加量 (伤害加成效果取最高值， 且无法叠加)","攻击时， 有5%的几率引导飓风。"],"set":""},{"id":2024100208,"name":"吞日者","level":80,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_148.png","atk":"1052~824","matk":"631~494","ind":555,"pdef":"","mdef":"","str":102,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"","skills":["[量子爆弹] 范围+30%","[量子爆弹] 范围+30%"],"explain":["[量子爆弹]大小 +30%","[X-1 压缩量子炮]爆炸范围 +30%","攻击时， 增加30%的伤害增加量 (伤害加成效果取最高值， 且无法叠加)","击杀敌人时， 生成小太阳。","吃掉太阳后， 部分攻击可产生更多小太阳。"],"set":""},{"id":2024100209,"name":"死亡步枪","level":80,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_148.png","atk":"968~758","matk":"842~659","ind":555,"pdef":"","mdef":"","str":68,"intel":102,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["装备时， 发动[死亡步枪]"],"set":""},{"id":2024100210,"name":"夕阳骑士","level":80,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_143.png","atk":"901~705","matk":"758~593","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +12%　物理暴击 +2%","skills":[],"explain":["装备时， 发动夕阳光谱。"],"set":""},{"id":2024100211,"name":"领悟者的涂鸦笔 ","level":80,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_139.png","atk":"907~774","matk":"998~851","ind":555,"pdef":"","mdef":"","str":0,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%","skills":[],"explain":["攻击时， 附加30%的伤害。","[↑↓+宠物技能]输入时， 在地面随机生成涂鸦。"],"set":""},{"id":2024100212,"name":"贤者屠魔棍","level":80,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_154.png","atk":"980~836","matk":"816~697","ind":555,"pdef":"","mdef":"","str":68,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":28,"incDmg":0,"affix":"攻击速度 +5%　硬直 +1%","skills":["[棍棒精通] +2级"],"explain":["借助贤者达克夏的力量生成元素。"],"set":""},{"id":2024100213,"name":"安格雷赫的召鼠笛","level":80,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_161.png","atk":"816~697","matk":"998~851","ind":555,"pdef":"","mdef":"","str":0,"intel":102,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +5%　硬直 -1%","skills":[],"explain":["[↑↓+宠物技能]输入时， 从天上掉下仓鼠。","攻击时， 从某处冒出被笛声吸引而来的仓鼠。"],"set":""},{"id":2024100214,"name":"赤龙守护矛","level":80,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_164.png","atk":"1089~929","matk":"771~658","ind":555,"pdef":"","mdef":"","str":102,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　硬直 +1%　物理暴击 +2%","skills":["[矛精通] +2级"],"explain":["装备时， 发动赤龙守护。"],"set":""},{"id":2024100215,"name":"威利的戒言法杖","level":80,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_165.png","atk":"862~735","matk":"1184~1024","ind":603,"pdef":"","mdef":"","str":0,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%","skills":[],"explain":["威利施加魔力激活咒语。","威利偶尔会絮叨。"],"set":""},{"id":2024100216,"name":"泰坦的疾风战斧","level":80,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_148.png","atk":"1089~929","matk":"816~697","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"攻击速度 -8%　硬直 +2%","skills":["[巨兵精通] +2级"],"explain":["装备时， 发动粉色光谱。"],"set":""},{"id":2024100217,"name":"席蒿待罪","level":80,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_142.png","atk":"1012~874","matk":"962~830","ind":624,"pdef":"960~960","mdef":"960~960","str":0,"intel":168,"vit":181,"spr":181,"elem":"","addDmg":0,"incDmg":20,"affix":"施放速度 +2%　所有属性强化 +30%","skills":[],"explain":["[灵魂牺牲]力量、 智力增加量 +100%","[灵魂牺牲]体力、 精神减少量 +100%","对敌人的伤害 +20%(伤害加成效果取最高值， 且无法叠加)","攻击时， 有5%几率发出古怪的声音。"],"set":""},{"id":2024100218,"name":"卡拉斯 - 逐龙","level":80,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_136.png","atk":"816~697","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":102,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +20%　魔法暴击 +2%　所有属性强化 +22%","skills":[],"explain":["打破禁忌的念珠封印， 解放蕴含的领主之力， 增幅自身， 同时攻击额外附加领主的闪电。"],"set":""},{"id":2024100219,"name":"即死领悟 - 死神之镰","level":80,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_147.png","atk":"862~735","matk":"907~774","ind":555,"pdef":"","mdef":"","str":68,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　硬直 -1%　物理暴击 +2%　魔法暴击 +2%","skills":[],"explain":["HP高于80%时， 会迅速降低。","HP低于80%时， 攻击会闪现死神。","角色死亡时出现死神。"],"set":""},{"id":2024100220,"name":"班图族的五行图腾","level":80,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_155.png","atk":"953~813","matk":"816~697","ind":555,"pdef":"","mdef":"","str":102,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"硬直 +1%　所有属性强化 +25%　all elemental resistance +15%","skills":["[幻影化身] +3级"],"explain":["攻击时， 增加30%的伤害(无法叠加)","角色会发冷。"],"set":""},{"id":2024100221,"name":"天脊乾坤剑","level":80,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_139.png","atk":"844~720","matk":"816~697","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%","skills":[],"explain":["装备时， 发动灼热光谱。"],"set":""},{"id":2024100222,"name":"地狱邪目","level":80,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_148.png","atk":"998~851","matk":"862~735","ind":555,"pdef":"","mdef":"","str":127,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%","skills":[],"explain":["[↑↓+宠物技能]输入时， 生成地狱之眼搜寻敌人并赋予自身特殊效果。"],"set":""},{"id":2024100223,"name":"逸龙剑 - 抉择","level":80,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_170.png","atk":"1089~929","matk":"816~697","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -9%　施放速度 -2%","skills":[],"explain":["暴击伤害增加 +30%(不可叠加)","被攻击时， 爆发战意将大范围内的所有敌人击晕。"],"set":""},{"id":2024100224,"name":"血舞旋月刀","level":80,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_166.png","atk":"862~735","matk":"953~813","ind":555,"pdef":"","mdef":"","str":68,"intel":102,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"攻击速度 +8%　施放速度 +4%　硬直 -1%　物理暴击 +2%","skills":[],"explain":["[↑↓+宠物技能]输入时， 20秒内召唤血光月。","装备时， 每5秒使400px范围内的所有敌人进入出血状态10秒。"],"set":""},{"id":2024100225,"name":"双剑 - 百鬼乱舞","level":80,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_157.png","atk":"862~735","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":68,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +2%","skills":[],"explain":["攻击时， 有33%的几率收割灵魂。"],"set":""},{"id":2024100227,"name":"哈雷斯的疾光刃","level":80,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_170.png","atk":"851~678","matk":"816~697","ind":555,"pdef":"","mdef":"","str":68,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%","skills":["[匕首精通] +3级"],"explain":["装备时， 发动白银光谱。"],"set":""},{"id":2024100228,"name":"音速疾风刃","level":80,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_165.png","atk":"984~788","matk":"726~619","ind":555,"pdef":"","mdef":"","str":104,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":30,"affix":"攻击速度 -8%　物理暴击 +5%","skills":[],"explain":["攻击时， 对面前的敌人生成刀刃风暴， 并发动音速爆炸增益。"],"set":""},{"id":2024100229,"name":"千年蟾蜍","level":80,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_174.png","atk":"788~625","matk":"1043~890","ind":555,"pdef":"","mdef":"","str":0,"intel":104,"vit":0,"spr":0,"elem":"","addDmg":30,"incDmg":0,"affix":"攻击速度 -10%　魔法暴击 +5%　所有属性强化 +20%","skills":[],"explain":["攻击时， 借助灵物的力量生成增幅诅咒阵并强化能力值。"],"set":""},{"id":100050202,"name":"锦绣丹华长袍","level":75,"slot":"coat","armor":"cloth","wg":"","type":"布甲上衣","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_coat_cloth_coat_20.png","atk":"","matk":"","ind":0,"pdef":"4104~3996","mdef":"","str":0,"intel":42,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +450%","skills":[],"explain":["每3000点物理防御力增加12点魔法攻击力。 (最多增加120点)"],"set":""},{"id":100060130,"name":"怒海狂鲨胸甲","level":75,"slot":"coat","armor":"leather","wg":"","type":"皮甲上衣","icon":"/assets/icons/sprite_item_new_equipment_03_leather_coat_leather_coat_21.png","atk":"","matk":"","ind":0,"pdef":"2208~1992","mdef":"","str":35,"intel":35,"vit":0,"spr":38,"elem":"","addDmg":0,"incDmg":10,"affix":"水属性攻击 +24%","skills":[],"explain":["冰属性攻击时， 有3%的几率使敌人进入出血状态。","冰属性暴击攻击时， 增加10%的伤害。"],"set":""},{"id":100070157,"name":"混元武士的厄运胸甲","level":75,"slot":"coat","armor":"light","wg":"","type":"轻甲上衣","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_coat_larmor_coat_20.png","atk":"","matk":"","ind":0,"pdef":"3312~2988","mdef":"","str":92,"intel":78,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +500%","skills":[],"explain":["装备后， 会增加自身300点的力量和智力。","装备后， 每30秒会使自身进入中毒状态。"],"set":""},{"id":100080137,"name":"逆龙之战破敌铠甲","level":75,"slot":"coat","armor":"heavy","wg":"","type":"重甲上衣","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_coat_harmor_coat_19.png","atk":"","matk":"","ind":0,"pdef":"4416~3984","mdef":"","str":88,"intel":78,"vit":85,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["力量、智力 +3%","攻击时， 有20%的几率使自身进入霸体状态10秒。"],"set":""},{"id":100090073,"name":"圣堂骑士的赦令胸甲","level":75,"slot":"coat","armor":"plate","wg":"","type":"板甲上衣","icon":"/assets/icons/sprite_item_new_equipment_06_plate_coat_plate_coat_20.png","atk":"","matk":"","ind":0,"pdef":"5520~4980","mdef":"","str":35,"intel":35,"vit":38,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["攻击时， 有1%的几率使自身进入霸体状态7秒。 (冷却时间20秒)","被攻击时， 有20%的几率使自身进入霸体状态3秒。 (冷却时间20秒)","该装备的霸体效果发动后， 被攻击时有50%的几率免疫所受伤害。","(解除装备后效果消失)"],"set":""},{"id":100100132,"name":"锦绣丹华长裤","level":75,"slot":"pants","armor":"cloth","wg":"","type":"布甲下装","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_pants_cloth_pants_18.png","atk":"","matk":"","ind":0,"pdef":"3420~3330","mdef":"","str":0,"intel":42,"vit":0,"spr":42,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +375%","skills":[],"explain":["每2000点物理防御力增加15点智力。 (最多增加225点)"],"set":""},{"id":100110118,"name":"怒海狂鲨腿甲","level":75,"slot":"pants","armor":"leather","wg":"","type":"皮甲下装","icon":"/assets/icons/sprite_item_new_equipment_03_leather_pants_leather_pants_17.png","atk":"","matk":"","ind":0,"pdef":"1840~1660","mdef":"","str":35,"intel":35,"vit":0,"spr":38,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性攻击 +20%","skills":[],"explain":["冰属性攻击时， 有2%的几率使敌人进入中毒状态。","冰属性攻击时， 有3%的几率使画面内的所有敌人减少30点冰属性抗性， 效果持续7秒。 (冷却时间7秒)"],"set":""},{"id":100120150,"name":"混元武士的邪魔护腿","level":75,"slot":"pants","armor":"light","wg":"","type":"轻甲下装","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_pants_larmor_pants_18.png","atk":"","matk":"","ind":0,"pdef":"2760~2490","mdef":"","str":92,"intel":78,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大MP +500%","skills":[],"explain":["体力 +150","精神 +150","攻击速度 +20%","施放速度 +25%","移动速度 +10%","装备后， 每30秒会使自身进入感电状态。"],"set":""},{"id":100130131,"name":"逆龙之战影袭护腿","level":75,"slot":"pants","armor":"heavy","wg":"","type":"重甲下装","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_pants_harmor_pants_17.png","atk":"","matk":"","ind":0,"pdef":"3680~3320","mdef":"","str":158,"intel":148,"vit":35,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级","[物理背击] +5级","[魔法背击] +5级"],"explain":["力量、智力 +3%。"],"set":""},{"id":100140068,"name":"圣堂骑士的神罚胫甲","level":75,"slot":"pants","armor":"plate","wg":"","type":"板甲下装","icon":"/assets/icons/sprite_item_new_equipment_06_plate_pants_plate_pants_17.png","atk":"","matk":"","ind":0,"pdef":"4600~4150","mdef":"","str":35,"intel":35,"vit":38,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +15%　魔法暴击 +15%","skills":[],"explain":[],"set":""},{"id":100150123,"name":"锦绣丹华护肩","level":75,"slot":"shoulder","armor":"cloth","wg":"","type":"布甲头肩","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_neck_cloth_neck_16.png","atk":"","matk":"","ind":0,"pdef":"2736~2664","mdef":"","str":0,"intel":33,"vit":0,"spr":33,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +20%　最大HP +300%","skills":[],"explain":["施放技能时， 使自身进入霸体状态1秒。 (冷却时间3秒)"],"set":""},{"id":100160085,"name":"怒海狂鲨护肩","level":75,"slot":"shoulder","armor":"leather","wg":"","type":"皮甲头肩","icon":"/assets/icons/sprite_item_new_equipment_03_leather_neck_leather_neck_16.png","atk":"","matk":"","ind":0,"pdef":"1472~1328","mdef":"","str":28,"intel":28,"vit":0,"spr":31,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +5%　水属性攻击 +20%　水属性抗性 +30%","skills":[],"explain":["冰属性攻击时， 使自身增加12%的攻击速度、 15%的施放速度和10%的移动速度， 效果持续10秒。 (冷却时间10秒)"],"set":""},{"id":100170141,"name":"混元武士的煞血护肩","level":75,"slot":"shoulder","armor":"light","wg":"","type":"轻甲头肩","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_neck_larmor_neck_16.png","atk":"","matk":"","ind":0,"pdef":"2208~1992","mdef":"","str":63,"intel":52,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +350%","skills":[],"explain":["装备后， 每30秒会使自身进入出血状态。","装备时， 会增加自身25%的物理暴击率和魔法暴击率。"],"set":""},{"id":100180123,"name":"逆龙之战强袭肩甲","level":75,"slot":"shoulder","armor":"heavy","wg":"","type":"重甲头肩","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_neck_harmor_neck_17.png","atk":"","matk":"","ind":0,"pdef":"2944~2656","mdef":"","str":81,"intel":72,"vit":128,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"施放速度 +15%　物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["力量、智力 +3%。"],"set":""},{"id":100190057,"name":"圣堂骑士的审判肩甲","level":75,"slot":"shoulder","armor":"plate","wg":"","type":"板甲头肩","icon":"/assets/icons/sprite_item_new_equipment_06_plate_neck_plate_neck_16.png","atk":"","matk":"","ind":0,"pdef":"3680~3320","mdef":"","str":28,"intel":28,"vit":31,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["暴击伤害 +18%"],"set":""},{"id":100200103,"name":"锦绣丹华腰带","level":75,"slot":"belt","armor":"cloth","wg":"","type":"布甲腰带","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_belt_cloth_belt_16.png","atk":"","matk":"","ind":0,"pdef":"1368~1332","mdef":"","str":0,"intel":25,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"最大HP +150%　inventory limit +3000%","skills":[],"explain":["施放技能时， 有20%的几率使自身所有属性强化增加30点， 效果持续40秒。 (消耗1个金色小晶块； 冷却时间40秒)"],"set":""},{"id":100210107,"name":"怒海狂鲨腰带","level":75,"slot":"belt","armor":"leather","wg":"","type":"皮甲腰带","icon":"/assets/icons/sprite_item_new_equipment_03_leather_belt_leather_belt_17.png","atk":"","matk":"","ind":0,"pdef":"736~664","mdef":"","str":21,"intel":21,"vit":0,"spr":23,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%　物理暴击 +10%　魔法暴击 +10%　水属性攻击 +20%","skills":[],"explain":["装备时， 可以赋予武器冰属性。"],"set":""},{"id":100220136,"name":"混元武士的暗隐腰带","level":75,"slot":"belt","armor":"light","wg":"","type":"轻甲腰带","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_belt_larmor_belt_16.png","atk":"","matk":"","ind":0,"pdef":"1104~996","mdef":"","str":55,"intel":47,"vit":0,"spr":0,"elem":"","addDmg":10,"incDmg":0,"affix":"最大MP +350%　inventory limit +3000%","skills":[],"explain":["装备后， 每30秒会使自身进入失明状态。","当自身处于失明状态时， 会增加10%的攻击伤害。","装备时， 会增加30%的命中率和15%的回避率。"],"set":""},{"id":100230123,"name":"逆龙之战暗袭腰带","level":75,"slot":"belt","armor":"heavy","wg":"","type":"重甲腰带","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_belt_harmor_belt_17.png","atk":"","matk":"","ind":0,"pdef":"1472~1328","mdef":"","str":73,"intel":67,"vit":71,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +15%　inventory limit +3000%　物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":["力量、智力 +3%。"],"set":""},{"id":100240060,"name":"圣堂骑士的援护腰带","level":75,"slot":"belt","armor":"plate","wg":"","type":"板甲腰带","icon":"/assets/icons/sprite_item_new_equipment_06_plate_belt_plate_belt_16.png","atk":"","matk":"","ind":0,"pdef":"1840~1660","mdef":"","str":21,"intel":21,"vit":53,"spr":30,"elem":"","addDmg":0,"incDmg":0,"affix":"inventory limit +3000%","skills":[],"explain":["当HP低于50%时， 会立即恢复10%的HP， 并增加10%的自身防御力， 效果持续30秒。","(冷却时间30秒； 解除装备后效果消失)","当HP低于25%时， 会对自身施放Lv10的[圣光守护]。 (冷却时间60秒)"],"set":""},{"id":100250108,"name":"锦绣丹华长靴","level":75,"slot":"shoes","armor":"cloth","wg":"","type":"布甲鞋","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_shoes_cloth_shoes_16.png","atk":"","matk":"","ind":0,"pdef":"2052~1998","mdef":"","str":0,"intel":25,"vit":0,"spr":25,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +4%　最大HP +225%","skills":[],"explain":["每1500点HP上限， 使自身增加100点物理防御力。 (最多增加3000点)","每1500点MP最大值， 使自身增加100点魔法防御力。 (最多增加3000点)"],"set":""},{"id":100260109,"name":"怒海狂鲨短靴","level":75,"slot":"shoes","armor":"leather","wg":"","type":"皮甲鞋","icon":"/assets/icons/sprite_item_new_equipment_03_leather_shoes_leather_shoes_16.png","atk":"","matk":"","ind":0,"pdef":"1104~996","mdef":"","str":21,"intel":21,"vit":0,"spr":23,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　水属性攻击 +20%　水属性抗性 +30%","skills":[],"explain":["被攻击时， 有20%的几率对500px内的所有敌人赋予冰属性， 效果持续5秒。"],"set":""},{"id":100270133,"name":"混元武士的咒蕴短靴","level":75,"slot":"shoes","armor":"light","wg":"","type":"轻甲鞋","icon":"/assets/icons/sprite_item_new_equipment_04_larmor_shoes_larmor_shoes_16.png","atk":"","matk":"","ind":0,"pdef":"1656~1494","mdef":"","str":55,"intel":47,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%　最大HP +200%　最大MP +200%","skills":[],"explain":["装备后， 每30秒会使自身进入诅咒状态。","装备时， 会增加自身10%的移动速度、 90点物理攻击力和魔法攻击力， 以及90点独立攻击力。"],"set":""},{"id":100280109,"name":"逆龙之战急速短靴","level":75,"slot":"shoes","armor":"heavy","wg":"","type":"重甲鞋","icon":"/assets/icons/sprite_item_new_equipment_05_harmor_shoes_harmor_shoes_16.png","atk":"","matk":"","ind":0,"pdef":"2208~1992","mdef":"","str":73,"intel":67,"vit":71,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +7%","skills":[],"explain":["力量、智力 +3%。","前冲状态下， 使自身进入霸体状态。","前冲时， 增加自身15%的攻击速度和移动速度， 效果持续10秒。 (冷却时间10秒)","(解除装备后效果消失)"],"set":""},{"id":100290063,"name":"圣堂骑士的赐福战靴","level":75,"slot":"shoes","armor":"plate","wg":"","type":"板甲鞋","icon":"/assets/icons/sprite_item_new_equipment_06_plate_shoes_plate_shoes_16.png","atk":"","matk":"","ind":0,"pdef":"2760~2490","mdef":"","str":21,"intel":21,"vit":23,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"移动速度 +6%","skills":[],"explain":["攻击时， 可以使500px范围内的队员恢复2%的HP。 (冷却时间5秒)","攻击时， 使500px范围内包括自己在内的队员进入加速状态10秒； 加速状态下， 增加10%的移动速度和攻击速度。 (冷却时间20秒)","(解除装备后效果消失)"],"set":""},{"id":100310605,"name":"金镶玉翠手镯","level":75,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_99.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"4416~3984","str":34,"intel":0,"vit":84,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +10%　魔法暴击 +10%","skills":[],"explain":[],"set":""},{"id":100310869,"name":"金镶玉翠项链","level":75,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_107.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"7360~6640","str":0,"intel":34,"vit":0,"spr":84,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":["所有技能冷却时间 -5%。"],"set":""},{"id":100320585,"name":"灼魂之戒","level":75,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_138.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"2944~2656","str":70,"intel":70,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"火属性抗性 +18%　火属性攻击 +31%","skills":[],"explain":["攻击时， 有3%的几率使敌人进入灼伤状态， 效果持续7秒。","被攻击时， 有20%的几率通过消耗一个红色小晶体召唤出1只Lv81的中级精灵瑟利斯特， 效果持续60秒。"],"set":""},{"id":100320586,"name":"冰雪精灵的凝霜指环","level":75,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_139.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"2944~2656","str":70,"intel":70,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性抗性 +18%　水属性攻击 +31%","skills":[],"explain":["攻击时， 有3%的几率使敌人进入冰冻状态， 效果持续3秒。","被攻击时， 有20%的几率通过消耗一个蓝色小晶体召唤出1只Lv81的中级精灵拉特利亚， 效果持续60秒。"],"set":""},{"id":100320587,"name":"暗隐之王指环","level":75,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_140.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"2944~2656","str":70,"intel":70,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"暗属性抗性 +18%　暗属性攻击 +31%","skills":[],"explain":["攻击时， 有3%的几率使敌人进入失明状态， 效果持续3秒。","被攻击时有20%的几率通过消耗一个黑色小晶体召唤出一只Lv81的中级精灵希德， 效果持续60秒。"],"set":""},{"id":100320588,"name":"圣光之灵","level":75,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_141.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"2944~2656","str":70,"intel":70,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"光属性抗性 +18%　光属性攻击 +31%","skills":[],"explain":["攻击时， 有3%的几率使敌人进入感电状态， 效果持续7秒。","被攻击时， 有20%的几率通过消耗一个白色小晶体召唤出1只Lv81的中级精灵艾丽西娅， 效果持续60秒。"],"set":""},{"id":100320696,"name":"金镶玉翠指环","level":75,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_146.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"2944~2656","str":50,"intel":50,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +7%　移动速度 +5%","skills":[],"explain":[],"set":""},{"id":100350007,"name":"泰拉神石","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_54.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":124,"intel":124,"vit":124,"spr":124,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350013,"name":"杰克超级爆弹","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_60.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":49,"intel":49,"vit":49,"spr":49,"elem":"","addDmg":0,"incDmg":0,"affix":"火属性攻击 +45%　火属性抗性 +18%","skills":[],"explain":[],"set":""},{"id":100350014,"name":"寒霜之雪","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_61.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":49,"intel":49,"vit":49,"spr":49,"elem":"","addDmg":0,"incDmg":0,"affix":"水属性攻击 +45%　水属性抗性 +18%","skills":[],"explain":[],"set":""},{"id":100350015,"name":"光电驱影石","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_62.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":49,"intel":49,"vit":49,"spr":49,"elem":"","addDmg":0,"incDmg":0,"affix":"光属性攻击 +45%　光属性抗性 +18%","skills":[],"explain":[],"set":""},{"id":100350016,"name":"暗夜幽魂石","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_63.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":49,"intel":49,"vit":49,"spr":49,"elem":"","addDmg":0,"incDmg":0,"affix":"暗属性攻击 +45%　暗属性抗性 +18%","skills":[],"explain":[],"set":""},{"id":100350017,"name":"高级精灵的精炼宝石","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_64.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":49,"intel":49,"vit":49,"spr":49,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +36%　all elemental resistance +14%","skills":[],"explain":[],"set":""},{"id":100350050,"name":"灵石玉髓 - 剑圣","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[破空拔刀斩] +2级","[破军斩龙击] +2级"],"explain":["[破军斩龙击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[破空拔刀斩]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350051,"name":"灵石玉髓 - 狱血魔神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[血气爆发] +2级","[灭魂之手] +2级"],"explain":["[灭魂之手]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[血气爆发]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350052,"name":"灵石玉髓 - 弑魂","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[墓碑三绝阵] +2级","[冰晶之萨亚] +2级"],"explain":["施放[冰晶之萨亚]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[墓碑三绝阵]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350053,"name":"灵石玉髓 - 大暗黑天","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[极炎 · 裂波剑] +2级","[极冰 · 裂波剑] +2级"],"explain":["[极冰·裂波剑]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[极炎·裂波剑]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350054,"name":"灵石玉髓 - 百花缭乱","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[究极念气罩] +2级","[狂狮怒吼] +2级"],"explain":["施放[究极念气罩]时， 有50%的几率发动提升Lv2或Lv4的该技能。","[狂狮怒吼]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350055,"name":"灵石玉髓 - 武神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[破碎拳] +2级","[升龙霸拳] +2级"],"explain":["[破碎拳]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[升龙霸]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350056,"name":"灵石玉髓 - 毒王","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[猛毒擒月炎] +2级","[爆碎砖裂] +2级"],"explain":["[猛毒擒月炎]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[爆碎砖袭]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350057,"name":"灵石玉髓 - 暴风眼","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[空绞连锤] +2级","[死亡摇篮] +2级"],"explain":["[空绞连锤]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[死亡摇篮]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350058,"name":"灵石玉髓 - 狂虎帝","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[念之战矛] +2级","[冲云念气场] +2级"],"explain":["施放[念之战矛]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[冲云念气场]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350059,"name":"灵石玉髓 - 武极","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[旋风碎心踢] +2级","[霹雳三重踢] +2级"],"explain":["[旋风碎心踢]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[霹雳三重踢]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350060,"name":"灵石玉髓 - 千手罗汉","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[千丝乱舞] +2级"],"explain":["施放[爆破黏球]时， 有50%的几率发动提升Lv2或Lv4的该技能。","[千丝乱舞]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350061,"name":"灵石玉髓 - 风林火山","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[彗星冲击] +2级","[武莲华] +2级"],"explain":["[彗星冲击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[武莲华]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350062,"name":"灵石玉髓 - 枪神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[回旋劫击] +2级","[极限多重爆头] +2级"],"explain":["[回旋劫击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[极限多重爆头]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350063,"name":"灵石玉髓 - 狂暴者","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[寒冰喷射器] +2级","[FM-92 SW刺弹炮] +2级"],"explain":["[寒冰喷射器]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[FM-92 SW刺弹炮]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350064,"name":"灵石玉髓 - 机械战神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[Ez-10反击者] +2级","[Ex-S Zero毒蛇炮] +2级"],"explain":["[Ez-10反击者]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[Ex-S Zero毒蛇炮]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350065,"name":"灵石玉髓 - 大将军","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[C4飞速炸弹] +2级","[M-61地雷] +2级"],"explain":["施放[M-61地雷]时， 有50%的几率发动提升Lv2或Lv4的该技能。","[C4飞速炸弹]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350066,"name":"灵石玉髓 - 沾血蔷薇","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[炽焰劫击] +2级","[极限多重爆头] +2级"],"explain":["[炽焰劫击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[极限多重爆头]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350067,"name":"灵石玉髓 - 重炮掌控者","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[寒冰喷射器] +2级","[FM-92 mk2 SW榴弹] +2级"],"explain":["[寒冰喷射器]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[FM-92 mk2 SW榴弹]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350068,"name":"灵石玉髓 - 机械之心","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[Ez-10反击者] +2级","[Ex-S Zero毒蛇炮] +2级"],"explain":["[Ez-10反击者]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[Ex-S Zero毒蛇炮]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350069,"name":"灵石玉髓 - 战争女神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[C4飞速炸弹] +2级","[M-61地雷] +2级"],"explain":["施放[M-61地雷]时， 有50%的几率发动提升Lv2或Lv4的该技能。","[C4飞速炸弹]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350070,"name":"灵石玉髓 - 大魔导师","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[光电冰墙] +2级","[虚无火山] +2级"],"explain":["施放[光电冰墙]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[虚无火山]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350071,"name":"灵石玉髓 - 月之女皇 (火)","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 瑟利斯特] +2级"],"explain":["施放[精灵召唤 : 瑟利斯特]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[契约召唤 : 愤怒的桑德尔]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350072,"name":"灵石玉髓 - 月之女皇 (冰)","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 拉特利亚] +2级"],"explain":["施放[精灵召唤 : 拉特利亚]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[契约召唤 : 愤怒的桑德尔]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350073,"name":"灵石玉髓 - 月之女皇 (光)","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 艾丽西娅] +2级"],"explain":["施放[精灵召唤 : 艾丽西娅]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[契约召唤 : 愤怒的桑德尔]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350074,"name":"灵石玉髓 - 月之女皇 (暗)","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[契约召唤 : 愤怒的桑德尔] +2级","[精灵召唤 : 希德] +2级"],"explain":["施放[精灵召唤 : 希德]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[契约召唤 : 愤怒的桑德尔]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350075,"name":"灵石玉髓 - 贝亚娜斗神","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[流星雷连击] +2级","[炫纹碎霸] +2级"],"explain":["[炫纹碎霸]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[流星雷连击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350076,"name":"灵石玉髓 - 魔术师","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[弹跳旋转扫把] +2级","[超级苍蝇拍] +2级"],"explain":["施放[超级苍蝇拍]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[弹跳旋转扫把]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350077,"name":"灵石玉髓 - 天启者","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[圣光琉璃碎] +2级","[双子沁盾] +2级"],"explain":["施放[双子沁盾]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[圣光琉璃碎]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350078,"name":"灵石玉髓 - 神之手","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[刺拳狂击] +2级","[破魂组合拳] +2级"],"explain":["[刺拳狂击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[破魂组合拳]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350079,"name":"灵石玉髓 - 龙斗士","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[狂暴锤击] +2级","[式神 : 真玄武] +2级"],"explain":["施放[式神 : 真玄武]时， 有50%的几率发动提升Lv2或Lv4的该技能。","[狂暴锤击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350080,"name":"灵石玉髓 - 末日审判者","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[地狱之门] +2级","[末日浩劫] +2级"],"explain":["施放[地狱之门]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[末日浩劫]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350081,"name":"灵石玉髓 - 银月","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[陨落螺旋刺] +2级","[旋刃冲击] +1级"],"explain":["[旋刃冲击]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。","[陨落螺旋刺]攻击时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350082,"name":"灵石玉髓 - 灵魂收割者","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[死灵之缚] +1级","[释魂暗劲波] +2级"],"explain":["施放[死灵之缚]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[释魂暗劲波]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350083,"name":"灵石玉髓 - 魔皇","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[元素浓缩球] +2级","[元素幻灭] +2级"],"explain":["施放[元素浓缩球]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[元素幻灭]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350084,"name":"灵石玉髓 - 冰冻之心","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":109,"intel":109,"vit":109,"spr":109,"elem":"","addDmg":0,"incDmg":0,"affix":"所有属性强化 +30%　物理暴击 +15%　魔法暴击 +15%","skills":["[冰凌破] +2级","[千里冰封] +2级"],"explain":["施放[冰凌破]时， 有50%的几率发动提升Lv2或Lv4的该技能。","施放[千里冰封]时， 有50%的几率发动提升Lv2或Lv4的该技能。"],"set":""},{"id":100350085,"name":"心灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350086,"name":"蓝灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350087,"name":"圣灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350088,"name":"赤灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350089,"name":"青灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350090,"name":"云灵玉髓","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_66.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":47,"intel":47,"vit":47,"spr":47,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":[],"explain":[],"set":""},{"id":100350577,"name":"真男人的证明","level":75,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_112.png","atk":"","matk":"","ind":0,"pdef":"","mdef":"","str":106,"intel":106,"vit":106,"spr":106,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　施放速度 +7%　移动速度 +5%　最大HP +300%　最大MP +300%","skills":["[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级","[强化 - 基础精通] +2级","[基础精通] +5级","[不屈意志] +5级"],"explain":[],"set":""},{"id":101000196,"name":"幸运7","level":75,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_106.png","atk":"1065~915","matk":"983~833","ind":520,"pdef":"","mdef":"","str":77,"intel":58,"vit":0,"spr":0,"elem":"","addDmg":17,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +7%　物理暴击 +7%","skills":[],"explain":["攻击时附加17%的伤害。","攻击时， 有7%的几率对敌人附加77%的伤害。","HP为77%以下时，若受到攻击，会有7%的几率使自己恢复77%的HP和MP。","施放[受身蹲伏]时， 有77%的几率使自身进入霸体状态，效果持续7秒。"],"set":""},{"id":101000320,"name":"无影剑 - 艾格斯","level":75,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_129.png","atk":"893~693","matk":"1081~881","ind":572,"pdef":"","mdef":"","str":0,"intel":64,"vit":0,"spr":0,"elem":"","addDmg":15,"incDmg":0,"affix":"施放速度 +2%　魔法暴击 +7%","skills":[],"explain":["攻击时， 附加15%的伤害。","光属性攻击时， 增加25%的暴击伤害。","受到光属性攻击时， 会赋予自身武器光属性， 效果持续120秒。"],"set":""},{"id":101010325,"name":"独孤玄铁剑 - 无锋","level":75,"slot":"weapon","armor":"","wg":"lswd","type":"光剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_lswd_lswd_118.png","atk":"1129~929","matk":"846~646","ind":572,"pdef":"","mdef":"","str":174,"intel":0,"vit":100,"spr":0,"elem":"","addDmg":0,"incDmg":50,"affix":"攻击速度 -29%　施放速度 -2%　移动速度 -10%","skills":[],"explain":["攻速 -20%","近距离攻击力 +50%"],"set":""},{"id":101020254,"name":"赫格尼之剑","level":75,"slot":"weapon","armor":"","wg":"katana","type":"太刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_katana_katana_115.png","atk":"893~693","matk":"987~787","ind":572,"pdef":"","mdef":"","str":58,"intel":88,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　施放速度 +4%　硬直 -1%　物理暴击 +15%　魔法暴击 +15%","skills":[],"explain":["攻击时， 有5%的几率使敌人进入出血状态。","攻击出血状态的敌人时， 增加40%的暴击伤害。"],"set":""},{"id":101030211,"name":"不从之神","level":75,"slot":"weapon","armor":"","wg":"club","type":"钝器","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_club_club_102.png","atk":"940~796","matk":"812~688","ind":520,"pdef":"","mdef":"","str":88,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -3%　硬直 +1%","skills":[],"explain":["↑↓+[宠物技能键]输入时， 可以随机发动一种特殊效果， 效果持续20秒。（消耗2个无色小晶块；冷却时间20秒）","- 武器发出蓝光且被击时免疫所有伤害； 同时攻击时附加40%的伤害。","- 使自身进入霸体状态； 破招攻击时， 附加40%的伤害。","- 使自身进入伪装状态， 背击攻击时， 附加40%的伤害。","攻击时， 有2%的几率使敌人进入眩晕状态。"],"set":""},{"id":101040144,"name":"歃血之怨","level":75,"slot":"weapon","armor":"","wg":"beamswd","type":"巨剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_beamswd_beamswd_95.png","atk":"875~675","matk":"846~646","ind":572,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%","skills":[],"explain":["攻击时， 使敌人进入出血状态。","攻击出血状态的敌人时， 附加40%的伤害。","攻击出血状态的敌人时， 可以使自身进入祝福状态。","攻击出血状态的敌人时， 可以使自身进入加速状态。"],"set":""},{"id":102000132,"name":"虎王之坦","level":75,"slot":"weapon","armor":"","wg":"knuckle","type":"拳套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_knuckle_knuckle_118.png","atk":"893~693","matk":"1081~881","ind":572,"pdef":"","mdef":"","str":0,"intel":58,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":25,"affix":"攻击速度 +10%　施放速度 +2%　魔法暴击 +3%","skills":["[念气环绕] 攻击力+40%","[念兽 : 龙虎啸] 攻击力+40%","[念气环绕] 攻击力+40%","[念兽 : 龙虎啸] 攻击力+40%"],"explain":["近距离武器攻击力 +25%","[念兽 : 龙虎啸]攻击力 +40%","[念气环绕]攻击力 +40%"],"set":""},{"id":102010188,"name":"铁拳制裁臂铠","level":75,"slot":"weapon","armor":"","wg":"gauntlet","type":"臂铠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_gauntlet_gauntlet_102.png","atk":"1026~869","matk":"769~652","ind":520,"pdef":"","mdef":"","str":88,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -8%　硬直 +1%","skills":["[膝击] +5级","[浮空凌云踢] +4级","[暴力抓取] +1级","[死亡旋律] +2级","[地狱风火轮] +4级","[背摔] +5级","[螺旋彗星落] +4级","[暴力抓取] +1级","[末日风暴] +2级","[地狱摇篮] +4级"],"explain":["背击伤害 +30%"],"set":""},{"id":102020123,"name":"路易斯的毒王血爪","level":75,"slot":"weapon","armor":"","wg":"claw","type":"爪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_claw_claw_108.png","atk":"941~741","matk":"941~741","ind":572,"pdef":"","mdef":"","str":58,"intel":29,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"物理暴击 +3%","skills":["[爪精通] +3级","[罗网投掷] +3级","[砖块投掷] +3级","[毒针投掷] +3级","[爪精通] +3级","[投网] +3级","[砖袭] +3级","[毒影针] +3级"],"explain":["攻击出血状态的敌人时， 附加30%的伤害。","被攻击时， 使自身进入霸体状态5秒。"],"set":""},{"id":102030149,"name":"黑暗契约者","level":75,"slot":"weapon","armor":"","wg":"tonfa","type":"东方棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_tonfa_tonfa_101.png","atk":"812~688","matk":"855~724","ind":520,"pdef":"810~810","mdef":"","str":58,"intel":88,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +5%　硬直 +2%　stuck resistance +3%　暗属性攻击 +35%","skills":[],"explain":["HP低于100%时， 增加10%的攻击速度、 施放速度和移动速度。","HP低于100%时， 增加20点暗属性强化值。","HP低于100%时， 增加20%的伤害。"],"set":""},{"id":102040096,"name":"电光石火之拳","level":75,"slot":"weapon","armor":"","wg":"bglove","type":"手套","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_fighter_bglove_bglove_92.png","atk":"897~760","matk":"812~688","ind":520,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +15%　移动速度 +5%　硬直 +2%　光属性攻击 +15%","skills":["[铁山靠] +4级","[强拳] +2级","[闪电之舞] +4级","[柔化肌肉] +2级","[铁山靠] +4级","[强拳] +2级","[闪电之舞] +4级","[柔化肌肉] +2级"],"explain":["攻击速度 +5%","攻击时， 有2%的几率使敌人进入眩晕状态。","施放[铁山靠]时， 有50%的几率不受冷却时间影响。","施放[闪电之舞]时， 有50%的几率不受冷却时间影响。","↑↓+[宠物技能键]输入时， 可以减少[闪电之舞]90%的冷却时间和50%的攻击力。 (消耗1个白色小晶块)"],"set":""},{"id":104000150,"name":"仇之杀","level":75,"slot":"weapon","armor":"","wg":"revolver","type":"左轮枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_revolver_revolver_98.png","atk":"800~662","matk":"673~557","ind":520,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"水属性","addDmg":0,"incDmg":30,"affix":"物理暴击 +2%","skills":["[回头一击] 冷却-50%","[复仇反击] 冷却-50%","[回头一击] 冷却-50%","[复仇反击] 冷却-50%"],"explain":["施放[复仇反击]时， 使自身增加20%的物理攻击力， 效果持续60秒。","[复仇反击]冷却时间 -50%","[回头一击]冷却时间 -50%","近距离武器攻击力 +30%"],"set":""},{"id":104010134,"name":"游戏制作人专用手枪","level":75,"slot":"weapon","armor":"","wg":"automatic","type":"自动手枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_automatic_automatic_105.png","atk":"617~417","matk":"904~704","ind":572,"pdef":"","mdef":"","str":0,"intel":58,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 -1%","skills":["[RX-78追击者] +5级，攻击力+30%，冷却-30%","[Ez-8自爆者] +5级，攻击力+30%，冷却-30%，范围+30%","[机械改良] +3级","[机械引爆] +2级","[Ez-10反击者] +3级","[RX-78追击者] +5级，攻击力+30%，冷却-30%","[Ez-8自爆者] +5级，攻击力+30%，冷却-30%，范围+30%","[机械改良] +3级","[机械引爆] +2级","[Ez-10反击者] +3级"],"explain":["[RX-78追击者]冷却时间 -30%","[Ez-8自爆者]冷却时间 -30%","[RX-78追击者]爆炸范围 +30%","[Ez-8自爆者]爆炸范围 +30%","[RX-78追击者]攻击力 +30%","[Ez-8自爆者]攻击力 +30%","被攻击时， 嗜战追击者和危机追击者的召唤几率增加100%。"],"set":""},{"id":104020141,"name":"江山略 - 战弩","level":75,"slot":"weapon","armor":"","wg":"bowgun","type":"手弩","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_bowgun_bowgun_97.png","atk":"673~557","matk":"747~619","ind":520,"pdef":"","mdef":"","str":58,"intel":29,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +2%　硬直 +1%　物理暴击 +3%","skills":[],"explain":["↑↓+[宠物技能键]输入时， 可以随机发动一种特殊效果， 效果持续20秒。（消耗2个无色小晶块； 冷却时间20秒）","- 武器发出蓝光且被击时免疫所有伤害； 同时攻击时附加40%的伤害。","- 使自身进入霸体状态； 破招攻击时，附加40%的伤害。","- 使自身进入伪装状态， 同时所有队员增加40点的所有属性强化值。"],"set":""},{"id":104030147,"name":"雷明顿一号","level":75,"slot":"weapon","armor":"","wg":"musket","type":"步枪","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_musket_musket_102.png","atk":"859~711","matk":"747~619","ind":520,"pdef":"","mdef":"","str":58,"intel":88,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"","skills":["[爆炎弹] +3级","[冰冻弹] +3级","[银弹] +3级","[弹药改良] +2级","[散弹枪] +3级","[破甲弹] +3级","[爆炎弹] +3级","[冰冻弹] +3级","[银弹] +3级","[散弹枪] +3级","[破甲弹] +3级","[子弹精通] +2级"],"explain":["[银弹]、 [冰冻弹]、 [爆炎弹]、 [破甲弹]冷却时间 -50%","[聚合弹]步枪消耗的属性弹数量 +50%","[聚合弹]攻击力 +50%","[散弹枪]攻击力 +50%"],"set":""},{"id":104040153,"name":"天才遗作 - 手炮","level":75,"slot":"weapon","armor":"","wg":"hcannon","type":"手炮","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_gunner_hcannon_hcannon_124.png","atk":"1027~827","matk":"617~417","ind":572,"pdef":"","mdef":"","str":88,"intel":0,"vit":0,"spr":0,"elem":"火属性","addDmg":25,"incDmg":0,"affix":"攻击速度 +10%　移动速度 +5%","skills":["[M-137格林机枪] +2级，施放后僵直时间 -50%","[重火器精通] +1级","[X-1压缩量子炮] +2级","[M-137格林机枪] +2级，施放后僵直时间 -50%","[重火器精通] +1级","[X-1压缩量子炮] +2级"],"explain":["攻击速度 +10%","[M-137格林机枪]施放后僵直时间 -50%","[压缩量子炮]蓄电时间上限 -40%","[压缩量子炮]聚怪范围 +40%","攻击时， 附加25%的伤害。"],"set":""},{"id":106000088,"name":"武斗之花 - 独秀","level":75,"slot":"weapon","armor":"","wg":"spear","type":"矛","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_spear_spear_116.png","atk":"1026~869","matk":"726~615","ind":520,"pdef":"","mdef":"","str":88,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":25,"incDmg":0,"affix":"攻击速度 -5%　硬直 +1%　物理暴击 +2%","skills":["[矛精通] +1级"],"explain":["攻击时， 附加25%的伤害。","施放[天击]、 [龙牙]时， 使自身进入霸体状态。","施放[魔法旋风]时， 使自身进入霸体状态。","攻击时， 有5%的几率使自身进入霸体状态20秒。 (冷却时间20秒)"],"set":""},{"id":106010123,"name":"万夫莫敌","level":75,"slot":"weapon","armor":"","wg":"rod","type":"魔杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_rod_rod_105.png","atk":"769~652","matk":"940~796","ind":520,"pdef":"","mdef":"","str":0,"intel":88,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　施放速度 +10%　硬直 -1%　光属性攻击 +35%　水属性攻击 +35%　all activestatus resistance +30%","skills":["[移动施法] 移动速度+20%."],"explain":["[移动施法]移动速度+20%.","施放[瞬移]时，可以使自身进入霸体状态1.5秒。","被攻击时，增加30点所有异常状态抗性和发动霸体BUFF，并且攻击时增加25%的伤害。（持续时间30秒，冷却时间30秒）"],"set":""},{"id":106020089,"name":"闪耀的魔法少女棒","level":75,"slot":"weapon","armor":"","wg":"pole","type":"棍","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_pole_pole_104.png","atk":"923~782","matk":"769~652","ind":520,"pdef":"","mdef":"","str":58,"intel":58,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 +1%","skills":["[棍棒精通] +5级","[变身贝亚娜] +3级，冷却-50%"],"explain":["攻击速度 +5%","施放[变身贝亚娜]时，不需要炫纹。","[变身贝雅娜]冷却时间 -50%"],"set":""},{"id":106030124,"name":"江山略 - 法杖","level":75,"slot":"weapon","armor":"","wg":"staff","type":"法杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_staff_staff_115.png","atk":"812~688","matk":"1026~869","ind":520,"pdef":"","mdef":"","str":0,"intel":58,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -10%","skills":[],"explain":["↑↓+[宠物技能键]输入时，可以随机发动一种特殊效果，效果持续20秒。（消耗2个无色小晶块；冷却时间20秒）","-武器发出蓝光且被击时免疫所有伤害；同时攻击时附加40%的伤害。","-使自身进入霸体状态；破招攻击时，附加40%的伤害。","-使自身进入伪装状态，同时所有队员增加40点的所有属性强化值。"],"set":""},{"id":106040093,"name":"魔女的南瓜扫把","level":75,"slot":"weapon","armor":"","wg":"broom","type":"扫帚","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_mage_broom_broom_91.png","atk":"941~741","matk":"1034~834","ind":572,"pdef":"","mdef":"","str":0,"intel":65,"vit":0,"spr":0,"elem":"","addDmg":20,"incDmg":0,"affix":"攻击速度 +6%　移动速度 +3%　火属性攻击 +35%","skills":["[亲和 - 杰克爆弹] +5级","[熔岩药瓶] +5级","[暴炎加热炉] +5级"],"explain":["攻击时， 附加22%的伤害。"],"set":""},{"id":108000101,"name":"无尽之贪欲","level":75,"slot":"weapon","armor":"","wg":"cross","type":"十字架","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_cross_cross_95.png","atk":"855~724","matk":"812~688","ind":520,"pdef":"810~810","mdef":"810~810","str":0,"intel":58,"vit":70,"spr":70,"elem":"","addDmg":30,"incDmg":0,"affix":"施放速度 +2%　移动速度 +2%","skills":[],"explain":["攻击时，附加30%的伤害量。"],"set":""},{"id":108010087,"name":"神兽之护","level":75,"slot":"weapon","armor":"","wg":"rosary","type":"念珠","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_rosary_rosary_89.png","atk":"769~652","matk":"983~833","ind":520,"pdef":"","mdef":"","str":0,"intel":88,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 -5%　施放速度 +5%　魔法暴击 +2%　所有属性强化 +35%","skills":["[式神 : 玄武] +2级，持续+35%，移动速度 +35%","[式神 : 白虎] +3级，攻击力+35%","[苍龙击] +1级，攻击力+35%","[朱雀符] +2级，攻击力+35%"],"explain":["[朱雀符]大小 +35%","[朱雀符]攻击力 +35%","[式神 : 白虎]白虎珠大小 +35%","[式神 : 白虎]光环范围 +35%","[式神 : 白虎]攻击力 +35%","[式神 : 玄武]移动速度 +35%","[式神 : 玄武]抓取时间 +35%","[苍龙逐日]攻击力+35%"],"set":""},{"id":108020083,"name":"风驰电掣 - 连袭","level":75,"slot":"weapon","armor":"","wg":"totem","type":"图腾","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_totem_totem_102.png","atk":"897~760","matk":"769~652","ind":520,"pdef":"","mdef":"","str":88,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +1%","skills":[],"explain":["根据当前的连击次数触发攻击加速Buff，效果持续10秒，效果随着连击次数的增加而增加。","-12连击:攻击速度 +10%、力量 +50","-32连击:攻击速度 +20%、力量 +100","-60连击:攻击速度 +30%、力量 +150","-120连击:攻击速度 +40%、力量 +200","-达到120连击时，可以重置自身技能的冷却时间，但只能重置一个剩余冷却时间最长的技能。（冷却时间10秒）"],"set":""},{"id":108030081,"name":"混元之斧","level":75,"slot":"weapon","armor":"","wg":"axe","type":"斧","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_axe_axe_98.png","atk":"1026~869","matk":"726~615","ind":520,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"硬直 +2%","skills":[],"explain":["攻击时，增加6%的物理和魔法攻击力，效果持续60秒。（最多重叠10次；冷却时间6秒）","被攻击时，降低自身4%的物理和魔法防御力，效果持续60秒。（最多重叠10次；冷却时间6秒）"],"set":""},{"id":108040103,"name":"锁龙骨","level":75,"slot":"weapon","armor":"","wg":"scythe","type":"镰刀","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_priest_scythe_scythe_96.png","atk":"812~688","matk":"855~724","ind":520,"pdef":"","mdef":"","str":58,"intel":58,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"攻击速度 +8%　物理暴击 +2%　魔法暴击 +2%","skills":[],"explain":["攻击时，有4%的几率附加444%的伤害。","每2点光属性强化，可以增加1点暗属性强化。"],"set":""},{"id":109000102,"name":"沾血之魂","level":75,"slot":"weapon","armor":"","wg":"dagger","type":"匕首","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_dagger_dagger_121.png","atk":"798~636","matk":"769~652","ind":520,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"","addDmg":0,"incDmg":0,"affix":"攻击速度 +10%　硬直 -1%　物理暴击 +10%","skills":[],"explain":["攻击时， 使敌人进入出血状态3秒； 出血状态下的敌人， 每0.5秒受到75点伤害。","攻击出血状态下敌人时， 附加35%的伤害。"],"set":""},{"id":109010094,"name":"超光速之刃","level":75,"slot":"weapon","armor":"","wg":"twinswd","type":"双剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_twinswd_twinswd_115.png","atk":"872~738","matk":"684~579","ind":520,"pdef":"","mdef":"","str":58,"intel":0,"vit":0,"spr":0,"elem":"光属性","addDmg":0,"incDmg":0,"affix":"移动速度 +5%　硬直 +2%　物理暴击 +5%　光属性攻击 +15%","skills":["[终结追击] +2级","[疾风乱舞] +4级","[雷光刃影] +4级"],"explain":["攻击速度 +5%","施放[疾风乱舞]时， 有50%的几率不受冷却时间影响。","施放[雷光刃影]时， 有50%的几率不受冷却时间影响。","↑↓+[宠物技能键]输入时， 可以减少[疾风乱舞]90%的冷却时间、 50%的攻击力， 效果持续60秒。 (消耗1个白色小晶块； 冷却时间60秒； 动后立即重置[疾风乱舞]的剩余冷却时间)"],"set":""},{"id":109020084,"name":"咒印巫师之杖","level":75,"slot":"weapon","armor":"","wg":"wand","type":"权杖","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_thief_wand_wand_120.png","atk":"738~585","matk":"983~833","ind":520,"pdef":"","mdef":"","str":0,"intel":0,"vit":0,"spr":0,"elem":"暗属性","addDmg":0,"incDmg":0,"affix":"魔法暴击 +5%　暗属性攻击 +40%","skills":["[驱使僵尸] +5级，攻击力+40%，冷却-30%，攻击次数 +80%，僵尸召唤数量上限 +100%，攻击间隔 -50%"],"explain":["[驱使僵尸]数量上限 +5","[驱使僵尸]攻击力 +40%","[驱使僵尸]冷却时间 -30%","[驱使僵尸]爆炸范围 +30%","[驱使僵尸]攻击间隔 -50%","[驱使僵尸]攻击次数 +80%"],"set":""}];

    const SLOT_ORDER = ['weapon','coat','shoulder','belt','pants','shoes','amulet','wrist','ring','magicstone','support'];
    const SLOT_LABEL = { weapon:'武器', coat:'上衣', shoulder:'头肩', belt:'腰带', pants:'下装', shoes:'鞋', amulet:'项链', wrist:'手镯', ring:'戒指', magicstone:'魔法石', support:'辅助装备' };

    // 武器类型 → 职业归属（按 DNF 职业可用武器）
    const WG_LABEL = {
        ssword:'短剑', katana:'太刀', lswd:'光剑', beamswd:'巨剑', club:'钝器',
        knuckle:'拳套', gauntlet:'臂铠', claw:'爪', tonfa:'东方棍', bglove:'手套',
        revolver:'左轮枪', automatic:'自动手枪', bowgun:'手弩', musket:'步枪', hcannon:'手炮',
        rod:'魔杖', staff:'法杖', pole:'棍', spear:'矛', broom:'扫帚',
        cross:'十字架', rosary:'念珠', totem:'图腾', axe:'斧', scythe:'镰刀',
        dagger:'匕首', twinswd:'双剑', wand:'权杖',
    };
    const WG_JOB = {};
    for (const [job, list] of Object.entries({
        '鬼剑士': ['ssword','katana','lswd','beamswd','club'],
        '格斗家': ['knuckle','gauntlet','claw','tonfa','bglove'],
        '神枪手': ['revolver','automatic','bowgun','musket','hcannon'],
        '魔法师': ['rod','staff','pole','spear','broom'],
        '圣职者': ['cross','rosary','totem','axe','scythe'],
        '暗夜使者': ['dagger','twinswd','wand'],
    })) for (const wg of list) WG_JOB[wg] = job;

    const POS_KEY = 'dnf_guide85_pos';
    // v5.84：分类维度对齐游戏内装备筛选（大类 → 二级维度）
    const CAT_DEFS = [['all', '全部'], ['weapon', '武器'], ['armor', '防具'], ['jewel', '首饰'], ['special', '特殊装备']];
    const CAT_SLOTS = {
        weapon: ['weapon'],
        armor: ['coat', 'pants', 'shoulder', 'belt', 'shoes'],
        jewel: ['amulet', 'wrist', 'ring'],
        special: ['magicstone', 'support'],
    };
    const JOB_ORDER = ['鬼剑士', '格斗家', '神枪手', '魔法师', '圣职者', '暗夜使者'];
    const PART_DEFS = [['all', '全部部位'], ['coat', '上衣'], ['pants', '下装'], ['shoulder', '头肩'], ['shoes', '鞋子'], ['belt', '腰带']];
    const ARMOR_DEFS = [['all', '全部甲种'], ['cloth', '布甲'], ['leather', '皮甲'], ['light', '轻甲'], ['heavy', '重甲'], ['plate', '板甲']];
    const JEWEL_DEFS = [['all', '全部'], ['wrist', '手镯'], ['amulet', '项链'], ['ring', '戒指']];
    const SPECIAL_DEFS = [['all', '全部'], ['magicstone', '魔法石'], ['support', '辅助装备']];
    let state = { q:'', cat:'all', job:'all', part:'all', armor:'all', jewel:'all', special:'all', open:false, detail:null,
        ostat:'all', oslot:'all', orar:'all' };
    // v5.87：图鉴分「装备 / 宝珠」两页，默认仍停在装备
    let atlasMode = 'equip';

    // ---------- 样式（对齐游戏内详情面板：暗棕金 + 紫色特效框） ----------
    function injectStyles() {
        if (document.getElementById('dnf-guide85-style')) return;
        const st = document.createElement('style');
        st.id = 'dnf-guide85-style';
        st.textContent = `
            .g85-capsule{position:fixed;right:16px;bottom:96px;z-index:1000010;display:flex;align-items:center;gap:7px;
                padding:8px 13px;border-radius:5px;cursor:pointer;user-select:none;touch-action:none;
                border:1px solid #6b5633;background:linear-gradient(180deg,#2e2516,#241d12);color:#f5c542;
                font:700 13px/1 "Microsoft YaHei",sans-serif;letter-spacing:.5px;
                box-shadow:0 4px 14px #0007, inset 0 1px 0 rgba(245,197,66,.12);
                transition:transform .12s ease, box-shadow .12s ease}
            .g85-capsule:hover{transform:translateY(-1px);border-color:#f5c542;box-shadow:0 6px 18px #0008,0 0 14px rgba(245,197,66,.22)}
            .g85-capsule .g85-dot{width:7px;height:7px;border-radius:50%;background:#f5c542;box-shadow:0 0 7px #f5c542}

            .g85-panel{position:fixed;right:16px;bottom:96px;z-index:1000011;width:min(366px,calc(100vw - 20px));height:min(620px,calc(100vh - 130px));
                display:flex;flex-direction:column;border-radius:6px;overflow:hidden;
                border:1px solid #5a4a2c;background:linear-gradient(180deg,#241d12,#1b150e);color:#f0e7d2;
                box-shadow:0 16px 48px #000a, inset 0 1px 0 rgba(245,197,66,.08);
                font:13px/1.5 "Microsoft YaHei","PingFang SC",sans-serif}
            .g85-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;
                background:linear-gradient(180deg,#2e2516,#241d12);border-bottom:1px solid #5a4a2c;touch-action:none;user-select:none}
            .g85-head b{font-size:14px;font-weight:800;letter-spacing:1px;white-space:nowrap;color:#f5c542;
                text-shadow:0 0 12px rgba(245,197,66,.35)}
            .g85-count{color:#b6a47e;font-size:11px;white-space:nowrap}
            .g85-x{margin-left:auto;width:25px;height:25px;display:grid;place-items:center;border-radius:4px;cursor:pointer;padding:0;
                border:1px solid #6b5633;background:#241d12;color:#e0d4b8;font:15px/1 "Microsoft YaHei",sans-serif}
            .g85-x:hover{background:#3a2f18;border-color:#f5c542;color:#f5c542}

            .g85-search{flex:0 0 auto;padding:8px 12px;border-bottom:1px solid #3d3120;background:#1b150e}
            .g85-search input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:4px;
                border:1px solid #5a4a2c;background:#241d12;color:#f0e7d2;font:13px/1 "Microsoft YaHei",sans-serif;outline:none}
            .g85-search input::placeholder{color:#8a7a58}
            .g85-search input:focus{border-color:#f5c542;box-shadow:0 0 0 2px rgba(245,197,66,.15)}

            .g85-chips{flex:0 0 auto;display:flex;gap:5px;padding:7px 12px;overflow-x:auto;background:#1b150e;border-bottom:1px solid #3d3120;
                scrollbar-width:none;cursor:grab;touch-action:pan-x;user-select:none}
            .g85-chips::-webkit-scrollbar{display:none}
            .g85-chips.dragging{cursor:grabbing}
            .g85-chips.dragging .g85-chip{pointer-events:none}
            .g85-chips.g85-sub2{background:#171109;border-bottom:1px solid #2e2516}
            .g85-chip{flex:0 0 auto;padding:4px 9px;border-radius:4px;cursor:pointer;white-space:nowrap;font-size:12px;
                border:1px solid #5a4a2c;background:#241d12;color:#b6a47e;transition:all .12s ease}
            .g85-chip:hover{border-color:#8a6f3d;color:#f0e7d2}
            .g85-chip.on{border-color:#f5c542;background:#3a2f18;color:#f5c542}

            .g85-list{flex:1 1 auto;overflow-y:auto;padding:5px 8px 10px}
            .g85-list::-webkit-scrollbar{width:6px}
            .g85-list::-webkit-scrollbar-thumb{background:#4a3c22;border-radius:3px}
            .g85-item{display:flex;gap:10px;align-items:center;padding:6px 6px;border-radius:4px;cursor:pointer;border:1px solid transparent}
            .g85-item:hover{background:#2e2516;border-color:#4a3c22}
            .g85-item img{width:34px;height:34px;image-rendering:pixelated;border-radius:3px;background:#14110b;border:1px solid #6b5633;object-fit:contain;flex:0 0 auto}
            .g85-item .g85-ph{width:34px;height:34px;border-radius:3px;background:#14110b;border:1px solid #6b5633;display:grid;place-items:center;color:#6b5633;font-size:15px;flex:0 0 auto}
            .g85-nm{font-size:13px;color:#ffb53d;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .g85-meta{font-size:11px;color:#b6a47e;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .g85-lv{flex:0 0 auto;font-size:10px;color:#9a8a66;border:1px solid #4a3c22;border-radius:3px;padding:0 4px;margin-left:auto}
            .g85-empty{padding:30px 10px;text-align:center;color:#8a7a58;font-size:12px}

            .g85-detail{flex:1 1 auto;overflow-y:auto;padding:10px 12px 16px;display:none}
            .g85-detail::-webkit-scrollbar{width:6px}
            .g85-detail::-webkit-scrollbar-thumb{background:#4a3c22;border-radius:3px}
            .g85-detail.show{display:block}
            .g85-list.hide{display:none}
            .g85-back{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#b6a47e;cursor:pointer;margin-bottom:9px}
            .g85-back:hover{color:#f5c542}
            .g85-dhead{display:flex;gap:10px;align-items:center;margin-bottom:7px}
            .g85-dhead img{width:46px;height:46px;image-rendering:pixelated;border-radius:4px;background:#14110b;border:1px solid #6b5633}
            .g85-dname{font-size:15.5px;font-weight:800;color:#ffb53d}
            .g85-dsub{font-size:11px;color:#b6a47e;margin-top:2px}
            .g85-attrs{font-size:12px;line-height:1.75;color:#f0e7d2;border-top:1px solid #3d3120;padding-top:7px}
            .g85-attrs .g85-line{margin:1px 0}
            .g85-effect{border:1px solid #b07bff;border-radius:5px;background:#966eff1f;padding:6px 8px;display:flex;flex-direction:column;gap:3px;margin:8px 0}
            .g85-effect-head{font-size:11px;font-weight:700;color:#c4a6ff}
            .g85-effect-line{font-size:12px;color:#d8c8ff;line-height:1.5}
            .g85-explain{font-size:11px;color:#b6a47e;white-space:pre-line;line-height:1.75;margin-top:8px;border-top:1px solid #3d3120;padding-top:7px}
            .g85-tabs{flex:0 0 auto;display:flex;gap:4px;padding:6px 12px 0;background:#1b150e}
            .g85-tab{padding:4px 12px;border:1px solid #5a4a2c;border-radius:4px 4px 0 0;cursor:pointer;
                font-size:12px;color:#b6a47e;user-select:none;transition:all .12s ease}
            .g85-tab:hover{color:#f0e7d2;border-color:#8a6f3d}
            .g85-tab.on{color:#f5c542;background:#2e2516;border-color:#f5c542}
            .g85-retry{margin-top:10px;padding:5px 14px;border-radius:4px;cursor:pointer;
                border:1px solid #6b5633;background:#2e2516;color:#f5c542;font:12px/1.4 "Microsoft YaHei",sans-serif}
            .g85-retry:hover{border-color:#f5c542}
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ---------- 工具 ----------
    function savePos(left, top) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
    }
    function loadPos() {
        try { const v = JSON.parse(localStorage.getItem(POS_KEY)); if (v && Number.isFinite(v.left) && Number.isFinite(v.top)) return v; } catch (_) {}
        return null;
    }
    function applyPos(el, left, top) {
        const w = el.offsetWidth || 200, h = el.offsetHeight || 44;
        left = Math.max(6, Math.min(left, innerWidth - Math.min(w, innerWidth - 12) - 6));
        top = Math.max(6, Math.min(top, innerHeight - Math.min(h, innerHeight - 12) - 6));
        Object.assign(el.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
        return { left, top };
    }
    let lastDragEnd = 0;
    function makeDraggable(el, handle) {
        let active = null, moved = false;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.isPrimary === false) return;
            if (e.target.closest('button, input, .g85-chip, [data-no-drag]')) return;
            const r = el.getBoundingClientRect();
            active = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            moved = false;
            handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', e => {
            if (!active || e.pointerId !== active.id) return;
            const dx = e.clientX - active.x, dy = e.clientY - active.y;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            moved = true;
            el.style.transition = 'none';
            applyPos(el, active.left + dx, active.top + dy);
        });
        const end = e => {
            if (!active || e.pointerId !== active.id) return;
            active = null;
            if (moved) {
                lastDragEnd = Date.now();
                savePos(parseFloat(el.style.left), parseFloat(el.style.top));
            }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    // 分类标签横向拖动：鼠标按住滑动 + 滚轮横滚。
    // 只在真正拖动后才 setPointerCapture，避免单击 chip 被重定向到容器、导致点不动标签。
    function makeChipsDraggable(el) {
        if (!el || el.dataset.dragReady === '1') return;
        el.dataset.dragReady = '1';
        let st = null;
        el.addEventListener('pointerdown', e => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            st = { x: e.clientX, left: el.scrollLeft || 0, id: e.pointerId, moved: false };
        });
        el.addEventListener('pointermove', e => {
            if (!st || e.pointerId !== st.id) return;
            const dx = e.clientX - st.x;
            if (!st.moved && Math.abs(dx) < 5) return;
            if (!st.moved) {
                st.moved = true;
                el.classList.add('dragging');
                try { el.setPointerCapture(e.pointerId); } catch (_) {}
            }
            el.scrollLeft = st.left - dx;
            e.preventDefault();
        });
        const end = e => {
            if (!st || e.pointerId !== st.id) return;
            st = null;
            el.classList.remove('dragging');
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        el.addEventListener('wheel', e => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            el.scrollLeft += e.deltaY;
            e.preventDefault();
        }, { passive: false });
    }

    // ---------- UI ----------
    let capsule = null, panel = null, listEl = null, detailEl = null, catWrap = null, subWrap = null, sub2Wrap = null, countEl = null, searchEl = null;

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function filtered() {
        const q = state.q.trim().toLowerCase();
        return ITEMS.filter(j => {
            if (state.cat !== 'all') {
                if (CAT_SLOTS[state.cat].indexOf(j.slot) === -1) return false;
                if (state.cat === 'weapon' && state.job !== 'all' && (WG_JOB[j.wg] || '') !== state.job) return false;
                if (state.cat === 'armor') {
                    if (state.part !== 'all' && j.slot !== state.part) return false;
                    if (state.armor !== 'all' && j.armor !== state.armor) return false;
                }
                if (state.cat === 'jewel' && state.jewel !== 'all' && j.slot !== state.jewel) return false;
                if (state.cat === 'special' && state.special !== 'all' && j.slot !== state.special) return false;
            }
            if (!q) return true;
            return j.name.toLowerCase().includes(q) || String(j.type || '').toLowerCase().includes(q) || String(j.wg || '').includes(q);
        });
    }

    function mainStat(j) {
        const bits = [];
        if (j.atk) bits.push('物理攻击 ' + j.atk);
        if (j.matk) bits.push('魔法攻击 ' + j.matk);
        if (!bits.length && j.pdef) bits.push('物理防御 ' + j.pdef);
        if (!bits.length && j.mdef) bits.push('魔法防御 ' + j.mdef);
        if (!bits.length && j.intel) bits.push('智力 +' + j.intel);
        return bits.join('　');
    }

    function renderList() {
        const arr = filtered();
        if (countEl) countEl.textContent = arr.length + ' / ' + ITEMS.length;
        listEl.innerHTML = '';
        if (!arr.length) {
            listEl.innerHTML = '<div class="g85-empty">没有匹配的装备</div>';
            return;
        }
        for (const j of arr) {
            const div = document.createElement('div');
            div.className = 'g85-item';
            div.innerHTML =
                (j.icon ? '<img loading="lazy" src="' + j.icon + '" alt="">' : '<div class="g85-ph">?</div>') +
                '<div style="min-width:0;flex:1 1 auto"><div class="g85-nm"></div><div class="g85-meta"></div></div>' +
                '<div class="g85-lv"></div>';
            div.querySelector('.g85-nm').textContent = j.name;
            div.querySelector('.g85-meta').textContent = (j.type || '') + (mainStat(j) ? '　' + mainStat(j) : '');
            div.querySelector('.g85-lv').textContent = 'Lv.' + j.level;
            div.addEventListener('click', () => openDetail(j));
            listEl.appendChild(div);
        }
    }

    // 属性行，文案与游戏内详情面板一致
    function attrLines(j) {
        const out = [];
        if (j.elem) out.push(j.elem + '属性武器');
        if (j.atk) out.push(' 物理攻击 ' + j.atk);
        if (j.matk) out.push(' 魔法攻击 ' + j.matk);
        if (j.ind) out.push(' 独立攻击力 ' + j.ind);
        if (j.pdef) out.push(' 物理防御 ' + j.pdef);
        if (j.mdef) out.push(' 魔法防御 ' + j.mdef);
        const four = [];
        if (j.str) four.push('力量 +' + j.str);
        if (j.intel) four.push('智力 +' + j.intel);
        if (j.vit) four.push('体力 +' + j.vit);
        if (j.spr) four.push('精神 +' + j.spr);
        if (four.length) out.push(four.join('　'));
        if (j.incDmg) out.push(' 伤害 +' + j.incDmg + '%');
        if (j.addDmg) out.push(' 攻击时，附加 ' + j.addDmg + '% 的伤害');
        if (j.affix) out.push(j.affix);
        return out;
    }

    function openDetail(j) {
        state.detail = j;
        listEl.classList.add('hide');
        detailEl.classList.add('show');

        let html = '<div class="g85-back">← 返回列表</div>' +
            '<div class="g85-dhead">' + (j.icon ? '<img src="' + j.icon + '" alt="">' : '<div class="g85-ph" style="width:46px;height:46px">?</div>') +
            '<div><div class="g85-dname"></div><div class="g85-dsub"></div></div></div>';

        const lines = attrLines(j);
        if (lines.length) {
            html += '<div class="g85-attrs">' + lines.map(s => '<div class="g85-line">' + esc(s) + '</div>').join('') + '</div>';
        }
        if (j.skills && j.skills.length) {
            html += '<div class="g85-effect"><div class="g85-effect-head">特殊效果</div>' +
                j.skills.map(s => '<div class="g85-effect-line">' + esc(s) + '</div>').join('') + '</div>';
        }
        if (j.explain && j.explain.length) {
            html += '<div class="g85-explain">' + esc(j.explain.join(String.fromCharCode(10))) + '</div>';
        }
        detailEl.innerHTML = html;
        detailEl.querySelector('.g85-dname').textContent = j.name;
        detailEl.querySelector('.g85-dsub').textContent = (j.type || '') + ' · 史诗 · Lv.' + j.level;
        detailEl.querySelector('.g85-back').addEventListener('click', backToList);
        detailEl.scrollTop = 0;
    }

    function backToList() {
        state.detail = null;
        detailEl.classList.remove('show');
        detailEl.innerHTML = '';
        listEl.classList.remove('hide');
    }

    function makeChip(wrap, label, on, onClick) {
        const c = document.createElement('div');
        c.className = 'g85-chip' + (on ? ' on' : '');
        c.textContent = label;
        c.addEventListener('click', () => onClick(c));
        wrap.appendChild(c);
        return c;
    }

    function fillChips(wrap, defs, activeKey, onPick, after) {
        wrap.innerHTML = '';
        for (const [key, label] of defs) {
            makeChip(wrap, label, String(activeKey) === String(key), c => {
                onPick(key);
                for (const x of wrap.querySelectorAll('.g85-chip')) x.classList.remove('on');
                c.classList.add('on');
                if (state.detail) backToList();
                (after || renderList)();
            });
        }
    }

    // 第一行：大类（全部 / 武器 / 防具 / 首饰 / 特殊装备），与游戏筛选一致
    function buildCatChips() {
        fillChips(catWrap, CAT_DEFS, state.cat, key => {
            state.cat = key;
            state.job = 'all';
            state.part = 'all';
            state.armor = 'all';
            state.jewel = 'all';
            state.special = 'all';
            buildSubChips();
            syncSubRows();
        });
    }

    // 第二行：随大类变化（武器=职业 / 防具=部位 / 首饰=类型 / 特殊装备=类型）
    function buildSubChips() {
        if (!subWrap) return;
        if (state.cat === 'all') { subWrap.innerHTML = ''; return; }
        if (state.cat === 'weapon') {
            fillChips(subWrap, [['all', '全部职业']].concat(JOB_ORDER.map(j => [j, j])), state.job, key => { state.job = key; });
        } else if (state.cat === 'armor') {
            fillChips(subWrap, PART_DEFS, state.part, key => { state.part = key; });
        } else if (state.cat === 'jewel') {
            fillChips(subWrap, JEWEL_DEFS, state.jewel, key => { state.jewel = key; });
        } else if (state.cat === 'special') {
            fillChips(subWrap, SPECIAL_DEFS, state.special, key => { state.special = key; });
        }
    }

    // 第三行：仅「防具」出现（甲种），与游戏「全部甲种 / 布甲 / 皮甲 / 轻甲 / 重甲 / 板甲」一致
    function buildSub2Chips() {
        if (!sub2Wrap) return;
        if (state.cat !== 'armor') { sub2Wrap.innerHTML = ''; return; }
        fillChips(sub2Wrap, ARMOR_DEFS, state.armor, key => { state.armor = key; });
    }

    function syncSubRows() {
        if (!subWrap || !sub2Wrap) return;
        subWrap.style.display = state.cat === 'all' ? 'none' : 'flex';
        sub2Wrap.style.display = state.cat === 'armor' ? 'flex' : 'none';
        buildSub2Chips();
    }

    /* ================= v5.87 宝珠图鉴 =================
     * 数据：GET /api/orbs 一次拿全量（161 条，需 Bearer dnf_idle_token）；
     * 图标：接口本身不带 icon_path，按 id 逐个 GET /api/items/{id} 取
     *       icon_path + icon_index 拼 sprite 文件名，串行 60ms 间隔，结果进
     *       localStorage（键 dnf_atlas_orbs_v587，带版本号 v:587，7 天过期）。
     * 全部失败只影响宝珠页，装备页与其它功能不受影响。
     * ================================================== */
    const ORB_CACHE_KEY = 'dnf_atlas_orbs_v587';
    const ORB_CACHE_VER = 587;
    const ORB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    const ORB_ICON_GAP_MS = 60;

    const ORB_STAT_LABEL = {
        str: '力量', intel: '智力', vit: '体力', spr: '精神',
        pAtkFlat: '物理攻击', mAtkFlat: '魔法攻击', pAtkPct: '物理攻击力', mAtkPct: '魔法攻击力',
        pDefFlat: '物理防御', mDefFlat: '魔法防御', hpMax: '生命值上限', mpMax: '魔法值上限',
        hpRegen: '生命值恢复', mpRegen: '魔法值恢复',
        atkSpd: '攻击速度', castSpd: '施放速度', moveSpd: '移动速度',
        elemEnh: '属性强化', elemRes: '属性抗性',
        critP: '物理暴击', critM: '魔法暴击', crit: '暴击',
        hitRate: '命中率', evasion: '回避率', dmgReduce: '伤害减免',
    };
    const ORB_PCT_KEYS = ['pAtkPct', 'mAtkPct', 'atkSpd', 'castSpd', 'moveSpd', 'elemEnh', 'elemRes',
        'critP', 'critM', 'crit', 'hitRate', 'evasion', 'dmgReduce'];
    const ORB_ELEM_LABEL = { fire: '火', light: '光', water: '水', dark: '暗', ice: '冰', all: '全' };
    const ORB_SLOT_LABEL = {
        weapon: '武器', coat: '上衣', pants: '下装', shoulder: '头肩', belt: '腰带', shoes: '鞋子',
        wrist: '手镯', amulet: '项链', ring: '戒指', support: '辅助装备', 'title name': '称号',
    };
    const ORB_SLOT_DEFS = [['all', '全部部位'], ['weapon', '武器'], ['coat', '上衣'], ['pants', '下装'],
        ['shoulder', '头肩'], ['belt', '腰带'], ['shoes', '鞋子'], ['wrist', '手镯'], ['amulet', '项链'],
        ['ring', '戒指'], ['support', '辅助装备'], ['title name', '称号']];
    const ORB_STAT_DEFS = [['all', '全部'], ['atk', '攻击'], ['mag', '魔法'], ['def', '防御'],
        ['spd', '速度'], ['elem', '属性强化'], ['other', '其它']];
    const ORB_STAT_GROUPS = {
        atk: ['pAtkFlat', 'pAtkPct', 'ind', 'critP', 'crit'],
        mag: ['mAtkFlat', 'mAtkPct', 'intel', 'spr', 'critM'],
        def: ['pDefFlat', 'mDefFlat', 'hpMax', 'mpMax', 'hpRegen', 'mpRegen', 'vit', 'dmgReduce'],
        spd: ['atkSpd', 'castSpd', 'moveSpd'],
        elem: ['elemEnh', 'elemRes'],
    };
    const ORB_RARITY_LABEL = { 1: '稀有', 2: '稀有', 3: '神器' };
    const ORB_RARITY_DEFS = [['all', '全部'], ['1', '稀有 1'], ['2', '稀有 2'], ['3', '神器 3']];

    let orbList = null;
    let orbState = { loading: false, error: '' };
    let orbWraps = null;
    let orbIconsRunning = false;

    function orbStatLabel(k) { return ORB_STAT_LABEL[k] || k; }
    function orbIsPct(k) { return ORB_PCT_KEYS.indexOf(k) !== -1; }
    function orbSlotsText(o) { return (o.slots || []).map(s => ORB_SLOT_LABEL[s] || s).join('、'); }
    function orbModLine(m) {
        const elem = m.e ? '（' + (ORB_ELEM_LABEL[m.e] || m.e) + '属性）' : '';
        return orbStatLabel(m.k) + elem + ' +' + m.v + (orbIsPct(m.k) ? '%' : '');
    }
    /** 与装备图鉴同一套 sprite 命名：item/x/y.img#12 → sprite_item_x_y_12.png */
    function orbIconUrl(path, index) {
        if (!path || index === undefined || index === null) return '';
        return '/assets/icons/sprite_' + String(path).replace(/\.img$/i, '').replace(/\//g, '_').toLowerCase() + '_' + index + '.png';
    }
    function orbToken() {
        try { return localStorage.getItem('dnf_idle_token') || ''; } catch (_) { return ''; }
    }
    function readOrbCache() {
        try {
            const c = JSON.parse(localStorage.getItem(ORB_CACHE_KEY) || 'null');
            if (!c || c.v !== ORB_CACHE_VER || !Array.isArray(c.items) || !c.items.length) return null;
            if (!Number.isFinite(c.at) || Date.now() - c.at > ORB_CACHE_TTL) return null;
            return c;
        } catch (_) { return null; }
    }
    function writeOrbCache() {
        if (!orbList) return;
        try {
            localStorage.setItem(ORB_CACHE_KEY, JSON.stringify({ v: ORB_CACHE_VER, at: Date.now(), items: orbList }));
        } catch (_) { }
    }
    function orbSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function orbMatchesStat(o, group) {
        const mods = o.mods || [];
        if (group === 'other') {
            return mods.some(m => {
                for (const g of ['atk', 'mag', 'def', 'spd', 'elem']) {
                    if (ORB_STAT_GROUPS[g].indexOf(m.k) !== -1) return false;
                }
                return true;
            });
        }
        const keys = ORB_STAT_GROUPS[group] || [];
        return mods.some(m => keys.indexOf(m.k) !== -1);
    }

    function orbFiltered() {
        const arr = orbList || [];
        const q = state.q.trim().toLowerCase();
        return arr.filter(o => {
            if (state.orar !== 'all' && String(o.rarity) !== String(state.orar)) return false;
            if (state.oslot !== 'all' && (o.slots || []).indexOf(state.oslot) === -1) return false;
            if (state.ostat !== 'all' && !orbMatchesStat(o, state.ostat)) return false;
            if (!q) return true;
            const hay = [o.name, orbSlotsText(o),
                (o.mods || []).map(m => orbStatLabel(m.k) + ' ' + m.k + ' ' + m.v).join(' ')].join(' ').toLowerCase();
            return hay.indexOf(q) !== -1;
        });
    }

    function renderOrbEmpty(text, withRetry) {
        listEl.innerHTML = '<div class="g85-empty"><div class="g85-orberr"></div>' +
            (withRetry ? '<button class="g85-retry" type="button">重新加载</button>' : '') + '</div>';
        const msg = listEl.querySelector('.g85-orberr');
        if (msg) msg.textContent = text;
        const btn = listEl.querySelector('.g85-retry');
        if (btn) btn.addEventListener('click', () => loadOrbs(true));
    }

    function renderOrbList() {
        if (!listEl || atlasMode !== 'orb') return;
        if (!orbList) {
            if (orbState.loading) {
                if (countEl) countEl.textContent = '加载中';
                renderOrbEmpty('正在读取宝珠数据…', false);
            } else {
                if (countEl) countEl.textContent = '—';
                renderOrbEmpty(orbState.error || '宝珠数据暂不可用', true);
            }
            return;
        }
        const arr = orbFiltered();
        if (countEl) countEl.textContent = arr.length + ' / ' + orbList.length;
        listEl.innerHTML = '';
        if (!arr.length) {
            listEl.innerHTML = '<div class="g85-empty">没有匹配的宝珠</div>';
            return;
        }
        for (const o of arr) {
            const div = document.createElement('div');
            div.className = 'g85-item';
            div.innerHTML = (o.icon ? '<img loading="lazy" alt="">' : '<div class="g85-ph">?</div>') +
                '<div style="min-width:0;flex:1 1 auto"><div class="g85-nm"></div><div class="g85-meta"></div></div>' +
                '<div class="g85-lv"></div>';
            const img = div.querySelector('img');
            if (img) img.src = o.icon;
            div.querySelector('.g85-nm').textContent = o.name;
            const first = (o.mods || [])[0];
            div.querySelector('.g85-meta').textContent = orbSlotsText(o) + (first ? '　' + orbModLine(first) : '　无属性');
            div.querySelector('.g85-lv').textContent = ORB_RARITY_LABEL[o.rarity] || ('R' + o.rarity);
            div.addEventListener('click', () => openOrbDetail(o));
            listEl.appendChild(div);
        }
    }

    function openOrbDetail(o) {
        state.detail = { orb: o };
        listEl.classList.add('hide');
        detailEl.classList.add('show');
        const slots = orbSlotsText(o);
        const head = [];
        if (slots) head.push('可附魔部位：' + slots);
        if (o.price) head.push('价格：' + o.price + ' 金币');
        if (o.ind) head.push('独立攻击力 +' + o.ind);
        const mods = (o.mods || []).map(orbModLine);
        let html = '<div class="g85-back">← 返回列表</div>' +
            '<div class="g85-dhead">' + (o.icon ? '<img alt="">' : '<div class="g85-ph" style="width:46px;height:46px">?</div>') +
            '<div><div class="g85-dname"></div><div class="g85-dsub"></div></div></div>';
        if (head.length) {
            html += '<div class="g85-attrs">' + head.map(s => '<div class="g85-line">' + esc(s) + '</div>').join('') + '</div>';
        }
        if (mods.length) {
            html += '<div class="g85-effect"><div class="g85-effect-head">附魔属性</div>' +
                mods.map(s => '<div class="g85-effect-line">' + esc(s) + '</div>').join('') + '</div>';
        }
        const elems = (o.elems || []).map(e => ORB_ELEM_LABEL[e] || e);
        if (elems.length) {
            html += '<div class="g85-attrs"><div class="g85-line">元素属性：' + esc(elems.join('、')) + '</div></div>';
        }
        detailEl.innerHTML = html;
        const dImg = detailEl.querySelector('.g85-dhead img');
        if (dImg) dImg.src = o.icon;
        detailEl.querySelector('.g85-dname').textContent = o.name;
        detailEl.querySelector('.g85-dsub').textContent =
            (ORB_RARITY_LABEL[o.rarity] || ('稀有度 ' + o.rarity)) + ' · 宝珠';
        detailEl.querySelector('.g85-back').addEventListener('click', backToList);
        detailEl.scrollTop = 0;
    }

    /** 串行补图标：每 20 个落一次缓存并刷新列表，避免一次性 161 个请求打满 */
    async function fetchOrbIcons() {
        if (orbIconsRunning || !orbList) return;
        const token = orbToken();
        if (!token) return;
        const todo = orbList.filter(o => !o.icon);
        if (!todo.length) return;
        orbIconsRunning = true;
        try {
            let n = 0;
            for (const o of todo) {
                try {
                    const r = await fetch('/api/items/' + o.id, { headers: { Authorization: 'Bearer ' + token } });
                    if (r.ok) {
                        const d = await r.json();
                        o.icon = orbIconUrl(d.icon_path, d.icon_index);
                    }
                } catch (_) { }
                n++;
                if (n % 20 === 0) { writeOrbCache(); if (atlasMode === 'orb' && !state.detail) renderOrbList(); }
                await orbSleep(ORB_ICON_GAP_MS);
            }
            writeOrbCache();
        } finally {
            orbIconsRunning = false;
            if (atlasMode === 'orb' && !state.detail) renderOrbList();
        }
    }

    async function loadOrbs(force) {
        if (orbState.loading) return;
        if (!force) {
            const c = readOrbCache();
            if (c) {
                orbList = c.items;
                orbState = { loading: false, error: '' };
                renderOrbList();
                fetchOrbIcons();
                return;
            }
        }
        const token = orbToken();
        if (!token) {
            orbList = null;
            orbState = { loading: false, error: '宝珠数据需要登录后加载（未检测到登录凭据）' };
            renderOrbList();
            return;
        }
        orbState = { loading: true, error: '' };
        renderOrbList();
        try {
            const r = await fetch('/api/orbs', { headers: { Authorization: 'Bearer ' + token } });
            if (!r.ok) throw new Error('接口返回 HTTP ' + r.status);
            const j = await r.json();
            const rows = j && Array.isArray(j.orbs) ? j.orbs : [];
            if (!rows.length) throw new Error('接口未返回宝珠数据');
            const old = readOrbCache();
            const iconMap = {};
            if (old) for (const x of old.items) if (x.icon) iconMap[x.id] = x.icon;
            orbList = rows.map(x => ({
                id: x.id, name: x.name, rarity: x.rarity, price: x.price,
                slots: x.slots || [], mods: x.mods || [], ind: x.ind || 0, elems: x.elems || [],
                icon: iconMap[x.id] || '',
            }));
            orbState = { loading: false, error: '' };
            writeOrbCache();
            renderOrbList();
            fetchOrbIcons();
        } catch (e) {
            orbList = null;
            orbState = { loading: false, error: '宝珠数据加载失败：' + ((e && e.message) || '网络异常') };
            renderOrbList();
        }
    }

    function buildOrbChips() {
        if (!orbWraps) return;
        const afterOrb = () => { if (state.detail) backToList(); renderOrbList(); };
        fillChips(orbWraps.stat, ORB_STAT_DEFS, state.ostat, key => { state.ostat = key; }, afterOrb);
        fillChips(orbWraps.slot, ORB_SLOT_DEFS, state.oslot, key => { state.oslot = key; }, afterOrb);
        fillChips(orbWraps.rar, ORB_RARITY_DEFS, state.orar, key => { state.orar = key; }, afterOrb);
    }

    /** 切换装备 / 宝珠两页：只改显隐与数据源，装备页筛选状态原样保留 */
    function applyAtlasMode(root) {
        // buildPanel 里 panel 还没赋值，用传入的 root；其余场景用全局 panel
        const scope = root || panel;
        if (!scope) return;
        const eq = atlasMode !== 'orb';
        if (catWrap) catWrap.style.display = eq ? 'flex' : 'none';
        if (subWrap) subWrap.style.display = eq && state.cat !== 'all' ? 'flex' : 'none';
        if (sub2Wrap) sub2Wrap.style.display = eq && state.cat === 'armor' ? 'flex' : 'none';
        if (orbWraps) {
            orbWraps.stat.style.display = eq ? 'none' : 'flex';
            orbWraps.slot.style.display = eq ? 'none' : 'flex';
            orbWraps.rar.style.display = eq ? 'none' : 'flex';
        }
        for (const tab of scope.querySelectorAll('.g85-tab')) {
            tab.classList.toggle('on', tab.getAttribute('data-mode') === atlasMode);
        }
        if (searchEl) searchEl.placeholder = eq ? '搜索名字 / 类型…' : '搜索名字 / 属性…';
        if (state.detail) backToList();
        if (eq) renderList();
        else {
            if (!orbList && !orbState.loading) loadOrbs(false);
            renderOrbList();
        }
    }

    function switchAtlasMode(m) {
        if (atlasMode === m) return;
        atlasMode = m;
        state.q = '';
        if (searchEl) searchEl.value = '';
        applyAtlasMode();
    }

    function buildPanel() {
        const p = document.createElement('div');
        p.className = 'g85-panel';
        p.style.display = 'none';
        p.innerHTML = '<div class="g85-head"><b>史诗图鉴</b><span class="g85-count"></span><button class="g85-x" data-no-drag type="button" title="关闭">×</button></div>' +
            '<div class="g85-tabs"><div class="g85-tab on" data-mode="equip">装备</div><div class="g85-tab" data-mode="orb">宝珠</div></div>' +
            '<div class="g85-search"><input placeholder="搜索名字 / 类型…" autocomplete="off"></div>' +
            '<div class="g85-chips g85-cats"></div>' +
            '<div class="g85-chips g85-sub"></div>' +
            '<div class="g85-chips g85-sub2"></div>' +
            '<div class="g85-chips g85-ostat" style="display:none"></div>' +
            '<div class="g85-chips g85-oslot" style="display:none"></div>' +
            '<div class="g85-chips g85-orar" style="display:none"></div>' +
            '<div class="g85-list"></div>' +
            '<div class="g85-detail"></div>';
        document.body.appendChild(p);

        listEl = p.querySelector('.g85-list');
        detailEl = p.querySelector('.g85-detail');
        catWrap = p.querySelector('.g85-cats');
        subWrap = p.querySelector('.g85-sub');
        sub2Wrap = p.querySelector('.g85-sub2');
        countEl = p.querySelector('.g85-count');
        searchEl = p.querySelector('.g85-search input');
        orbWraps = {
            stat: p.querySelector('.g85-ostat'),
            slot: p.querySelector('.g85-oslot'),
            rar: p.querySelector('.g85-orar'),
        };
        for (const tab of p.querySelectorAll('.g85-tab')) {
            tab.addEventListener('click', () => switchAtlasMode(tab.getAttribute('data-mode')));
        }

        makeDraggable(p, p.querySelector('.g85-head'));
        const closeBtn = p.querySelector('.g85-x');
        // 关闭按钮必须完全脱离拖动逻辑：pointerdown 不冒泡到标题栏，
        // 否则 pointer capture 会把 click 重定向到标题栏，点 X 没反应。
        closeBtn.addEventListener('pointerdown', e => { e.stopPropagation(); });
        closeBtn.addEventListener('click', e => { e.stopPropagation(); setOpen(false); });
        searchEl.addEventListener('input', () => {
            state.q = searchEl.value;
            if (state.detail) backToList();
            if (atlasMode === 'orb') renderOrbList(); else renderList();
        });
        buildCatChips();
        buildSubChips();
        makeChipsDraggable(catWrap);
        makeChipsDraggable(subWrap);
        makeChipsDraggable(sub2Wrap);
        syncSubRows();
        buildOrbChips();
        makeChipsDraggable(orbWraps.stat);
        makeChipsDraggable(orbWraps.slot);
        makeChipsDraggable(orbWraps.rar);
        applyAtlasMode(p);

        const pos = loadPos();
        if (pos) {
            p.style.left = pos.left + 'px';
            p.style.top = pos.top + 'px';
            p.style.right = 'auto';
            p.style.bottom = 'auto';
        }
        return p;
    }

    // v5.83：并入插件后不再生成独立胶囊入口（HUD 标题栏的图鉴图标即唯一入口），
    // 因此原 buildCapsule 已移除，capsule 恒为 null，setOpen 会跳过与它相关的分支。

    function setOpen(open) {
        state.open = open;
        if (open) {
            if (!panel) panel = buildPanel();
            if (capsule) capsule.style.display = 'none';
            panel.style.display = 'flex';
            if (atlasMode === 'orb' && !orbList && !orbState.loading) loadOrbs(false);
            if (state.detail === null) {
                listEl.classList.remove('hide');
                detailEl.classList.remove('show');
            }
            if (capsule) {
                const r = capsule.getBoundingClientRect();
                applyPos(panel, r.left, r.top - 4);
            }
        } else {
            // 先量位置再隐藏，否则 rect 全 0，胶囊会跳到左上角
            let r = null;
            if (panel) {
                r = panel.getBoundingClientRect();
                panel.style.display = 'none';
            }
            if (capsule) {
                capsule.style.display = 'flex';
                if (r && panel && panel.style.left) applyPos(capsule, r.left, r.top);
            }
        }
    }

        // 注意：这里不能在脚本加载时注入样式。本脚本 @run-at document-start，
        // 此刻 document.head 还不存在，会抛 "Cannot read properties of null"。
        // 样式留到用户第一次点开图鉴（open）时再注入。
        return {
            /** 面板是否已创建且可见 */
            isOpen: function () { return !!(panel && panel.isConnected && panel.style.display !== 'none'); },
            open: function () {
                if (!document.body) return;
                injectStyles();
                setOpen(true);
                if (panel) panel.setAttribute('data-dnf-atlas', '1');
            },
            close: function () { setOpen(false); },
            toggle: function () { if (this.isOpen()) this.close(); else this.open(); }
        };
    })();

    /** HUD「图鉴」按钮：优先复用外部独立图鉴脚本，避免两套入口 */
    function toggleEquipAtlas() {
        // ① 外部脚本已建好面板：直接显隐它，并把它的胶囊入口一直藏起来
        const extPanel = document.querySelector('.g85-panel:not([data-dnf-atlas])');
        if (extPanel) {
            const cap = document.querySelector('.g85-capsule');
            if (cap) cap.style.display = 'none';
            extPanel.style.display = extPanel.style.display === 'none' ? 'flex' : 'none';
            return;
        }
        // ② 外部脚本只建了胶囊：点它开面板，胶囊隐藏（入口只保留 HUD 图标）
        const extCapsule = document.querySelector('.g85-capsule');
        if (extCapsule) {
            extCapsule.style.display = 'none';
            extCapsule.click();
            return;
        }
        // ③ 没有外部脚本：用内置面板
        try { ATLAS_API.toggle(); } catch (e) { log('图鉴打开失败', e); }
    }
    /* ============================================================
     * 游戏界面优化（v5.83 引入，v5.85 改为仅移动端生效）
     * ------------------------------------------------------------
     * ① 隐藏顶部与功能栏重复的「世界BOSS」按钮
     * ② 「兑换码」移到商店子标签「通用制作」右侧（克隆节点转发 click）
     * 分界判据：跟游戏自身布局一致。游戏桌面样式用的是 @media(min-width:761px)，
     * 所以 max-width:760px 即游戏的移动端布局，用 matchMedia 实时判断，
     * 不用 userAgent（桌面浏览器缩窄窗口也会切到移动布局，那正是要的效果）。
     * 桌面端完全不动：世界BOSS 照旧、兑换码留在顶栏、商店里不出现克隆。
     * 只做展示层调整，不调用任何游戏接口。
     * ============================================================ */
    const UI_MOBILE_MAX_WIDTH = 760;
    let _redeemCloneEl = null;
    let _uiTweakMissAt = 0;

    function gameButtonText(el) {
        return (el && el.textContent ? el.textContent : '').replace(/\s+/g, '');
    }

    /** 按精确文本找游戏按钮；主选择器找不到时，低频兜底扫一遍 div/span */
    function findGameButton(text) {
        const main = document.querySelectorAll('button,[role="button"],.sm,.btn,.tab');
        for (let i = 0; i < main.length; i++) {
            if (gameButtonText(main[i]) === text) return main[i];
        }
        // 兜底：叶子节点精确匹配，最多 3 秒一次，避免每秒全量扫描
        if (Date.now() - _uiTweakMissAt < 3000) return null;
        _uiTweakMissAt = Date.now();
        const all = document.querySelectorAll('div,span,a');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (!el.children.length && gameButtonText(el) === text) return el;
        }
        return null;
    }

    /** 是否游戏的移动端布局 */
    function isMobileGameLayout() {
        try { return window.matchMedia('(max-width: ' + UI_MOBILE_MAX_WIDTH + 'px)').matches; }
        catch (_) { return window.innerWidth <= UI_MOBILE_MAX_WIDTH; }
    }

    /** 隐藏前先记住元素原本的内联 display，撤回时原样还回去 */
    function markHidden(el, markAttr) {
        el.setAttribute(markAttr, '1');
        el.setAttribute('data-dnf-prev-display', el.style.display || '');
        el.style.setProperty('display', 'none', 'important');
    }

    function unmarkHidden(el, markAttr) {
        const prev = el.getAttribute('data-dnf-prev-display') || '';
        el.removeAttribute(markAttr);
        el.removeAttribute('data-dnf-prev-display');
        if (prev) el.style.display = prev;
        else el.style.removeProperty('display');
    }

    /** ① 隐藏顶部与功能栏重复的「世界BOSS」（只动「兑换码」的同级兄弟） */
    function hideDuplicateWorldBoss(redeem) {
        const bar = redeem && redeem.parentElement;
        if (!bar) return;
        const nodes = bar.children;
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (el === redeem || el.hasAttribute('data-dnf-wb-hidden')) continue;
            if (gameButtonText(el) !== '世界BOSS') continue;
            markHidden(el, 'data-dnf-wb-hidden');
        }
    }

    /** ② 把「兑换码」搬进商店「通用制作」右侧（克隆转发点击） */
    function relocateRedeemButton(redeem) {
        const produce = findGameButton('通用制作');
        if (!produce || !produce.parentElement) return;
        // 原生按钮只隐藏不删除：克隆体 click 时还要靠它触发游戏自己的兑换码弹窗
        if (!redeem.hasAttribute('data-dnf-redeem-native')) markHidden(redeem, 'data-dnf-redeem-native');
        const row = produce.parentElement;
        if (!_redeemCloneEl) {
            _redeemCloneEl = redeem.cloneNode(true);
            _redeemCloneEl.removeAttribute('id');
            _redeemCloneEl.removeAttribute('data-dnf-redeem-native');
            _redeemCloneEl.removeAttribute('data-dnf-prev-display');
            _redeemCloneEl.setAttribute('data-dnf-redeem-clone', '1');
            _redeemCloneEl.style.removeProperty('display');
            _redeemCloneEl.title = '兑换码';
            _redeemCloneEl.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const src = findGameButton('兑换码');
                if (src) src.click();
            }, true);
        }
        if (_redeemCloneEl.parentElement !== row || _redeemCloneEl.previousElementSibling !== produce) {
            produce.insertAdjacentElement('afterend', _redeemCloneEl);
        }
    }

    /** 撤回全部改动：删克隆、还原被隐藏的原生按钮（桌面端 / 切回桌面宽度时调用） */
    function revertGameUiTweaks() {
        const clones = document.querySelectorAll('[data-dnf-redeem-clone]');
        for (let i = 0; i < clones.length; i++) clones[i].remove();
        _redeemCloneEl = null;
        const natives = document.querySelectorAll('[data-dnf-redeem-native]');
        for (let i = 0; i < natives.length; i++) unmarkHidden(natives[i], 'data-dnf-redeem-native');
        const wbs = document.querySelectorAll('[data-dnf-wb-hidden]');
        for (let i = 0; i < wbs.length; i++) unmarkHidden(wbs[i], 'data-dnf-wb-hidden');
    }

    function applyGameUiTweaks() {
        if (!document.body) return;
        // 桌面端：保证完全回到游戏原样（幂等，重复调用无副作用）
        if (!isMobileGameLayout()) {
            revertGameUiTweaks();
            return;
        }
        const redeem = findGameButton('兑换码');
        if (!redeem || redeem.hasAttribute('data-dnf-redeem-clone')) return;
        try { hideDuplicateWorldBoss(redeem); } catch (_) { }
        try { relocateRedeemButton(redeem); } catch (_) { }
    }

    /** 视口变化（缩放窗口 / 横竖屏）即时重算，避免残留在错的一侧 */
    function initGameUiTweakWatchers() {
        if (window.__dnfUiTweakWatchers585) return;
        window.__dnfUiTweakWatchers585 = true;
        const onChange = () => { try { applyGameUiTweaks(); } catch (_) { } };
        window.addEventListener('resize', onChange, { passive: true });
        window.addEventListener('orientationchange', () => {
            setTimeout(onChange, 120);
            setTimeout(onChange, 500);
        }, { passive: true });
        try {
            const mq = window.matchMedia('(max-width: ' + UI_MOBILE_MAX_WIDTH + 'px)');
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        } catch (_) { }
    }

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

        // v5.85：世界BOSS 去重 + 兑换码迁到商店，仅移动端（≤760px）生效；
        // 桌面端保持游戏原样，窗口缩放/横竖屏会即时回退或重新生效
        initGameUiTweakWatchers();
        applyGameUiTweaks();

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
            applyGameUiTweaks();
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
            applyGameUiTweaks();
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
