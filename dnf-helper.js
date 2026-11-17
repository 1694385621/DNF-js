// ==UserScript==
// @name         DNF挂机助手
// @namespace    http://tampermonkey.net/
// @version      6.02
// @description  挂机统计浮窗（首次默认左上角、折叠胶囊可拖动/左右贴边吸附并记忆位置、窄屏自适应不溢出；设置面板移动端完整可见可滚动）+ 掉落/技能日志 + 怪物血条线性百分比（5 位小数精度，百万血不再卡住不动）+ HP/MP 血条修复 + 打造跳转修复 + 仓库装备/仓库材料置顶 + 背包详情「存仓」按钮（锁定装备也可存）+ 仓库装备「点击先看详情、再确认取出」（取消不发请求）+ 仓库材料「自选数量取出」（默认整组、超限回填、取消不发请求；v5.97 按渲染同源列表定位，修复增幅券等带空格道具无法取出、筛选后可能取错物品）+ 通关秘宝盒「按批全开」（每批 10 个、批间约 120ms、可停止）+ 游戏红字同步提示（监听游戏 .error，把文案用插件原样式贴顶提示）+ 屏蔽游戏自带挂机浮窗（可开关）+ 联网检查更新（只提示不执行，点击跳转下载页；设置面板可手动检查/关闭自动检查；按 ghproxy→raw→jsDelivr 多源依次取 version.json，下载链接跟随实际成功源）+ 装备图鉴（HUD 日志旁入口：按游戏「大类/职业/部位/甲种」分类筛选 + 搜索 + 详情；v5.101 收纳史诗/传说 + Lv85 神器散件共 1,166 条，新增「神器/史诗/传说」品质筛选、武器按职业→类型三级分类、分批渲染，右上角「刷新」需二次确认；首次打开按需加载，ID 段枚举 + 逐件拉取带进度/可停止/失败重试，localStorage 缓存 7 天，内置最小基线兜底）+ 顶部重复「世界BOSS」按钮移除 + 「兑换码」移到商店「通用制作」旁（以上两项仅移动端 ≤760px 生效，桌面端保持游戏原样）+ 移除仓库区块排序 + 宝珠图鉴（174 条，属性类型/可附魔部位/稀有度三级筛选，数据来自 /api/orbs，图标按 id 补齐并本地缓存；v5.101 补「回避率」映射、右上角刷新需二次确认）+ 强化/增幅保护券提醒（当前等级 ≥10 且未勾选保护券时，首次点击只提示不执行，勾选后再点一次放行）+ 手动分解后提示实际所得（读服务端 outputs，按物品聚合）+ 背包装备详情「分解」按钮（走游戏原生分解确认/提示；失败降级单件接口）+ 排行榜角色详情「复制技能」（游戏原生详情弹窗「技能配置」块之后追加按钮，不改原生结构；同职业同成长方向才可用，点击才拉一次 profile，两段式归零→逐级升级，结束对账）+ 模块顺序平板栏内排序（761–1200px 左栏/中栏内部可上下互换，v5.98 功能框并入中栏、可与日志框互换，手机单列与桌面三栏行为不变）+ 背包材料/消耗品详情「上架拍卖」（调用游戏原生上架面板并预选物品，绑定/不可交易置灰说明；v5.99 面板弹出后自动收起详情，不再压住数量/价格/确认上架）+ 收益弹窗（旁路读取 bag-filter-apply 与分解接口，统一弹窗展示出售件数/金币、分解产物；v5.98 无分解时不显示分解段、出售品质推断剔除 price=0 的自动转分解项；装备详情页分解也走同一弹窗）。
// @author       You
// @match        *://shileshihu.cn/*
// @match        *://www.shileshihu.cn/*
// @icon         https://shileshihu.cn/favicon.ico
// @updateURL    https://gh-proxy.com/https://raw.githubusercontent.com/1694385621/DNF-js/main/dnf-helper.js
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/1694385621/DNF-js/main/dnf-helper.js
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

    /** 视口变化时重算设置面板（只挂一次）；v5.95：跨断点自动重绘模块顺序入口 */
    function applySettingsPanelResizeHook() {
        if (window.__dnfSettingsResizeHook579) return;
        window.__dnfSettingsResizeHook579 = true;
        let lastMode = moduleLayoutMode();
        const onLayoutModeChange = () => {
            const mode = moduleLayoutMode();
            if (mode === lastMode) return;
            lastMode = mode;
            lastModuleOrderSig = '';   // 强制按新模式重算排序样式
            applyModuleOrder();
            renderSettingsPanel();
        };
        window.addEventListener('resize', () => {
            refreshSettingsPanel();
            onLayoutModeChange();
        }, { passive: true });
        window.addEventListener('orientationchange', () => {
            setTimeout(refreshSettingsPanel, 60);
            setTimeout(refreshSettingsPanel, 300);
            setTimeout(onLayoutModeChange, 120);
        }, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', refreshSettingsPanel, { passive: true });
        }
        const watch = (query) => {
            if (typeof window.matchMedia !== 'function') return;
            const mq = window.matchMedia(query);
            if (mq.addEventListener) mq.addEventListener('change', onLayoutModeChange);
            else if (mq.addListener) mq.addListener(onLayoutModeChange);
        };
        watch('(max-width: 760px)');
        watch('(min-width: 761px) and (max-width: 1200px)');
    }
    function renderSettingsPanel() {
        if(!settingsPanelEl?.isConnected)return;
        const body=settingsPanelEl.querySelector('.dnf-settings-body');
        const options=[['屏蔽挂机浮窗','hideGameAssistant','隐藏游戏原生挂机浮窗/折叠球（可恢复）'],['功能栏下移','relocateTabsAfterSettlement','功能栏放到最近结算下方'],['特性技能过滤','hideUnlearnedSkills','只显示已学前置的特性'],['统一 UI 主题','uiTheme','深色底、金色边框'],['诊断信息','debugHud','显示血条同步状态'],['启动时自动检查更新','autoCheckUpdate','读 version.json，只提示不自动安装']];
        body.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:8px">'+options.map(args=>'<div style="padding:8px 10px;border:1px solid #56422f;border-radius:8px;background:#2b2118">'+renderSettingsRow(...args)+'</div>').join('')+'</div>'+(moduleLayoutMode()!=='desktop'?'<div style="margin-top:12px">'+renderModuleOrderRows()+'</div>':'')+renderUpdateBlock();
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
    const VERSION = '6.02';

    /**
     * 游戏接口 GET 统一超时（v5.90）
     * ------------------------------------------------------------
     * 原来 /api/orbs、/api/items/{id} 这些请求没有超时，网络挂起时会让
     * 「宝珠加载中 / 图标补齐中」永久卡住且无法重试。这里统一 10s 中断，
     * 调用方只需在 finally 里复位 loading/running 状态即可再次重试。
     */
    const API_TIMEOUT_MS = 10000;
    function apiFetch(url, init) {
        if (typeof AbortController !== 'function') return fetch(url, init);
        const ctrl = new AbortController();
        const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) { } }, API_TIMEOUT_MS);
        const opts = Object.assign({}, init || {});
        opts.signal = ctrl.signal;
        return fetch(url, opts).finally(() => clearTimeout(timer));
    }

    /**
     * 可持久化的用户设置白名单（只存这些，其它运行期配置不写盘）。
     */
    const SETTING_KEYS = ['relocateTabsAfterSettlement', 'hudCorner', 'hudPos', 'hudDock', 'uiTheme', 'debugHud', 'moduleOrder', 'hideUnlearnedSkills', 'hideGameAssistant', 'hudCollapsed', 'autoCheckUpdate'];

    /** 可自定义上下顺序的六大模块（v5.95：按栏分组；v5.98：功能框并入中栏） */
    const MODULE_DEFS = [
        { key: 'char', label: '人物框', sel: '.main .doll-panel', group: 'left' },
        { key: 'status', label: '状态框', sel: '.main .resource-panel', group: 'left' },
        { key: 'dungeon', label: '地图怪物框', sel: '.main .panel.dungeon', group: 'center' },
        { key: 'settle', label: '结算框', sel: '.main .panel.settle', group: 'center' },
        { key: 'log', label: '日志框', sel: '.main .panel.battle-log', group: 'center' },
        { key: 'tabs', label: '功能框', sel: '.main .right-col', group: 'center' },
    ];
    const MODULE_GROUP_KEYS = {
        left: ['char', 'status'],
        center: ['dungeon', 'settle', 'log', 'tabs'],
    };
    const MODULE_DEFAULT_ORDER = MODULE_DEFS.map(d => d.key);
    const isMobileLayout = () =>
        (typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)').matches : false);
    /** 平板区间：游戏保持两栏（300px + 1fr），只允许栏内排序 */
    const isTabletLayout = () =>
        (typeof window.matchMedia === 'function'
            ? window.matchMedia('(min-width: 761px) and (max-width: 1200px)').matches
            : false);
    /** 布局模式：mobile（单列可跨栏）/ tablet（两栏栏内）/ desktop（不排序） */
    function moduleLayoutMode() {
        if (isMobileLayout()) return 'mobile';
        if (isTabletLayout()) return 'tablet';
        return 'desktop';
    }

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

    /** 上移/下移一个模块，返回是否发生变化（平板只允许同栏内交换） */
    function moveModule(key, dir) {
        const order = normalizedModuleOrder();
        const mode = moduleLayoutMode();
        if (mode === 'desktop') return false;
        if (mode === 'tablet') {
            const def = MODULE_DEFS.find(d => d.key === key);
            const groupKeys = def && MODULE_GROUP_KEYS[def.group];
            if (!groupKeys) return false;           // 未知分组不可移动
            const inGroup = order.filter(k => groupKeys.indexOf(k) !== -1);
            const vi = inGroup.indexOf(key);
            if (vi < 0) return false;
            const tj = dir === 'up' ? vi - 1 : vi + 1;
            if (tj < 0 || tj >= inGroup.length) return false;
            const other = inGroup[tj];
            const a = order.indexOf(key), b = order.indexOf(other);
            order[a] = other;
            order[b] = key;
            CONFIG.moduleOrder = order;
            return true;
        }
        const i = order.indexOf(key);
        if (i < 0) return false;
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return false;
        order.splice(i, 1);
        order.splice(j, 0, key);
        CONFIG.moduleOrder = order;
        return true;
    }

    function setModuleOrderStyle(sel, value) {
        const el = document.querySelector(sel);
        if (!el) return false;
        const target = value ? String(value) : '';
        if (el.style.order === target) return false;
        el.style.order = target;
        return true;
    }

    /**
     * v5.98：平板上功能框要和日志框同栏，才能按 order 栏内排序。
     * 只在平板模式把 .right-col 临时移入 .center-col；离开平板立即放回 .main，
     * 保证手机单列堆叠（依赖 .main > .right-col）与桌面三栏都不受影响。
     */
    function syncTabletTabsParent(mode) {
        const main = document.querySelector('.main');
        if (!main) return false;
        const center = main.querySelector('.center-col');
        const right = main.querySelector('.right-col');
        if (!center || !right) return false;
        if (mode === 'tablet') {
            if (right.parentElement !== center) { center.appendChild(right); return true; }
            return false;
        }
        if (right.parentElement === center) { main.appendChild(right); return true; }
        return false;
    }

    function applyModuleOrder() {
        const main = document.querySelector('.main');
        if (!main) return;
        const mode = moduleLayoutMode();
        const order = normalizedModuleOrder();
        const buffSel = '.main .buff-panel';
        syncTabletTabsParent(mode);

        if (mode === 'desktop') {
            // 桌面三栏：清掉全部排序样式，保持游戏原生
            if (lastModuleOrderSig === 'off') return;
            lastModuleOrderSig = 'off';
            main.classList.remove('dnf-mod-stack');
            MODULE_DEFS.forEach(d => setModuleOrderStyle(d.sel, ''));
            setModuleOrderStyle(buffSel, '');
            return;
        }

        if (mode === 'mobile') {
            // 手机单列：沿用 v5.91 起的跨栏堆叠
            const stack = order.join(',') !== MODULE_DEFAULT_ORDER.join(',');
            const sig = stack ? ('mobile:' + order.join(',')) : 'mobile:default';
            if (sig === lastModuleOrderSig) {
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
                if (def) setModuleOrderStyle(def.sel, stack ? String((i + 1) * 10) : '');
            });
            // 「增益效果」面板没有单独开放排序，固定跟随「地图怪物框」其后
            const buff = document.querySelector(buffSel);
            if (buff) {
                const di = order.indexOf('dungeon');
                buff.style.order = stack ? String((di + 1) * 10 + 1) : '';
            }
            return;
        }

        // 平板两栏：不堆叠、不 display:contents，只在左栏/中栏内部用 order 调整
        const left = order.filter(k => MODULE_GROUP_KEYS.left.indexOf(k) !== -1);
        const center = order.filter(k => MODULE_GROUP_KEYS.center.indexOf(k) !== -1);
        const dirty = left.join(',') !== MODULE_GROUP_KEYS.left.join(',')
            || center.join(',') !== MODULE_GROUP_KEYS.center.join(',');
        const sig = 'tablet:' + left.join(',') + '|' + center.join(',');
        if (sig === lastModuleOrderSig) {
            const needFix = main.classList.contains('dnf-mod-stack')
                || left.some((k, i) => {
                    const def = MODULE_DEFS.find(d => d.key === k);
                    const el = def && document.querySelector(def.sel);
                    return !!el && el.style.order !== (dirty ? String((i + 1) * 10) : '');
                })
                || center.some((k, i) => {
                    const def = MODULE_DEFS.find(d => d.key === k);
                    const el = def && document.querySelector(def.sel);
                    return !!el && el.style.order !== (dirty ? String((i + 1) * 10) : '');
                })
                || (() => {
                    const rc = document.querySelector('.main .right-col');
                    const cc = document.querySelector('.main .center-col');
                    return !rc || !cc || rc.parentElement !== cc;
                })();
            if (!needFix) return;
        }
        lastModuleOrderSig = sig;
        main.classList.remove('dnf-mod-stack');
        left.forEach((k, i) => {
            const def = MODULE_DEFS.find(d => d.key === k);
            if (def) setModuleOrderStyle(def.sel, dirty ? String((i + 1) * 10) : '');
        });
        center.forEach((k, i) => {
            const def = MODULE_DEFS.find(d => d.key === k);
            if (def) setModuleOrderStyle(def.sel, dirty ? String((i + 1) * 10) : '');
        });
        const buff = document.querySelector(buffSel);
        if (buff) {
            const di = center.indexOf('dungeon');
            buff.style.order = dirty && di >= 0 ? String((di + 1) * 10 + 1) : '';
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
    /* v5.90：统一 DOM 变更总线（红字同步 + 怪物血条共用同一个观察者）
       ------------------------------------------------------------
       此前「红字」和「怪物血条」各挂一个 document 级 observer，且都带 characterData，
       同一批 DOM 变更会被完整遍历两次。合并成一个后只遍历一次：
         · 红字：任意变更都可能原地改字，保持原有 120ms 合批 + 2.5s 同文案去重；
         · 怪物血条：只在「地图怪物框」(.panel.dungeon) 内部有变更时才重算，
           其它区域（HUD/日志/背包）的变更不再触发血条同步。
       保留 characterData 是因为红字与 HP 文本都是原地改文本节点。 */
    let _domBusObserver = null;
    let _domBusHpHooked = false;
    let _dungeonPanelEl = null;

    function refreshDungeonPanelEl() {
        _dungeonPanelEl = document.querySelector('.main .panel.dungeon');
    }

    function initDomBus() {
        if (_domBusObserver) return;
        let errorScheduled = false;
        _domBusObserver = new MutationObserver(records => {
            if (!errorScheduled) {
                errorScheduled = true;
                setTimeout(() => { errorScheduled = false; syncGameError(); }, 120);
            }
            if (!_domBusHpHooked) return;
            if (!_dungeonPanelEl || !_dungeonPanelEl.isConnected) refreshDungeonPanelEl();
            if (!_dungeonPanelEl) return;
            for (let i = 0; i < records.length; i++) {
                const t = records[i].target;
                if (t && _dungeonPanelEl.contains(t)) { scheduleMonsterHpSync(); return; }
            }
        });
        _domBusObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        refreshDungeonPanelEl();
    }
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

    /** 启动红字监听（v5.90：改为共用 DOM 变更总线，不再单挂 observer） */
    function startGameErrorSync() {
        if (window.__dnfDomBus590) return;
        window.__dnfDomBus590 = true;
        initDomBus();
        syncGameError();   // 注入脚本时若红字已经在页面上，也能补同步一次
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
        atlasBtn.title = '装备图鉴（神器 / 史诗 / 传说）';
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

    /** 渲染「模块顺序」：手机可跨栏；平板按栏分组，只在栏内调整 */
    function renderModuleOrderRows() {
        const order = normalizedModuleOrder();
        const mode = moduleLayoutMode();
        const btnStyle = 'display:inline-flex;align-items:center;justify-content:center;' +
            'width:22px;height:22px;border-radius:4px;background:rgba(255,255,255,0.08);' +
            'border:1px solid rgba(255,184,77,0.35);color:#ffd76b;font-size:13px;line-height:1;' +
            'cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent';
        const offStyle = 'opacity:.3;pointer-events:none';
        let html = '<div style="border-top:1px dashed rgba(255,184,77,0.35);margin:6px 0"></div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">' +
                '<span style="font-size:11px;color:#ffb84d;font-weight:700">模块顺序' +
                    (mode === 'tablet' ? '（平板·仅同栏内）' : '') + '</span>' +
                '<span data-modreset="1" style="font-size:10px;color:#a79070;cursor:pointer;' +
                    'text-decoration:underline">恢复默认</span>' +
            '</div>';
        const rowHtml = (key, index, count) => {
            const def = MODULE_DEFS.find(d => d.key === key);
            const canUp = index > 0;
            const canDown = index < count - 1;
            return '<div style="display:flex;align-items:center;justify-content:space-between;margin:2px 0">' +
                '<span style="font-size:11px;color:#ffd76b;white-space:nowrap;overflow:hidden;' +
                    'text-overflow:ellipsis">' + (index + 1) + '. ' + def.label + '</span>' +
                '<span style="display:flex;gap:4px;flex:0 0 auto;margin-left:6px">' +
                    '<span data-modmove="' + key + ':up" style="' + btnStyle + (canUp ? '' : ';' + offStyle) + '">↑</span>' +
                    '<span data-modmove="' + key + ':down" style="' + btnStyle + (canDown ? '' : ';' + offStyle) + '">↓</span>' +
                '</span></div>';
        };
        if (mode === 'tablet') {
            [['left', '左栏'], ['center', '中栏']].forEach(([group, label]) => {
                const keys = order.filter(k => MODULE_GROUP_KEYS[group].indexOf(k) !== -1);
                html += '<div style="font-size:10px;color:#a79070;margin:5px 0 2px">' + label + '</div>';
                keys.forEach((key, i) => { html += rowHtml(key, i, keys.length); });
            });
            html += '<div style="font-size:10px;color:#a79070;margin:5px 0 0">功能框已并入中栏，可与日志框互换位置</div>';
            return html;
        }
        order.forEach((key, i) => { html += rowHtml(key, i, order.length); });
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
            // ===== 物品详情「分解」按钮（v5.91）=====
            // 与「存仓」同一行，只加插件自己的按钮，不动游戏原生按钮
            '.dnf-deposit-box .dnf-decompose-btn{border-color:#a65a2a;color:#ffd0a6}',
            '.dnf-deposit-box .dnf-decompose-btn[disabled]{opacity:.55;cursor:not-allowed}',
            // ===== 复制技能 / 复制加点面板（v5.91，v5.93 入口移到原生详情弹窗）=====
            // 只追加在「技能配置（出战顺序）」块之后，宽度跟随原生弹窗，窄屏自动换行
            '.dnf-npb{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;' +
                'border:1px solid #6d5533;border-radius:8px;background:#2a2118;box-sizing:border-box;max-width:100%}',
            '.dnf-npb-btn{flex:0 0 auto;min-height:32px;padding:0 14px;border-radius:6px;border:1px solid #c7751a;' +
                'background:linear-gradient(180deg,#f0a23d,#d47e1c);color:#1a1206;cursor:pointer;white-space:nowrap;' +
                'font:13px/1.2 Microsoft YaHei,sans-serif;box-sizing:border-box}',
            '.dnf-npb-btn[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-npb-hint{flex:1 1 150px;min-width:0;color:#baa78e;' +
                'font:12px/1.4 Microsoft YaHei,sans-serif;overflow-wrap:anywhere}',
            '.dnf-rp-mask{position:fixed;inset:0;z-index:1000003;display:flex;align-items:center;' +
                'justify-content:center;padding:12px;background:#0008}',
            '.dnf-rp-panel{display:flex;flex-direction:column;width:min(560px,calc(100vw - 24px));' +
                'max-height:calc(100vh - 24px);box-sizing:border-box;overflow:hidden;border-radius:12px;' +
                'border:1px solid #9b7645;background:#211a13;color:#edddc3;box-shadow:0 12px 36px #0009;' +
                'font:13px/1.5 Microsoft YaHei,sans-serif;overflow-wrap:anywhere;word-break:break-word}',
            '.dnf-rp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;' +
                'flex:0 0 auto;padding:10px 14px;background:#302319;border-bottom:1px solid #80613e}',
            '.dnf-rp-title{color:#ffd794;font-size:15px;font-weight:700;line-height:1.3}',
            '.dnf-rp-sub{color:#baa78e;font-size:12px;line-height:1.4}',
            '.dnf-rp-x{flex:0 0 auto;min-width:30px;min-height:30px;background:none;border:0;color:#dfc79e;' +
                'font-size:22px;line-height:1;cursor:pointer}',
            '.dnf-rp-x[disabled]{opacity:.4;cursor:not-allowed}',
            '.dnf-rp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 14px;' +
                'overscroll-behavior:contain}',
            '.dnf-rp-empty{color:#baa78e;font-size:12px;padding:8px 2px}',
            '.dnf-rp-foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;' +
                'padding:10px 14px;border-top:1px solid #56422f;background:#241b12;flex-wrap:wrap}',
            '.dnf-rp-btn{min-width:96px;min-height:34px;padding:0 14px;border-radius:6px;cursor:pointer;' +
                'font:700 13px/1 Microsoft YaHei,sans-serif;border:1px solid #8f6d3f;background:#2a2118;color:#e6d3b3}',
            '.dnf-rp-btn.primary{border-color:#c7751a;background:linear-gradient(180deg,#f0a23d,#d47e1c);color:#1a1206}',
            '.dnf-rp-btn[disabled]{opacity:.55;cursor:not-allowed}',
            '.dnf-cp-sec{margin-bottom:10px}',
            '.dnf-cp-sec-title{color:#ffd794;font-weight:700;margin-bottom:4px}',
            '.dnf-cp-list{margin:0;padding-left:18px;color:#e6d3b3;font-size:12px;line-height:1.55}',
            '.dnf-cp-warn{color:#ff8f8f;font-weight:700;font-size:12px;line-height:1.5;margin:6px 0}',
            '.dnf-cp-tip{color:#ffd794;font-size:12px;line-height:1.5;margin:4px 0}',
            '.dnf-cp-opt{display:flex;align-items:center;gap:8px;font-size:12px;color:#e6d3b3;margin:8px 0}',
            '.dnf-cp-opt input{width:16px;height:16px}',
            '.dnf-cp-log{max-height:180px;overflow-y:auto;border:1px solid #3f3123;border-radius:6px;' +
                'background:#1a130c;padding:6px 8px;font:12px/1.5 Consolas,Microsoft YaHei,monospace;' +
                'color:#c8b593;white-space:pre-wrap}',
            '.dnf-cp-log .ok{color:#8ee6a0}',
            '.dnf-cp-log .err{color:#ff9a9a}',
            '.dnf-cp-log .warn{color:#ffd794}',
            '.dnf-cp-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:8px}',
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
            // ===== 立即处理收益弹窗（v5.95）=====
            '.dnf-fg-sec{margin:0 0 10px;padding:8px 10px;border:1px solid #3f3123;' +
                'background:#261e15;border-radius:8px}',
            '.dnf-fg-sec-title{color:#ffd794;font-weight:700;font-size:12px;margin-bottom:4px;' +
                'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
            '.dnf-fg-row{display:flex;justify-content:space-between;gap:8px;font-size:12px;' +
                'color:#edddc3;margin:2px 0;min-width:0}',
            '.dnf-fg-row>span:first-child{min-width:0;overflow-wrap:anywhere}',
            '.dnf-fg-row>span:last-child{color:#ffd794;white-space:nowrap;flex:0 0 auto}',
            '.dnf-fg-note{color:#baa78e;font-size:11px;margin-top:4px}',
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
        // v5.90：不再单独观察 document.body（与红字观察者重复遍历），
        // 改为挂到统一 DOM 变更总线上，且只在「地图怪物框」内变化时才重算。
        _domBusHpHooked = true;
        refreshDungeonPanelEl();
        initDomBus();
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
        } else if (moduleLayoutMode() === 'tablet') {
            // v6.01：平板下功能框的父节点由 applyModuleOrder / syncTabletTabsParent
            // 统一管理（临时放进 .center-col 参与栏内排序）。这里必须直接返回，
            // 否则本函数与它每 1.2 秒把 .right-col 在 .main 与 .center-col 之间
            // 来回搬一次，输入框子树被反复摘挂，虚拟键盘刚弹出就会立刻收起。
            return;
        } else {
            // 桌面：还原为 .main 的第三个栅格列
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
    /**
     * v5.101：强化 / 增幅保护券提醒（拦一次）
     * ------------------------------------------------------------------
     * 只读判断：craftMode ∈ {enhance, amplify}、当前等级 ≥ 10、未勾选保护券。
     * 第一次点击执行按钮只提示、不执行（preventDefault），第二次点击放行；
     * 勾选保护券后不再提示；同一「模式+当前等级」10 秒内只提示一次。
     * 不改原生节点、不改原生数字显示，仅读取 store 与勾选框状态。
     */
    function initProtectGuard() {
        if (document.__dnfProtect5101) return;
        document.__dnfProtect5101 = true;
        const guard = { pending: null, lastKey: '', lastAt: 0, instance: null, mask: null };

        function resetGuard() { guard.pending = null; guard.lastKey = ''; guard.lastAt = 0; guard.instance = null; }
        function readProtect(store) {
            try {
                if (store && store.craftProtect && typeof store.craftProtect.value === 'boolean') return store.craftProtect.value;
            } catch (_) { }
            const mask = document.querySelector('.modal-mask');
            const cb = mask && Array.from(mask.querySelectorAll('input[type="checkbox"]'))
                .find(i => /保护券/.test(((i.closest('label') || i.parentElement || {}).textContent || '')));
            return !!(cb && cb.checked);
        }

        document.addEventListener('click', (e) => {
            const node = e.target;
            if (!node || !node.closest) return;
            const btn = node.closest('.modal-mask button');
            if (!btn) return;
            const label = (btn.textContent || '').trim();
            if (label !== '强化' && label !== '增幅') return;
            if (btn.disabled) return;

            const store = getGameStore();
            if (!store || !store.craftMode || !store.craftMode.value) return;
            const mode = store.craftMode.value;
            if (mode !== 'enhance' && mode !== 'amplify') return;

            const mask = btn.closest('.modal-mask');
            if (guard.mask !== mask) { resetGuard(); guard.mask = mask; }

            const sel = store.selectedCraftItem && store.selectedCraftItem.value;
            const item = sel ? sel.item : null;
            if (!item) return;
            const cost = mode === 'amplify'
                ? (store.amplifyCost && store.amplifyCost.value)
                : (store.enhanceCost && store.enhanceCost.value);
            const target = cost ? Number(cost.target) : NaN;
            if (!Number.isFinite(target)) return;              // 已到上限/不可执行，不拦
            const cur = Number(mode === 'amplify' ? item.amplify_level : item.enhance_level) || 0;
            if (cur < 10) return;                              // +9 冲 +10 不提示

            if (readProtect(store)) { guard.pending = null; return; }

            const inst = String(item.instance_id || item.id || '');
            if (guard.instance !== inst) { resetGuard(); guard.instance = inst; }

            const key = mode + ':' + cur;
            const now = Date.now();
            // 第二次点击放行
            if (guard.pending && guard.pending.key === key && now - guard.pending.at <= 10000) {
                guard.pending = null;
                return;
            }
            // 同一模式+等级 10 秒内只提示一次：其余点击直接放行，不重复提示
            if (guard.lastKey === key && now - guard.lastAt < 10000) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            guard.pending = { key: key, at: now };
            guard.lastKey = key;
            guard.lastAt = now;
            const word = mode === 'amplify' ? '增幅' : '强化';
            showTip('当前' + word + ' +' + cur + ' 未勾选' + word + '保护券，本次未执行；勾选「使用' + word + '保护券」后再点一次');
        }, true);
    }

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
    /* v5.91：详情页「分解」按钮的请求节流，避免连点并发 */
    let _decomposeBusy = false;

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
        if (_depositBusy || _decomposeBusy) return;
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

    /* v5.90：注入框改为模块级引用，清理时用 isConnected 短路，
       不再每秒全文档查 [data-dnf-deposit-box]。 */
    let _depositBoxEl = null;

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

        // 弹窗关闭或切换到别的弹窗：清掉残留注入框（v5.90：只查模块级引用，不全文档扫描）
        if (_depositBoxEl && (!_depositBoxEl.isConnected || !mask || !mask.contains(_depositBoxEl))) {
            _depositBoxEl.remove();
            _depositBoxEl = null;
        }

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
        _depositBoxEl = box;

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
        box.append(btn);
        // v5.98：材料/消耗品详情在「存仓」右侧加上架拍卖（装备不显示，装备请在拍卖行内上架）
        if (item.kind !== 'equipment') {
            box.append(createAuctionButton(store, box, item));
        }
        // v5.91：背包装备详情在「存仓」右侧加「分解」（与存仓同一行）
        if (sub === 'equip' && item.kind === 'equipment') {
            box.append(createDecomposeButton(store, box, item));
        }
        box.append(msg);
        actions.appendChild(box);
    }

    /* ============================================================
     * 背包材料/消耗品「上架拍卖」按钮（v5.98）
     *
     * 不做自建接口：直接调用游戏 store 的原生上架流程
     *   store.openAuctionList() -> 刷新背包并打开「上架物品」面板
     *   store.auctionCandidates -> 游戏自己过滤后的可上架清单
     *   store.pickAuctionTarget(x) -> 选中目标并回填参考价
     * 玩家在原生面板里确认价格后才真正发出请求。
     * ============================================================ */
    // 与游戏内 auctionCandidates 使用的绑定/不可交易清单保持一致
    const AUCTION_BOUND_IDS = new Set([
        3213, 3215, 3219, 3256, 3280, 3282, 3330, 2682582,
        4083, 3209, 4176, 4343, 4421, 4430, 4830, 10095702,
    ]);

    function auctionBlockedReason(item) {
        if (!item || item.kind === 'equipment') return '装备请在拍卖行内上架';
        if (!(Number(item.count) > 0)) return '数量不足，无法上架';
        if (AUCTION_BOUND_IDS.has(Number(item.item_id))) return '该物品为绑定 / 不可交易';
        return '';
    }

    function createAuctionButton(store, box, item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'da-btn dnf-deposit-btn dnf-auction-btn';
        btn.textContent = '上架拍卖';
        const blocked = auctionBlockedReason(item);
        btn.title = blocked ? ('无法上架：' + blocked) : '打开游戏拍卖行的上架面板';
        if (blocked) {
            btn.disabled = true;
        } else {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openNativeAuctionList(store, box, item, btn);
            });
        }
        return btn;
    }

    /** 调游戏自身的上架面板；解析不到可上架条目时关闭面板并说明原因 */
    async function openNativeAuctionList(store, box, item, btn) {
        if (!store || typeof store.openAuctionList !== 'function') {
            setDepositMsg(box, '当前游戏版本不支持拍卖上架', true);
            return;
        }
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '打开中…';
        setDepositMsg(box, '', false);
        try {
            await store.openAuctionList();
            const list = store.auctionCandidates && store.auctionCandidates.value
                ? store.auctionCandidates.value : [];
            const hit = list.find(x => Number(x.item_id) === Number(item.item_id) && x.kind !== 'equipment');
            if (!hit) {
                if (store.auctionListOpen) store.auctionListOpen.value = false;
                setDepositMsg(box, '该物品不可上架：绑定或不可交易', true);
                return;
            }
            if (typeof store.pickAuctionTarget === 'function') store.pickAuctionTarget(hit);
            // v5.99：原生上架面板（.modal-mask z-index:200）低于详情弹窗（z-index:260），
            // 面板弹出后详情会把「上架数量 / 单件价格 / 确认上架」整块压住。
            // 这里在预选成功后直接关闭详情（与游戏原生「上架拍卖」的行为一致），
            // 不改 z-index、不加 !important；详情关掉后拍卖面板仍保持打开且可正常操作。
            // 原生面板之后被关闭时，用户回到背包即可，不会残留悬空浮层。
            closeGameDetail(store);
        } catch (err) {
            setDepositMsg(box, (err && err.message) ? err.message : '打开拍卖行失败', true);
        } finally {
            btn.textContent = old;
            btn.disabled = !!auctionBlockedReason(item);
        }
    }


    /* ============================================================
     * 背包装备详情「分解」按钮（v5.91）
     *
     * 落点：复用「存仓」注入框（data-dnf-deposit-box），按钮排在存仓右侧同一行。
     * 主路径（默认）：备份当前背包选中 → 暂时只选中目标装备 → 调游戏原生
     *   store.decomposeBagSelection() → finally 还原原选中。
     *   确认框、原生 toast、背包/材料刷新、busy 全部交给游戏自己。
     * 降级：拿不到原生分解方法（或目标不在当前背包视图）时，改走
     *   POST /api/characters/{id}/decompose { instance_id }，自弹 confirm，
     *   成功后复用 v5.88 的分解所得提示并刷新背包。
     * 安全：
     *   - 原生路径只保留游戏自身那一次确认，插件不再重复询问；
     *   - 降级路径（无原生确认兜底）仍由插件弹一次确认；
     *   - 锁定 / 红字（cursed）/ 已穿戴 / 非装备 / 不在背包 → 置灰并说明原因；
     *   - 请求期间禁用按钮并节流，避免连点并发。
     * ============================================================ */
    const RARITY_NAMES = ['普通', '高级', '稀有', '神器', '史诗', '勇者', '传说'];

    function rarityNameOf(rarity) {
        const n = Number(rarity);
        return Number.isFinite(n) && RARITY_NAMES[n] ? RARITY_NAMES[n] : '';
    }

    function decomposeDisabledReason(store, item) {
        if (!item) return '没有可分解的装备';
        if (item.kind !== 'equipment') return '只有装备可以分解';
        if (item.locked) return '装备已锁定，请先解锁';
        if (item.cursed) return '红字（被诅咒）装备无法分解';
        const slot = store.detailEquippedSlot ? store.detailEquippedSlot.value : '';
        if (slot) return '已穿戴，请先卸下再分解';
        if (store.detailInInventory && !store.detailInInventory.value) return '物品不在背包中，无法分解';
        if (!(Number(item.instance_id) > 0)) return '该装备没有实例编号，无法分解';
        return '';
    }

    function bagSelectKey(x) {
        if (!x) return '';
        return Number(x.instance_id) > 0 ? 'e' + Number(x.instance_id) : 's' + x.item_id;
    }

    /** 当前背包选中项（只读快照；bagSelectedItems 是 computed，不能直接赋值） */
    function currentBagSelection(store) {
        try {
            const v = store.bagSelectedItems ? store.bagSelectedItems.value : null;
            return Array.isArray(v) ? v.slice() : [];
        } catch (_) { return []; }
    }

    function itemInBagView(store, item) {
        const key = bagSelectKey(item);
        try {
            const list = store.bagViewItems ? store.bagViewItems.value : null;
            return Array.isArray(list) ? list.some(x => bagSelectKey(x) === key) : false;
        } catch (_) { return false; }
    }

    function canUseNativeDecompose(store, item) {
        return !!(store && typeof store.decomposeBagSelection === 'function'
            && typeof store.toggleBagItemSelect === 'function'
            && store.bagSelectedItems && store.bagViewItems
            && itemInBagView(store, item));
    }

    function createDecomposeButton(store, box, item) {
        const reason = decomposeDisabledReason(store, item);
        const rn = rarityNameOf(item.rarity);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'da-btn dnf-deposit-btn dnf-decompose-btn';
        btn.textContent = '分解';
        if (reason) {
            btn.disabled = true;
            btn.title = '无法分解：' + reason;
        } else {
            btn.title = '分解这件装备' + (rn ? '（' + rn + '）' : '');
        }
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            decomposeDetailItem(store, box, item, btn);
        });
        return btn;
    }

    /** 原生分解：只让目标装备处于选中态，结束后还原用户原选中 */
    async function decomposeViaStore(store, box, item) {
        const inst = Number(item.instance_id) || 0;
        const before = currentBagSelection(store);
        const targetKey = bagSelectKey(item);

        // 先清空已有选中，避免把用户之前勾选的其它装备一起分解
        for (const x of before) {
            try { store.toggleBagItemSelect(x); } catch (_) { }
        }
        try { store.toggleBagItemSelect(item); } catch (_) { }
        try {
            await store.decomposeBagSelection();
        } finally {
            // 清掉残留（含目标），再还原原选中；目标已被分解则不再还原
            for (const x of currentBagSelection(store)) {
                try { store.toggleBagItemSelect(x); } catch (_) { }
            }
            const visible = store.bagViewItems ? store.bagViewItems.value : null;
            for (const x of before) {
                const k = bagSelectKey(x);
                if (k === targetKey) continue;
                if (Array.isArray(visible) && !visible.some(v => bagSelectKey(v) === k)) continue;
                try { store.toggleBagItemSelect(x); } catch (_) { }
            }
        }

        // 结果判定：分解成功则目标已从背包消失；取消确认/失败时仍在
        let still = null;
        try {
            const inv = store.inventory ? store.inventory.value : null;
            if (Array.isArray(inv)) still = inv.some(x => Number(x.instance_id) === inst);
        } catch (_) { }
        if (still === false) {
            if (store.detailItem) store.detailItem.value = null;
            return true;
        }
        if (still === true) {
            const err = store.error ? store.error.value : '';
            if (err) setDepositMsg(box, String(err), true);
        }
        return false;
    }

    /** 降级：单件分解接口（自弹确认） */
    async function decomposeViaApi(store, box, item) {
        const rn = rarityNameOf(item.rarity);
        const label = '「' + (item.name || '装备') + '」' + (rn ? '（' + rn + '）' : '');
        const ok = window.confirm('确认分解' + label + '？分解后无法恢复。');
        if (!ok) return false;
        const data = await postCharacterApi(store, 'decompose',
            { instance_id: Number(item.instance_id) }, 12000, '分解失败');
        if (store.detailItem) store.detailItem.value = null;
        // 收益弹窗由 onDecomposeResponse 统一处理，这里只在没有产物时兜底提示
        if (!(data && Array.isArray(data.outputs) && data.outputs.length)) {
            showTip('已分解：' + (item.name || '装备'));
        }
        try {
            const tasks = [];
            if (typeof store.loadInventory === 'function') tasks.push(store.loadInventory());
            if (tasks.length) await Promise.all(tasks);
        } catch (_) { }
        return true;
    }

    async function decomposeDetailItem(store, box, item, btn) {
        if (_decomposeBusy || _depositBusy) return;
        const reason = decomposeDisabledReason(store, item);
        if (reason) { setDepositMsg(box, reason, true); return; }

        _decomposeBusy = true;
        btn.disabled = true;
        btn.textContent = '分解中…';
        setDepositMsg(box, '', false);
        try {
            if (canUseNativeDecompose(store, item)) {
                await decomposeViaStore(store, box, item);
            } else {
                await decomposeViaApi(store, box, item);
            }
        } catch (err) {
            setDepositMsg(box, (err && err.message) ? err.message : '分解失败，请稍后重试', true);
        } finally {
            _decomposeBusy = false;
            if (btn.isConnected) {
                btn.textContent = '分解';
                btn.disabled = !!decomposeDisabledReason(store, item);
            }
        }
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

    /** v5.97：名字规范化（去掉所有空白），用于跨端空格差异的二次校验 */
    function normWarehouseName(s) {
        return String(s || '').replace(/\s+/g, '');
    }
    /** v5.97：图标键（icon_path + icon_index），与格子 img 的 sprite 文件名一致 */
    function warehouseIconKey(path, index) {
        return String(path || '').toLowerCase().replace(/\.img$/, '').replace(/\//g, '_')
            + '_' + (Number(index) || 0);
    }
    function warehouseCellIconKey(cell) {
        const img = cell && cell.querySelector ? cell.querySelector('img') : null;
        const src = img ? String(img.getAttribute('src') || '') : '';
        const m = /sprite_([a-z0-9_]+?)\.png$/i.exec(src);
        return m ? m[1].toLowerCase() : '';
    }

    /** 由格子反查装备：优先按「渲染同源列表」的下标取 instance_id，失败再用规范化名字/存入者 */
    function warehouseEquipFromCell(store, cell) {
        if (!store) return null;
        const wh = store.warehouse ? store.warehouse.value : null;
        const filtered = store.warehouseEquipFiltered ? store.warehouseEquipFiltered.value : null;
        const list = Array.isArray(filtered) && filtered.length
            ? filtered
            : (wh && Array.isArray(wh.equipment) ? wh.equipment : []);
        if (!list.length) return null;

        const title = cell.getAttribute('title') || '';
        const name = normWarehouseName(title.split('（存入者：')[0]);
        const ownerMatch = /（存入者：([^，]*)，/.exec(title);
        const owner = ownerMatch ? ownerMatch[1].trim() : '';
        const grid = cell.parentElement;
        const gridCount = grid ? grid.children.length : 0;

        if (grid) {
            const idx = Array.prototype.indexOf.call(grid.children, cell);
            const hit = idx >= 0 ? list[idx] : null;
            if (hit && Number(hit.instance_id) > 0) {
                const sameName = !name || normWarehouseName(hit.name) === name;
                const sameOwner = !owner || !hit.owner_name || String(hit.owner_name).trim() === owner;
                // 同源下标（网格数量与列表一致）即可信；否则要求名字或存入者至少一项吻合
                if (sameName || sameOwner || gridCount === list.length) return asWarehouseEquip(hit);
            }
        }
        const found = list.find(x => x && Number(x.instance_id) > 0
            && normWarehouseName(x.name) === name
            && (!owner || !x.owner_name || String(x.owner_name).trim() === owner));
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

            // v5.97：先确定装备，成功后才阻断；解析失败交给原生点击
            const store = getGameStore();
            const item = warehouseEquipFromCell(store, cell);
            if (!item) return;

            // 阻断 Vue 绑定在格子上的 warehouseEquipWithdraw，走插件详情流程
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
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

    /* v5.90：同上，仓库取出浮层用模块级引用清理 */
    let _whWithdrawBoxEl = null;

    /** 详情弹窗底部维护「确认取出 / 取消」浮层（只加自己的节点） */
    function applyWarehouseWithdrawBox() {
        const store = getGameStore();
        const panel = document.querySelector('.modal-mask .modal.panel');
        const detail = store && store.detailItem ? store.detailItem.value : null;
        const inst = detail ? Number(detail.instance_id) || 0 : 0;
        const wh = store && store.warehouse ? store.warehouse.value : null;
        const isWarehouseItem = !!(inst && wh && Array.isArray(wh.equipment) &&
            wh.equipment.some(x => Number(x.instance_id) === inst));

        // 弹窗关闭 / 切到背包物品：清掉插件浮层（v5.90：只查模块级引用）
        if (_whWithdrawBoxEl && (!_whWithdrawBoxEl.isConnected || !isWarehouseItem || !panel || !panel.contains(_whWithdrawBoxEl))) {
            _whWithdrawBoxEl.remove();
            _whWithdrawBoxEl = null;
        }
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
        _whWithdrawBoxEl = box;

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

    /** 从仓库道具格子反查条目：以「渲染同源列表」的格子下标为主，名字/图标仅作校验 */
    function warehouseMaterialFromCell(store, cell) {
        if (!store) return null;
        const wh = store.warehouse ? store.warehouse.value : null;
        const all = wh && Array.isArray(wh.items) ? wh.items.filter(x => x && x.item_id) : [];
        if (!all.length) return null;
        // 游戏渲染用的是 whItemsFiltered（受「材料/消耗品」子标签筛选影响），必须同源取下标
        const filtered = store.whItemsFiltered ? store.whItemsFiltered.value : null;
        const list = Array.isArray(filtered) && filtered.length
            ? filtered.filter(x => x && x.item_id)
            : all;
        const title = cell.getAttribute('title') || '';
        // v5.97：数量从末尾「×N（点击取出）」提取，名字不再按 × 切分（防名字自带 ×）
        const name = normWarehouseName(title.replace(/×\d+\s*（点击取出）\s*$/, ''));
        const icon = warehouseCellIconKey(cell);
        const grid = cell.parentElement;
        const gridCount = grid ? grid.children.length : 0;

        if (grid) {
            const idx = Array.prototype.indexOf.call(grid.children, cell);
            const hit = idx >= 0 ? list[idx] : null;
            if (hit) {
                const sameName = !name || normWarehouseName(hit.name) === name;
                const sameIcon = !icon || warehouseIconKey(hit.icon_path, hit.icon_index) === icon;
                // 同源下标（网格数量与列表一致）即可信；否则要求名字或图标至少一项吻合
                if (sameName || sameIcon || gridCount === list.length) return hit;
            }
        }
        // 兜底 1：规范化名字（唯一命中）
        const named = list.filter(x => normWarehouseName(x.name) === name);
        if (named.length === 1) return named[0];
        // 兜底 2：图标（唯一命中）
        if (icon) {
            const byIcon = list.filter(x => warehouseIconKey(x.icon_path, x.icon_index) === icon);
            if (byIcon.length === 1) return byIcon[0];
        }
        // 兜底 3：筛选列表与全量不一致时，再在仓库全量里按名字/图标找一次
        if (list !== all) {
            const namedAll = all.filter(x => normWarehouseName(x.name) === name);
            if (namedAll.length === 1) return namedAll[0];
            if (icon) {
                const iconAll = all.filter(x => warehouseIconKey(x.icon_path, x.icon_index) === icon);
                if (iconAll.length === 1) return iconAll[0];
            }
        }
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
        sub.textContent = String(item.name || '材料').trim() + ' · 仓库持有 ' + held;

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
            if (title.indexOf('（点击取出）') === -1) return;        // 只拦仓库道具

            // v5.97：先确定物品，成功后才阻断；解析失败交给原生点击（整组取出）
            const store = getGameStore();
            const item = warehouseMaterialFromCell(store, node);
            if (!item) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
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

    /* v5.90：秘宝盒「全开」按钮头用模块级引用清理 */
    let _clearboxHeadEl = null;

    function applyClearBoxAllButton() {
        // 清理不在秘宝盒面板里的残留按钮（v5.90：只查模块级引用，不全文档扫描）
        if (_clearboxHeadEl && (!_clearboxHeadEl.isConnected || !_clearboxHeadEl.closest('.clearbox-panel'))) {
            _clearboxHeadEl.remove();
            _clearboxHeadEl = null;
        }

        const panel = document.querySelector('.bag-tab > .clearbox-panel') ||
            document.querySelector('.clearbox-panel');
        if (!panel) return;

        let head = panel.querySelector('.dnf-clearbox-head');
        if (!head) {
            head = document.createElement('div');
            head.className = 'dnf-clearbox-head';
            _clearboxHeadEl = head;
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
        _clearboxHeadEl = head;
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
            // v5.90：同一父节点的矩形只量一次，避免循环内反复强制同步布局
            const rectCache = new Map();
            const rectOf = node => {
                let r = rectCache.get(node);
                if (!r) { r = node.getBoundingClientRect(); rectCache.set(node, r); }
                return r;
            };
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
                    const r = rectOf(node);
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
     * 扫描调度（模块级唯一入口：角色软重置、1s 轮询、DOM 变更都走这里）
     *  - runLightScans（轻量）：只做纯 DOM 维护，不读取页面文本
     *  - runScans（全量）：轻量 + 死亡/登录/结算等文本检测
     * v5.90：删掉了 start() 内重复定义的一套，避免两处逻辑漂移；
     *        角色切换重置时也能把 4 处 UI 修正一起补上。
     * ============================================================ */
    function runLightScans() {
        relocateTabsAfterSettlement();
        applyModuleOrder();
        applyHideUnlearnedSkills();
        applyUiTheme();
        applyGameAssistantVisibility();
        applyGameUiTweaks();
        applyDetailDepositButton();
        applyNativeProfileCopyButton();
        applyWarehouseWithdrawBox();
        applyClearBoxAllButton();
    }
    function runScans() {
        runLightScans();
        if (CONFIG.enableReviveHud) {
            checkLoginAndReset();
            scanSettlement();
            scanBattleLog();
            scanLevelExp();
            scanAssistStats();
        }
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
    /* ============================================================
     * 装备图鉴数据（v5.100：首次打开时才加载）
     * ------------------------------------------------------------
     * 旧版把 446 条史诗以数组字面量内联（约 210KB，脚本启动即解析）。
     * 现在只保留两样小数据：
     *   ① ATLAS_SEED      —— 最小基线（11 条），断网或接口全挂时图鉴也不会空白；
     *   ② ATLAS_ID_RANGES —— ID 段枚举表（[start,end] 扁平成对存放），
     *                        由「装备商店 / 编年史商店 / 兑换商店 / 拍卖行 /
     *                        /api/item-effects / 上一轮 ID 段扫描」的结果去重后，
     *                        按「间隔 ≤2 合并」压缩成 1862 段、共 7745 个 id。
     * 用户第一次点开「装备」页时才开始逐件 GET /api/items/{id}，
     * 只保留 rarity 4（史诗）与 6（传说），结果写入 localStorage 缓存。
     * 稀有度数值取自游戏自身映射：
     *   ["普通","高级","稀有","神器","史诗","勇者","传说"] → 4=史诗、6=传说。
     * 不做等级限制。详情字段由接口数据映射，技能名走
     * /api/meta/skill-names（"职业:技能id" → 中文名）。
     * ============================================================ */
    const ATLAS_SEED = [
        {"id":101000199,"name":"天丛云","level":85,"slot":"weapon","armor":"","wg":"ssword","type":"短剑","icon":"/assets/icons/sprite_item_new_equipment_01_weapon_swordman_sswd_sswd_107.png","rarity":4},
        {"id":100050203,"name":"逝魔之疾咒长袍","level":85,"slot":"coat","armor":"cloth","wg":"","type":"布甲上衣","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_coat_cloth_coat_21.png","rarity":4},
        {"id":100100133,"name":"逝魔之暴烈长裤","level":85,"slot":"pants","armor":"cloth","wg":"","type":"布甲下装","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_pants_cloth_pants_19.png","rarity":4},
        {"id":100150124,"name":"逝魔之灵悟肩甲","level":85,"slot":"shoulder","armor":"cloth","wg":"","type":"布甲头肩","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_neck_cloth_neck_17.png","rarity":4},
        {"id":100200104,"name":"逝魔之灵心腰带","level":85,"slot":"belt","armor":"cloth","wg":"","type":"布甲腰带","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_belt_cloth_belt_17.png","rarity":4},
        {"id":100250109,"name":"逝魔之风速短靴","level":85,"slot":"shoes","armor":"cloth","wg":"","type":"布甲鞋","icon":"/assets/icons/sprite_item_new_equipment_02_cloth_shoes_cloth_shoes_17.png","rarity":4},
        {"id":100300212,"name":"贪食之影","level":85,"slot":"amulet","armor":"","wg":"","type":"项链","icon":"/assets/icons/sprite_item_new_equipment_08_necklace_necklace_172.png","rarity":4},
        {"id":100310527,"name":"被囚者的染血手铐","level":85,"slot":"wrist","armor":"","wg":"","type":"手镯","icon":"/assets/icons/sprite_item_new_equipment_09_bracelet_bracelet_96.png","rarity":4},
        {"id":100320591,"name":"冰雪公主的霜语戒指","level":85,"slot":"ring","armor":"","wg":"","type":"戒指","icon":"/assets/icons/sprite_item_new_equipment_07_ring_ring_144.png","rarity":4},
        {"id":100350657,"name":"空城泪 - 旧王愁","level":85,"slot":"magicstone","armor":"","wg":"","type":"魔法石","icon":"/assets/icons/sprite_item_new_equipment_11_magicstone_magicstone_124.png","rarity":4},
        {"id":100340219,"name":"诸神之智 - 剑魂","level":80,"slot":"support","armor":"","wg":"","type":"辅助装备","icon":"/assets/icons/sprite_item_new_equipment_10_support_support_79.png","rarity":4}
    ];
    const ATLAS_ID_RANGES = [
        10030,10030,10034,10034,10038,10039,10049,10049,10069,10070,10073,10074,10077,10077,10098,10103,10110,10111,10114,10116,10120,10120,10134,10134,10143,10146,10185,10185,
        10190,10192,10205,10205,10442,10442,10469,10469,10473,10473,10477,10479,10486,10487,10492,10493,10505,10505,10514,10514,10517,10517,10551,10551,10554,10554,10559,10561,
        10572,10572,10816,10816,10830,10830,10843,10843,10850,10850,10856,10856,10868,10870,10874,10874,10883,10884,10887,10889,10895,10895,10908,10908,10914,10914,10917,10919,
        10956,10959,10963,10965,10969,10971,11230,11230,11256,11256,11279,11279,11283,11284,11287,11287,11291,11293,11307,11307,11313,11313,11317,11317,11344,11346,11355,11358,
        11605,11605,11619,11619,11631,11631,11637,11637,11652,11653,11656,11659,11668,11668,11672,11673,11700,11702,12131,12131,12187,12189,12197,12197,12503,12503,12556,12558,
        12569,12569,12887,12887,12905,12905,12913,12913,12957,12959,12963,12965,13287,13287,13290,13291,13306,13306,13312,13313,13316,13316,13343,13344,13348,13348,13353,13353,
        13655,13655,13666,13666,13670,13670,13699,13701,14030,14032,14046,14046,14064,14064,14069,14069,14079,14079,14118,14118,14126,14126,14171,14173,14493,14493,14502,14502,
        14547,14548,14552,14552,14878,14878,14882,14882,14897,14898,14904,14908,14953,14955,15278,15281,15296,15296,15302,15305,15334,15336,15663,15663,15667,15667,15698,15699,
        16108,16108,16163,16164,16481,16481,16492,16492,16503,16503,16545,16547,16895,16895,16946,16947,17294,17294,17328,17330,17661,17661,17692,17693,17697,17697,18115,18115,
        18171,18172,18500,18500,18555,18556,18902,18902,18955,18956,19300,19300,19335,19336,19667,19667,19700,19702,19705,19705,20016,20016,20060,20060,20080,20080,20100,20101,
        20105,20114,20117,20117,20120,20125,20129,20133,20136,20136,20139,20145,20166,20166,20188,20189,20240,20244,20254,20254,22030,22030,22072,22072,22109,22109,22112,22112,
        22115,22121,22124,22124,22128,22132,22136,22136,22181,22181,22228,22228,22232,22232,22247,22247,24014,24014,24023,24023,24046,24046,24060,24060,24064,24064,24081,24081,
        24108,24115,24118,24120,24125,24129,24133,24134,24137,24145,24148,24149,24159,24159,24177,24190,24210,24210,24259,24262,24265,24267,26034,26034,26043,26043,26049,26049,
        26054,26055,26059,26059,26071,26071,26074,26074,26081,26081,26084,26084,26092,26094,26100,26103,26108,26119,26125,26134,26151,26152,26155,26160,26164,26165,26168,26170,
        26173,26173,26176,26183,26197,26197,26212,26228,26231,26234,26242,26247,26251,26258,26263,26280,26301,26310,26313,26314,26319,26338,26341,26342,26348,26348,26356,26368,
        26372,26373,26376,26381,26392,26392,26395,26495,26498,26500,26503,26516,26530,26540,26550,26550,26560,26560,26564,26564,26567,26567,26573,26573,26580,26581,26586,26586,
        26589,26589,26596,26596,26600,26600,26604,26606,26620,26620,26626,26627,26634,26634,26645,26650,26661,26661,26666,26666,26669,26669,26685,26685,26689,26689,26694,26695,
        26709,26709,26719,26734,26738,26751,26754,26759,26762,26775,26778,26783,26787,26792,26798,26804,26807,26814,26817,26822,26828,26832,27013,27013,27020,27020,27027,27027,
        27032,27033,27038,27038,27041,27041,27055,27055,27059,27059,27063,27063,27066,27069,27075,27075,27078,27081,27093,27093,27096,27103,27106,27106,27114,27116,27122,27122,
        27130,27131,27138,27139,27142,27142,27148,27154,27165,27168,27320,27320,27325,27327,27332,27332,27337,27337,27347,27347,27351,27351,27359,27359,27362,27362,27500,27500,
        27509,27509,27513,27514,27518,27518,27522,27522,27529,27533,27546,27547,27550,27553,27556,27556,27559,27560,27565,27568,27573,27573,27579,27579,27583,27583,27588,27591,
        27598,27598,27615,27615,27622,27622,27628,27628,27632,27633,27638,27638,27650,27651,27661,27662,27667,27668,27673,27679,27690,27692,27696,27701,27704,27705,27709,27714,
        27718,27718,27721,27721,27726,27726,27729,27732,27737,27739,27742,27742,27747,27747,27752,27754,27762,27767,27901,28047,28052,28061,28207,28207,28216,28216,28220,28220,
        28223,28223,28231,28232,28239,28240,28246,28251,28255,28255,28264,28265,28268,28271,28274,28274,28279,28281,28284,28285,28288,28288,28293,28293,28296,28298,28304,28307,
        28310,28310,28316,28320,28328,28328,28332,28333,29018,29020,29025,29025,29035,29036,29047,29047,29053,29053,29057,29057,29060,29060,29068,29071,29079,29081,29093,29094,
        29097,29100,29103,29104,29107,29107,29112,29112,29115,29116,29119,29121,29124,29124,29130,29134,29139,29142,29145,29146,29157,29159,29168,29168,29171,29171,29319,29319,
        29327,29329,29332,29332,29335,29335,29344,29344,29351,29352,29355,29355,29360,29363,29368,29368,29373,29373,29376,29378,29384,29389,29397,29400,29410,29411,29414,29415,
        29616,29618,29623,29623,29627,29628,29632,29633,29636,29636,29645,29645,29650,29650,29654,29654,29657,29658,29661,29662,29665,29667,29674,29679,29695,29702,29705,29705,
        29710,29713,29719,29719,29724,29724,29727,29729,29735,29736,29740,29740,29744,29744,29747,29752,29760,29760,29763,29766,29918,29918,29926,29926,29938,29938,29941,29941,
        29944,29945,29952,29952,29959,29959,29967,29969,29977,29979,29993,30000,30003,30004,30008,30012,30031,30035,30042,30043,30046,30047,30055,30058,30062,30062,30200,30261,
        30264,30315,30320,30329,31037,31039,31060,31060,31064,31064,31077,31080,31093,31100,31103,31104,31107,31107,31112,31116,31119,31119,31124,31124,31129,31129,31134,31134,
        31138,31142,31148,31148,31151,31154,31167,31170,31333,31335,31338,31339,31342,31342,31354,31354,31357,31357,31362,31362,31367,31368,31375,31379,31394,31394,31397,31400,
        31403,31403,31409,31411,31416,31416,31425,31426,31432,31435,31441,31444,31457,31460,31632,31632,31637,31638,31653,31653,31661,31661,31667,31667,31670,31674,31689,31689,
        31693,31694,31697,31698,31701,31701,31707,31709,31713,31713,31722,31723,31729,31733,31741,31742,31757,31757,31932,31936,31939,31941,31945,31945,31950,31951,31957,31957,
        31961,31961,31966,31967,31972,31978,31992,31995,31998,31998,32004,32007,32010,32010,32015,32015,32018,32020,32026,32027,32030,32030,32035,32038,32041,32041,32049,32053,
        32234,32235,32238,32238,32244,32244,32256,32256,32260,32260,32266,32266,32273,32278,32290,32297,32300,32301,32305,32309,32315,32315,32323,32323,32333,32336,32348,32350,
        32361,32364,33022,33024,33027,33036,33042,33043,33055,33056,33059,33060,33063,33064,33067,33067,33072,33072,33075,33076,33079,33079,33083,33083,33091,33093,33098,33100,
        33103,33104,33110,33113,33121,33128,33324,33326,33330,33330,33333,33333,33342,33342,33355,33359,33363,33368,33371,33371,33378,33384,33388,33388,33394,33398,33403,33405,
        33408,33408,33415,33418,33427,33432,33627,33627,33635,33635,33639,33641,33658,33660,33663,33664,33667,33667,33672,33678,33683,33683,33688,33688,33693,33693,33699,33704,
        33707,33707,33712,33714,33722,33722,33725,33727,33730,33730,33926,33926,33931,33932,33942,33942,33958,33960,33965,33966,33969,33969,33976,33976,33988,33991,33998,33999,
        34009,34009,34013,34014,34028,34028,34031,34031,34217,34220,34223,34223,34226,34226,34229,34230,34242,34242,34245,34245,34250,34252,34256,34259,34262,34262,34268,34268,
        34272,34272,34278,34283,34288,34288,34291,34294,34298,34304,35025,35025,35033,35037,35040,35041,35053,35053,35059,35059,35062,35063,35066,35066,35071,35075,35088,35088,
        35096,35098,35101,35101,35110,35113,35127,35128,35327,35327,35333,35333,35336,35336,35340,35340,35351,35351,35354,35354,35358,35359,35362,35362,35367,35371,35380,35380,
        35391,35394,35400,35400,35403,35405,35417,35417,35420,35420,35623,35623,35633,35633,35637,35640,35652,35653,35659,35659,35662,35663,35669,35672,35677,35677,35682,35682,
        35686,35687,35693,35698,35702,35707,35716,35722,35923,35927,35931,35936,35939,35945,35948,35948,35964,35969,35978,35980,35987,35992,35997,36003,36012,36013,36016,36018,
        36223,36223,36228,36230,36233,36233,36237,36240,36251,36254,36257,36258,36261,36261,36267,36272,36276,36276,36286,36286,36293,36298,36303,36309,36318,36319,37021,37021,
        37030,37030,37033,37033,37037,37048,37061,37065,37072,37072,37077,37077,37081,37081,37085,37085,37091,37096,37099,37109,37117,37124,37310,37310,37316,37316,37319,37319,
        37328,37328,37337,37339,37342,37346,37359,37361,37366,37366,37371,37371,37376,37376,37382,37387,37390,37392,37395,37397,37408,37409,37412,37412,37610,37610,37622,37622,
        37628,37628,37637,37645,37659,37662,37672,37672,37675,37676,37683,37688,37692,37698,37706,37706,37709,37713,39353,39353,39356,39357,39361,39361,39364,39365,39368,39368,
        39378,39380,39393,39394,39397,39397,100152,100169,100176,100177,100332,100349,100356,100357,100360,100362,105001,105026,110102,110115,110144,110146,110249,110262,110291,110296,115001,115023,
        120086,120096,120127,120129,120138,120140,120229,120239,120270,120272,120281,120283,125001,125019,125025,125025,130092,130101,130195,130208,130224,130226,135001,135015,140046,140048,140063,140067,
        140122,140124,140139,140143,145001,145010,160152,160169,160176,160177,160332,160349,160356,160357,160360,160362,165001,165026,170102,170115,170144,170146,170249,170262,170291,170296,175001,175023,
        180086,180096,180127,180129,180138,180140,180229,180239,180270,180272,180281,180283,185001,185019,185025,185025,190092,190101,190195,190208,190224,190226,195001,195015,200046,200048,200063,200067,
        200122,200124,200139,200143,205001,205010,220152,220169,220176,220177,220332,220349,220356,220357,220360,220362,225001,225026,230102,230115,230144,230146,230249,230262,230291,230296,235001,235023,
        240086,240096,240127,240129,240138,240140,240229,240239,240270,240272,240281,240283,245001,245019,245025,245025,250092,250101,250195,250208,250224,250226,255001,255015,260046,260048,260063,260067,
        260122,260124,260139,260143,265001,265010,280152,280169,280176,280177,280332,280349,280356,280357,280360,280362,285001,285026,290102,290115,290144,290146,290249,290262,290291,290296,295001,295023,
        300086,300096,300127,300129,300138,300140,300229,300239,300270,300272,300281,300283,305001,305019,305025,305025,310092,310101,310195,310208,310224,310226,315001,315015,320046,320048,320063,320067,
        320122,320124,320139,320143,325001,325010,340152,340169,340176,340177,340332,340349,340356,340357,340360,340362,345001,345026,350102,350115,350144,350146,350249,350262,350291,350296,355001,355023,
        360086,360096,360127,360129,360138,360140,360229,360239,360270,360272,360281,360283,365001,365019,365025,365025,370092,370101,370195,370208,370224,370226,375001,375015,380046,380048,380063,380067,
        380122,380124,380139,380143,385001,385010,400478,400533,400567,400569,400598,400600,400627,400636,401127,401182,401216,401218,401247,401249,401276,401285,401298,401300,401316,401318,401335,401340,
        405000,405063,405087,405089,405092,405098,410478,410533,410567,410569,410598,410600,410627,410636,411127,411182,411216,411218,411247,411249,411276,411285,411298,411300,411316,411318,411335,411340,
        415000,415063,415087,415089,415092,415098,420478,420533,420567,420569,420598,420600,420627,420636,421127,421182,421216,421218,421247,421249,421276,421285,421298,421300,421316,421318,421335,421340,
        425000,425063,425087,425089,425092,425098,440041,440041,440167,440167,440300,440300,440304,440305,440365,440366,440415,440415,445000,445063,445087,445089,445092,445098,450009,450010,450100,450104,
        450135,450135,455000,455063,455087,455089,455092,455098,500060,500067,500134,500141,505001,505012,510048,510054,510104,510110,515001,515008,520074,520085,520160,520171,525001,525016,530000,530075,
        535000,535008,540022,540024,540047,540049,545001,545004,560026,560029,560056,560059,565001,565003,570025,570031,570057,570063,575001,575003,580022,580024,580047,580049,585001,585003,590032,590045,
        590078,590091,595001,595011,600000,600055,605000,605003,620028,620030,620059,620061,625001,625003,630026,630028,630055,630057,635001,635003,640016,640018,640035,640037,645001,645003,650024,650026,
        650051,650053,655001,655003,660026,660028,660055,660057,665001,665003,680026,680029,680056,680059,685001,685003,690054,690060,690115,690127,695001,695007,695010,695015,700026,700029,700056,700059,
        705001,705003,710046,710052,710099,710111,715001,715007,715010,715015,720024,720027,720052,720055,725001,725003,740024,740026,740053,740055,740058,740060,740076,740078,745001,745007,750022,750024,
        750061,750063,755001,755006,760024,760026,760053,760055,765001,765003,770018,770019,770042,770043,775001,775002,780042,780046,780095,780099,780106,780108,780124,780126,785001,785010,800029,800031,
        800060,800062,805001,805003,810029,810031,810060,810062,815001,815003,830029,830031,830060,830062,835001,835003,2014385,2014385,2214100,2214110,2222102,2222114,2241111,2241111,2312900,2312900,2680037,2680037,
        2680079,2680079,2681001,2681002,2681005,2681007,2681010,2681010,2681016,2681016,2681021,2681021,2681026,2681026,2681037,2681049,2681061,2681062,2681066,2681073,2681082,2681088,2681097,2681100,2681104,2681104,2681120,2681127,
        2681130,2681131,2681136,2681139,2681158,2681171,2681176,2681187,2681205,2681205,2681228,2681230,2681243,2681248,2681263,2681271,2681298,2681312,2681323,2681323,2681332,2681335,2681340,2681347,2681350,2681353,2681360,2681360,
        2681482,2681492,2681495,2681499,2681502,2681507,2747003,2747004,2747042,2747042,2747049,2747049,2747080,2747084,2747101,2747108,2747114,2747116,2747119,2747128,2747133,2747134,2747145,2747154,2747205,2747212,2747341,2747341,
        2747458,2747468,2747472,2747473,2747476,2747476,2747483,2747485,2747488,2747494,2747497,2747500,2747526,2747531,2747697,2747699,27564001,27564001,100050020,100050023,100050050,100050052,100050070,100050074,100050077,100050077,100050190,100050190,
        100050202,100050204,100050210,100050211,100050283,100050285,100050614,100050615,100050622,100050622,100050637,100050637,100050662,100050666,100060007,100060010,100060016,100060021,100060026,100060029,100060120,100060120,100060130,100060132,100060137,100060138,100060223,100060225,
        100060476,100060478,100060502,100060502,100060516,100060516,100060542,100060546,100070005,100070009,100070013,100070013,100070020,100070023,100070137,100070137,100070157,100070159,100070163,100070164,100070234,100070236,100070466,100070469,100070483,100070483,100070504,100070508,
        100080005,100080011,100080016,100080019,100080121,100080121,100080137,100080139,100080145,100080146,100080211,100080213,100080434,100080439,100080453,100080453,100080480,100080484,100090005,100090013,100090017,100090020,100090063,100090063,100090073,100090075,100090079,100090080,
        100090158,100090160,100090289,100090289,100090312,100090315,100090319,100090319,100090350,100090354,100100006,100100009,100100012,100100014,100100022,100100023,100100123,100100123,100100132,100100134,100100138,100100138,100100142,100100143,100100204,100100206,100100531,100100532,
        100100535,100100535,100100550,100100550,100100574,100100578,100110005,100110008,100110011,100110013,100110016,100110017,100110108,100110108,100110118,100110122,100110126,100110127,100110211,100110213,100110433,100110433,100110463,100110464,100110489,100110489,100110503,100110503,
        100110528,100110532,100120005,100120009,100120012,100120012,100120016,100120017,100120131,100120131,100120150,100120153,100120157,100120158,100120227,100120229,100120436,100120436,100120459,100120462,100120476,100120476,100120497,100120501,100130005,100130011,100130014,100130015,
        100130117,100130117,100130131,100130135,100130139,100130140,100130204,100130206,100130428,100130431,100130445,100130445,100130472,100130476,100140005,100140015,100140058,100140058,100140068,100140071,100140075,100140076,100140153,100140155,100140284,100140284,100140307,100140310,
        100140322,100140322,100140345,100140349,100150006,100150009,100150012,100150013,100150113,100150113,100150123,100150125,100150131,100150132,100150191,100150193,100150425,100150425,100150514,100150514,100150517,100150517,100150525,100150525,100150542,100150547,100160005,100160008,
        100160011,100160013,100160078,100160078,100160085,100160087,100160090,100160091,100160171,100160173,100160419,100160419,100160443,100160443,100160450,100160450,100160468,100160473,100170005,100170009,100170012,100170012,100170123,100170123,100170141,100170143,100170147,100170148,
        100170218,100170220,100170448,100170451,100170458,100170458,100170471,100170476,100180005,100180009,100180012,100180012,100180108,100180108,100180123,100180125,100180129,100180130,100180189,100180191,100180410,100180413,100180439,100180444,100190005,100190011,100190050,100190050,
        100190057,100190059,100190063,100190064,100190135,100190137,100190265,100190265,100190287,100190290,100190297,100190298,100190315,100190320,100200006,100200009,100200013,100200013,100200095,100200095,100200103,100200105,100200111,100200112,100200169,100200171,100200489,100200492,
        100200499,100200500,100200517,100200522,100210005,100210008,100210012,100210014,100210098,100210098,100210107,100210109,100210113,100210114,100210193,100210195,100210414,100210414,100210443,100210443,100210467,100210467,100210474,100210475,100210492,100210497,100220005,100220009,
        100220120,100220120,100220136,100220138,100220142,100220143,100220208,100220210,100220442,100220443,100220450,100220450,100220457,100220457,100220470,100220475,100230005,100230009,100230108,100230108,100230123,100230125,100230129,100230130,100230189,100230191,100230410,100230413,
        100230420,100230420,100230439,100230444,100240005,100240009,100240053,100240053,100240060,100240062,100240065,100240066,100240143,100240145,100240274,100240274,100240295,100240297,100240304,100240304,100240322,100240327,100250006,100250009,100250013,100250013,100250021,100250022,
        100250099,100250099,100250108,100250110,100250113,100250113,100250117,100250118,100250175,100250177,100250498,100250502,100250513,100250513,100250536,100250540,100260005,100260008,100260012,100260013,100260017,100260018,100260101,100260101,100260109,100260113,100260117,100260118,
        100260197,100260199,100260449,100260451,100260475,100260475,100260486,100260486,100260509,100260513,100270005,100270009,100270015,100270016,100270116,100270116,100270133,100270136,100270140,100270141,100270207,100270209,100270436,100270439,100270450,100270450,100270468,100270472,
        100280005,100280009,100280014,100280015,100280095,100280095,100280109,100280112,100280116,100280117,100280174,100280176,100280397,100280400,100280411,100280411,100280435,100280439,100290005,100290009,100290014,100290015,100290053,100290053,100290063,100290067,100290073,100290074,
        100290144,100290146,100290275,100290275,100290298,100290302,100290313,100290313,100290336,100290340,100300003,100300010,100300059,100300060,100300063,100300067,100300076,100300091,100300209,100300209,100300212,100300213,100300216,100300216,100300221,100300221,100300327,100300327,
        100300330,100300333,100300497,100300497,100300506,100300508,100300541,100300541,100300555,100300555,100300605,100300609,100310003,100310009,100310061,100310061,100310070,100310076,100310527,100310528,100310532,100310532,100310547,100310547,100310553,100310554,100310605,100310606,
        100310656,100310656,100310785,100310786,100310790,100310790,100310805,100310805,100310813,100310813,100310869,100310870,100310916,100310916,100312092,100312092,100312095,100312096,100312099,100312099,100312103,100312103,100312192,100312192,100312197,100312197,100312200,100312204,
        100312235,100312235,100312249,100312250,100312299,100312303,100320005,100320012,100320064,100320068,100320077,100320093,100320585,100320588,100320591,100320591,100320595,100320595,100320619,100320619,100320625,100320626,100320696,100320697,100320756,100320756,100321954,100321955,
        100321958,100321958,100321962,100321962,100322049,100322065,100322071,100322071,100322104,100322104,100322118,100322119,100322168,100322172,100330003,100330071,100330074,100330075,100330088,100330104,100330574,100330601,100340137,100340309,100340325,100340325,100340334,100340334,
        100340345,100340345,100340350,100340350,100340354,100340356,100341669,100341669,100341775,100341775,100341800,100341800,100341825,100341825,100341850,100341850,100343175,100343176,100344040,100344040,100344050,100344050,100344065,100344065,100344071,100344072,100344075,100344075,
        100344087,100344087,100344097,100344100,100344125,100344125,100344150,100344150,100344168,100344168,100344174,100344176,100344184,100344186,100344191,100344191,100344225,100344225,100344255,100344257,100344261,100344263,100344300,100344300,100344402,100344406,100350006,100350093,
        100350096,100350097,100350104,100350112,100350125,100350125,100350130,100350134,100350577,100350577,100350657,100350657,100350696,100350698,100350716,100350718,100350825,100350825,100350850,100350850,100350875,100350875,100350897,100350897,100352097,100352097,100352104,100352107,
        100352113,100352115,100352134,100352134,100352575,100352575,100352599,100352602,100352608,100352611,100352614,100352614,100352618,100352619,100352659,100352659,100352670,100352672,100352732,100352736,100352814,100352815,100352818,100352820,101000001,101000002,101000006,101000010,
        101000013,101000023,101000027,101000030,101000162,101000162,101000196,101000196,101000199,101000200,101000225,101000226,101000320,101000320,101000497,101000497,101000539,101000539,101000543,101000543,101000574,101000575,101010001,101010002,101010023,101010027,101010031,101010041,
        101010044,101010047,101010299,101010299,101010325,101010328,101010652,101010653,101010699,101010699,101010731,101010732,101013025,101013025,101013050,101013050,101013075,101013075,101013100,101013100,101013125,101013125,101013150,101013150,101013175,101013175,101013200,101013200,
        101013225,101013225,101013250,101013250,101013275,101013275,101013300,101013300,101013325,101013325,101013350,101013350,101013375,101013375,101013400,101013400,101013425,101013425,101013450,101013450,101013475,101013475,101013500,101013500,101013525,101013525,101013550,101013550,
        101013575,101013575,101013600,101013600,101013625,101013625,101013650,101013650,101013675,101013675,101013700,101013700,101013725,101013725,101013750,101013750,101013775,101013775,101013800,101013800,101013825,101013825,101013875,101013875,101013900,101013900,101013925,101013925,
        101013950,101013950,101013975,101013975,101014000,101014000,101014025,101014025,101014050,101014050,101014100,101014100,101014125,101014125,101014150,101014150,101014175,101014175,101014200,101014200,101014225,101014225,101014250,101014250,101014275,101014275,101014300,101014300,
        101014325,101014325,101014350,101014350,101014375,101014375,101014400,101014400,101014450,101014450,101014475,101014475,101014500,101014500,101014525,101014525,101014550,101014550,101014575,101014575,101014600,101014600,101020001,101020002,101020025,101020029,101020033,101020042,
        101020046,101020049,101020229,101020229,101020254,101020259,101020283,101020284,101020353,101020355,101020458,101020459,101020506,101020507,101020542,101020545,101020564,101020564,101020579,101020580,101030001,101030002,101030020,101030024,101030027,101030032,101030035,101030037,
        101030041,101030044,101030172,101030172,101030211,101030212,101030215,101030215,101030239,101030240,101030330,101030330,101030517,101030517,101030561,101030561,101030565,101030565,101030598,101030599,101030638,101030638,101040001,101040002,101040021,101040025,101040029,101040038,
        101040041,101040041,101040045,101040047,101040127,101040127,101040144,101040148,101040156,101040156,101040172,101040173,101040259,101040261,101040332,101040332,101040373,101040375,101040405,101040406,101040436,101040436,102000001,102000002,102000029,102000033,102000039,102000046,
        102000051,102000053,102000056,102000058,102000121,102000121,102000132,102000132,102000135,102000136,102000193,102000194,102000266,102000268,102000327,102000327,102000374,102000374,102000399,102000400,102010001,102010002,102010091,102010095,102010098,102010104,102010108,102010110,
        102010113,102010115,102010179,102010179,102010188,102010193,102010229,102010229,102010246,102010247,102010391,102010392,102010433,102010433,102010463,102010464,102010566,102010566,102020001,102020002,102020025,102020029,102020032,102020039,102020042,102020044,102020049,102020052,
        102020110,102020110,102020123,102020123,102020126,102020127,102020180,102020181,102020244,102020246,102020299,102020300,102020345,102020345,102020368,102020368,102020371,102020371,102030001,102030002,102030024,102030035,102030038,102030040,102030045,102030048,102030138,102030138,
        102030149,102030149,102030152,102030153,102030205,102030206,102030270,102030272,102030330,102030331,102030372,102030372,102030375,102030375,102030397,102030401,102030417,102030417,102030432,102030432,102030440,102030440,102040001,102040002,102040025,102040029,102040032,102040042,
        102040045,102040048,102040086,102040086,102040096,102040100,102040152,102040153,102040223,102040225,102040364,102040364,102040408,102040408,104000001,104000002,104000024,104000028,104000032,104000042,104000046,104000049,104000134,104000134,104000150,104000150,104000153,104000154,
        104000178,104000179,104000252,104000254,104000341,104000341,104000392,104000392,104000468,104000469,104010001,104010002,104010020,104010024,104010027,104010037,104010040,104010043,104010126,104010126,104010134,104010135,104010138,104010138,104010163,104010164,104010233,104010235,
        104010322,104010322,104010370,104010370,104010375,104010375,104010450,104010452,104020001,104020002,104020021,104020025,104020028,104020039,104020042,104020044,104020129,104020129,104020141,104020141,104020145,104020146,104020169,104020170,104020232,104020235,104020322,104020323,
        104020450,104020450,104020453,104020453,104030001,104030002,104030023,104030027,104030033,104030039,104030042,104030046,104030049,104030051,104030134,104030134,104030143,104030147,104030155,104030155,104030171,104030172,104030238,104030240,104030326,104030327,104030489,104030489,
        104040001,104040002,104040023,104040027,104040031,104040041,104040044,104040047,104040132,104040132,104040153,104040156,104040181,104040182,104040249,104040251,104040343,104040343,104040394,104040394,104040468,104040469,104040542,104040542,106000001,106000002,106000022,106000026,
        106000029,106000040,106000044,106000047,106000078,106000078,106000088,106000090,106000093,106000093,106000117,106000118,106000190,106000192,106000278,106000279,106000357,106000357,106010001,106010002,106010022,106010026,106010030,106010040,106010043,106010046,106010115,106010115,
        106010123,106010125,106010128,106010128,106010136,106010136,106010153,106010154,106010218,106010220,106010306,106010307,106010387,106010387,106010421,106010421,106020001,106020002,106020020,106020024,106020027,106020031,106020034,106020038,106020041,106020043,106020075,106020075,
        106020089,106020091,106020115,106020116,106020189,106020191,106020367,106020368,106020420,106020420,106020449,106020450,106020483,106020483,106030001,106030002,106030023,106030027,106030032,106030040,106030043,106030045,106030114,106030114,106030124,106030128,106030137,106030137,
        106030154,106030155,106030224,106030226,106030403,106030403,106030482,106030482,106040001,106040002,106040021,106040025,106040028,106040044,106040047,106040050,106040081,106040081,106040093,106040097,106040126,106040127,106040195,106040197,106040283,106040284,106040363,106040363,
        106040366,106040366,106040396,106040396,108000001,108000002,108000022,108000026,108000029,108000040,108000044,108000046,108000087,108000087,108000101,108000104,108000112,108000112,108000128,108000129,108000201,108000203,108000315,108000315,108000360,108000360,108000382,108000383,
        108000418,108000418,108010001,108010002,108010020,108010024,108010028,108010039,108010042,108010044,108010078,108010078,108010087,108010091,108010100,108010100,108010117,108010118,108010191,108010193,108010284,108010285,108010325,108010325,108010328,108010328,108010350,108010352,
        108020001,108020002,108020020,108020024,108020027,108020037,108020041,108020044,108020073,108020073,108020083,108020086,108020112,108020113,108020177,108020179,108020260,108020261,108020307,108020307,108020333,108020333,108020370,108020370,108030001,108030002,108030021,108030025,
        108030028,108030037,108030040,108030043,108030069,108030069,108030081,108030084,108030109,108030110,108030186,108030188,108030320,108030320,108030363,108030363,108030386,108030386,108030422,108030422,108040001,108040002,108040020,108040024,108040028,108040038,108040041,108040044,
        108040093,108040093,108040103,108040103,108040107,108040108,108040130,108040131,108040201,108040203,108040274,108040275,108040317,108040317,108040376,108040376,109000001,109000002,109000021,109000025,109000029,109000039,109000042,109000045,109000087,109000087,109000102,109000106,
        109000131,109000132,109000206,109000208,109000261,109000262,109000333,109000333,109000425,109000425,109010001,109010002,109010020,109010024,109010027,109010037,109010041,109010044,109010083,109010083,109010094,109010097,109010122,109010123,109010195,109010197,109010250,109010251,
        109010291,109010291,109010295,109010295,109010321,109010321,109010392,109010392,109020001,109020002,109020020,109020024,109020027,109020036,109020039,109020042,109020072,109020072,109020084,109020087,109030024,109030025,109030092,109030094,109030147,109030148,109030189,109030189,
        109030192,109030192,109030217,109030221,109030269,109030269,109030284,109030285,110300332,110300332,110300508,110300508,110300605,110300609,110312197,110312197,110312203,110312203,110312299,110312303,110322052,110322053,110322168,110322172,110344261,110344263,110344402,110344406,
        110352609,110352610,110352732,110352736,120300332,120300332,120300508,120300508,120300605,120300609,120312197,120312197,120312203,120312203,120312299,120312303,120322052,120322053,120322168,120322172,120344261,120344263,120344402,120344406,120352609,120352610,120352732,120352736,
        130300332,130300332,130300508,130300508,130300605,130300609,130312197,130312197,130312203,130312203,130312299,130312303,130322052,130322053,130322168,130322172,130344261,130344263,130344402,130344406,130352609,130352610,130352732,130352736,140300332,140300332,140300508,140300508,
        140300605,140300609,140312197,140312197,140312203,140312203,140312299,140312303,140322052,140322053,140322168,140322172,140344261,140344263,140344402,140344406,140352609,140352610,140352732,140352736,600330000,600330012,601030000,601030001,602040000,602040001,2024100201,2024100229
    ];

    /* ---------- 图鉴数据加载器（v5.100） ---------- */
    const ATLAS_RARITY_LABEL = { 3: '神器', 4: '史诗', 6: '传说' };
    // v5.101：收纳范围变为「史诗 + 传说 + Lv85 神器散件」，缓存版本必须升，旧缓存自然失效
    const ATLAS_CACHE_KEY = 'dnf_atlas_equip_v5101';
    const ATLAS_CACHE_VER = 5101;
    const ATLAS_TTL_FULL = 7 * 24 * 60 * 60 * 1000;   // 完整数据：7 天
    const ATLAS_TTL_PART = 12 * 60 * 60 * 1000;        // 未跑完的数据：12 小时
    const ATLAS_CONCURRENCY = 6;                        // 与上一轮 ID 段扫描一致，实测 0 次 429
    const ATLAS_REQ_TIMEOUT = 8000;

    const ATLAS_AFFIX_LABEL = {
        'attack speed': '攻击速度', 'cast speed': '施放速度', 'move speed': '移动速度',
        'stuck': '硬直', 'stuck resistance': '硬直抗性', 'hit recovery': '硬直恢复',
        'physical critical hit': '物理暴击', 'magical critical hit': '魔法暴击',
        'HP MAX': 'HP 上限', 'MP MAX': 'MP 上限',
        'HP regen speed': 'HP 恢复速度', 'MP regen speed': 'MP 恢复速度',
        'anti evil': '抗魔值', 'inventory limit': '背包上限', 'jump power': '跳跃力',
        'all elemental attack': '全属性强化', 'all elemental resistance': '全属性抗性',
        'all activestatus resistance': '全异常状态抗性',
        'fire attack': '火属性强化', 'water attack': '冰属性强化', 'light attack': '光属性强化', 'dark attack': '暗属性强化',
        'fire resistance': '火属性抗性', 'water resistance': '冰属性抗性', 'dark resistance': '暗属性抗性',
        'freeze resistance': '冰冻抗性', 'bleeding resistance': '出血抗性',
        'curse resistance': '诅咒抗性', 'burn resistance': '灼伤抗性',
    };
    const ATLAS_ELEM_LABEL = { fire: '火', water: '冰', light: '光', dark: '暗' };
    const ATLAS_ARMOR_LABEL = { cloth: '布甲', leather: '皮甲', light: '轻甲', heavy: '重甲', plate: '板甲' };
    const ATLAS_SLOT_TYPE = {
        coat: '上衣', pants: '下装', shoulder: '头肩', belt: '腰带', shoes: '鞋',
        amulet: '项链', wrist: '手镯', ring: '戒指', magicstone: '魔法石', support: '辅助装备',
    };

    let equipData = ATLAS_SEED.slice();
    let equipLoad = { status: 'idle', done: 0, total: 0, hit: 0, next: 0, source: '', err: '' };
    let equipAbort = false;
    let equipRun = 0;
    let atlasFound = null;
    let atlasSkillNames = null;
    let _atlasIds = null;
    let _atlasRenderAt = 0;

    /** ID 段展开成候选 id（只算一次，7745 个） */
    function atlasCandidateIds() {
        if (_atlasIds) return _atlasIds;
        const out = [];
        for (let i = 0; i < ATLAS_ID_RANGES.length; i += 2) {
            const s = ATLAS_ID_RANGES[i], e = ATLAS_ID_RANGES[i + 1];
            for (let id = s; id <= e; id++) out.push(id);
        }
        _atlasIds = out;
        return out;
    }

    function atlasCacheRead() {
        try {
            const raw = localStorage.getItem(ATLAS_CACHE_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || obj.v !== ATLAS_CACHE_VER || !Array.isArray(obj.items) || !obj.items.length) return null;
            const ttl = obj.complete ? ATLAS_TTL_FULL : ATLAS_TTL_PART;
            if (!Number.isFinite(obj.ts) || Date.now() - obj.ts > ttl) return null;
            return obj;
        } catch (_) { return null; }
    }
    function atlasCacheWrite(items, complete, next) {
        try {
            localStorage.setItem(ATLAS_CACHE_KEY, JSON.stringify({
                v: ATLAS_CACHE_VER, ts: Date.now(), complete: !!complete, next: Number(next) || 0, items: items,
            }));
        } catch (err) {
            // 配额不足只影响下次冷启动速度，不影响本次已展示的数据
            log('[图鉴] 缓存写入失败:', err && err.name);
        }
    }

    function atlasTypeText(raw) {
        if (!raw) return '';
        if (raw.slot === 'weapon') return WG_LABEL[raw.weapon_group] || '';
        if (Object.prototype.hasOwnProperty.call(ATLAS_SLOT_TYPE, raw.slot)
            && ['coat', 'pants', 'shoulder', 'belt', 'shoes'].indexOf(raw.slot) >= 0) {
            return (ATLAS_ARMOR_LABEL[raw.armor_type] || '') + ATLAS_SLOT_TYPE[raw.slot];
        }
        return ATLAS_SLOT_TYPE[raw.slot] || '';
    }
    /** 与旧图鉴一致：大~小（接口给的是 [小,大]） */
    function atlasRangeText(r) {
        if (!Array.isArray(r) || r.length < 2) return '';
        const a = Number(r[0]), b = Number(r[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || (!a && !b)) return '';
        return Math.max(a, b) + '~' + Math.min(a, b);
    }
    // 只有这些词条按百分比展示，其余（HP/MP 上限、抗魔值等）是固定值
    const ATLAS_PCT_KEYS = new Set([
        'attack speed', 'cast speed', 'move speed', 'stuck resistance', 'hit recovery',
        'physical critical hit', 'magical critical hit',
        'all elemental attack', 'all elemental resistance', 'all activestatus resistance',
        'fire attack', 'water attack', 'light attack', 'dark attack',
        'fire resistance', 'water resistance', 'dark resistance',
        'freeze resistance', 'bleeding resistance', 'curse resistance', 'burn resistance',
    ]);
    function atlasAffixText(list) {
        if (!Array.isArray(list) || !list.length) return '';
        const out = [];
        for (const x of list) {
            if (!x || !x.key) continue;
            const v = Number(x.value) || 0;
            out.push((ATLAS_AFFIX_LABEL[x.key] || x.key) + ' ' + (v >= 0 ? '+' : '-') + Math.abs(v)
                + (ATLAS_PCT_KEYS.has(x.key) ? '%' : ''));
        }
        return out.join('　');
    }
    /** 技能加成按「名字+等级」去重（同一技能在多个职业分支重复出现时只留一条） */
    function atlasSkillText(list) {
        if (!Array.isArray(list) || !list.length) return [];
        const names = atlasSkillNames || {};
        const seen = new Set(), out = [];
        for (const s of list) {
            if (!s) continue;
            const nm = names[s.job + ':' + s.skill_id] || ('技能 ' + s.skill_id);
            const text = '[' + nm + '] +' + (Number(s.level_bonus) || 0) + '级';
            if (seen.has(text)) continue;
            seen.add(text);
            out.push(text);
            if (out.length >= 12) break;
        }
        return out;
    }
    function atlasIconPath(path, index) {
        if (!path) return '';
        const key = String(path).toLowerCase().replace(/\.img$/, '').replace(/\//g, '_');
        return '/assets/icons/sprite_' + key + '_' + (Number(index) || 0) + '.png';
    }
    /** 接口记录 → 图鉴记录；只收史诗(4)、传说(6)、以及 Lv85 神器散件(3 且无套装) */
    function atlasFromApi(raw) {
        if (!raw) return null;
        const rarity = Number(raw.rarity);
        const keep = rarity === 4 || rarity === 6
            || (rarity === 3 && Number(raw.level) === 85 && !raw.set_name);
        if (!keep) return null;
        const explain = String(raw.basic_explain || '').split(/\r?\n/)
            .map(s => s.trim()).filter(Boolean);
        return {
            id: Number(raw.item_id),
            rarity: Number(raw.rarity),
            name: raw.name || ('物品 ' + raw.item_id),
            level: Number(raw.level) || 0,
            slot: raw.slot || '',
            armor: raw.armor_type || '',
            wg: raw.weapon_group || '',
            type: atlasTypeText(raw),
            icon: atlasIconPath(raw.icon_path, raw.icon_index),
            atk: atlasRangeText(raw.patk_range),
            matk: atlasRangeText(raw.matk_range),
            ind: 0,
            pdef: atlasRangeText(raw.pdef_range),
            mdef: atlasRangeText(raw.mdef_range),
            str: Number(raw.str) || 0,
            intel: Number(raw.intel) || 0,
            vit: Number(raw.vit) || 0,
            spr: Number(raw.spr) || 0,
            elem: ATLAS_ELEM_LABEL[raw.elemental_property] || '',
            addDmg: Number(raw.add_damage) || 0,
            incDmg: Number(raw.increase_damage) || 0,
            affix: atlasAffixText(raw.affixes),
            skills: atlasSkillText(raw.skill_bonuses),
            explain: explain,
            set: raw.set_name || '',
        };
    }

    function atlasMerge(base, add) {
        const map = new Map();
        base.forEach(x => map.set(Number(x.id), x));
        add.forEach(x => map.set(Number(x.id), x));
        return [...map.values()].sort((a, b) =>
            (Number(b.rarity) - Number(a.rarity)) || (Number(b.level) - Number(a.level))
            || String(a.name).localeCompare(String(b.name), 'zh'));
    }

    /** 单个接口 GET：统一超时与 429/404 区分 */
    async function atlasFetch(url) {
        const token = localStorage.getItem('dnf_idle_token') || '';
        const headers = token ? { Accept: 'application/json', Authorization: 'Bearer ' + token } : { Accept: 'application/json' };
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ATLAS_REQ_TIMEOUT);
        try {
            const res = await fetch(url, { headers: headers, signal: ac.signal });
            if (res.status === 404) return { notFound: true };
            if (res.status === 429) return { rateLimited: true };
            if (!res.ok) return { bad: res.status };
            return { data: await res.json() };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 首次打开装备页时调用：
     *   ① 命中未过期缓存 → 直接用（未跑完的继续在后台补）；
     *   ② 否则先用最小基线渲染，再后台逐件拉取，边拉边刷新列表。
     */
    function ensureEquipData(force) {
        if (!force) {
            if (equipLoad.status === 'loading') return;
            if (equipLoad.status === 'ready') return;
        }
        const cached = force ? null : atlasCacheRead();
        if (cached) {
            equipData = atlasMerge(ATLAS_SEED, cached.items);
            equipLoad = { status: 'ready', done: 0, total: 0, hit: cached.items.length, next: 0, source: 'cache', err: '' };
            renderAtlasProgress();
            if (state && state.detail === null) renderList();
            if (!cached.complete) atlasScan(Number(cached.next) || 0, cached.items);
            return;
        }
        atlasScan(0, []);
    }

    function atlasStopScan() {
        if (equipLoad.status !== 'loading') return;
        equipAbort = true;
        equipRun++;
        const items = atlasFound ? [...atlasFound.values()] : [];
        atlasCacheWrite(items, false, equipLoad.next);
        equipLoad.status = 'aborted';
        equipLoad.err = '已停止：已加载 ' + items.length + ' 件，可继续';
        renderAtlasProgress();
    }

    async function atlasScan(start, seedItems) {
        const run = ++equipRun;
        equipAbort = false;
        const ids = atlasCandidateIds();
        const found = new Map();
        (seedItems || []).forEach(x => found.set(Number(x.id), x));
        atlasFound = found;
        equipData = atlasMerge(ATLAS_SEED, [...found.values()]);
        equipLoad = { status: 'loading', done: start, total: ids.length, hit: found.size, next: start, source: 'network', err: '' };
        renderAtlasProgress();
        if (state && state.detail === null) renderList();

        if (!atlasSkillNames) {
            try {
                const r = await atlasFetch('/api/meta/skill-names');
                if (r && r.data && r.data.skill_names) atlasSkillNames = r.data.skill_names;
            } catch (_) { /* 拿不到就退回「技能 <id>」显示 */ }
        }

        let idx = start, done = start, rateLimited = 0, netFail = 0, halt = false;
        const failed = [];
        const flush = (force) => {
            const now = Date.now();
            if (!force && now - _atlasRenderAt < 800) return;
            _atlasRenderAt = now;
            equipData = atlasMerge(ATLAS_SEED, [...found.values()]);
            renderAtlasProgress();
            if (panel && panel.style.display !== 'none' && state.detail === null) renderList();
        };

        const worker = async () => {
            while (true) {
                if (run !== equipRun || equipAbort || halt) return;
                const i = idx++;
                if (i >= ids.length) return;
                let r;
                try { r = await atlasFetch('/api/items/' + ids[i]); }
                catch (_) { r = { failed: true }; }
                if (r && r.rateLimited) {
                    rateLimited++;
                    await new Promise(res => setTimeout(res, 1500));
                    if (rateLimited <= 20) failed.push(ids[i]);
                } else if (r && r.failed) {
                    netFail++;
                    failed.push(ids[i]);
                } else if (r && r.bad) {
                    netFail++;
                    failed.push(ids[i]);
                } else if (r && r.data) {
                    const rec = atlasFromApi(r.data);
                    if (rec) found.set(rec.id, rec);
                }
                // 连续 30 个请求全挂且一条都没命中 → 判定网络/接口不可用，立刻停下回到基线
                if (netFail >= 30 && found.size <= ATLAS_SEED.length) halt = true;
                done++;
                equipLoad.done = done;
                equipLoad.hit = found.size;
                equipLoad.next = Math.min(idx, ids.length);
                flush(false);
            }
        };
        await Promise.all(Array.from({ length: ATLAS_CONCURRENCY }, worker));
        if (run !== equipRun) return;

        // 失败（超时/网络）重试一轮
        for (const id of failed) {
            if (run !== equipRun || equipAbort) break;
            try {
                const r = await atlasFetch('/api/items/' + id);
                if (r && r.data) {
                    const rec = atlasFromApi(r.data);
                    if (rec) found.set(rec.id, rec);
                }
            } catch (_) { }
        }
        if (run !== equipRun) return;

        const items = [...found.values()];
        // 整段网络失败（一条都没拉到）时不当成正常加载完成，也不写「完整」缓存
        if (netFail > 0 && items.length <= ATLAS_SEED.length && !equipAbort) {
            equipData = atlasMerge(ATLAS_SEED, items);
            equipLoad.status = 'error';
            equipLoad.hit = items.length;
            equipLoad.err = '拉取失败（' + netFail + ' 个请求异常），当前显示内置基线 ' + ATLAS_SEED.length + ' 件';
            renderAtlasProgress();
            if (!state.detail) renderList();
            return;
        }
        const complete = !equipAbort && equipLoad.next >= ids.length && netFail === 0;
        equipData = atlasMerge(ATLAS_SEED, items);
        equipLoad.status = 'ready';
        equipLoad.hit = items.length;
        equipLoad.source = 'network';
        equipLoad.err = '';
        if (equipAbort) {
            equipLoad.status = 'aborted';
            equipLoad.err = '已停止：已加载 ' + items.length + ' 件，可继续';
        }
        atlasCacheWrite(items, complete, complete ? 0 : equipLoad.next);
        renderAtlasProgress();
        if (!state.detail) renderList();
    }

    function renderAtlasProgress() {
        if (!loadEl) return;
        const L = equipLoad;
        if (L.status === 'loading') {
            const pct = L.total ? Math.round(L.done / L.total * 100) : 0;
            loadEl.style.display = 'flex';
            loadEl.innerHTML = '<div class="g85-lbar"><i style="width:' + pct + '%"></i></div>' +
                '<span class="g85-ltxt">加载 ' + L.done + '/' + L.total + ' · 命中 ' + L.hit + '</span>' +
                '<button type="button" data-act="stop">停止</button>';
        } else if (L.status === 'aborted' || L.status === 'error') {
            loadEl.style.display = 'flex';
            loadEl.innerHTML = '<span class="g85-ltxt">' + esc(L.err || '加载中断') + '</span>' +
                '<button type="button" data-act="retry">' + (L.status === 'error' ? '重试' : '继续') + '</button>';
        } else {
            loadEl.style.display = 'none';
            loadEl.innerHTML = '';
        }
        const stop = loadEl.querySelector('[data-act="stop"]');
        if (stop) stop.onclick = atlasStopScan;
        const retry = loadEl.querySelector('[data-act="retry"]');
        if (retry) retry.onclick = () => ensureEquipData(false);
    }

    const SLOT_ORDER = ['weapon','coat','shoulder','belt','pants','shoes','amulet','wrist','ring','magicstone','support'];
    const SLOT_LABEL = { weapon:'武器', coat:'上衣', shoulder:'头肩', belt:'腰带', pants:'下装', shoes:'鞋', amulet:'项链', wrist:'手镯', ring:'戒指', magicstone:'魔法石', support:'辅助装备' };

    // 武器类型 → 职业归属（按 DNF 职业可用武器）
    const WG_LABEL = {
        // v6.02：lswd / beamswd 中文名对调修正（游戏资源 Item/weapon/swordman/{lswd,beamswd}.img；
        // lswd 攻速 -9、无 required_skill_id 实为巨剑，beamswd 攻速 +10、required_skill_id=33 实为光剑）
        ssword:'短剑', katana:'太刀', lswd:'巨剑', beamswd:'光剑', club:'钝器',
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
    // v5.101：武器类型按职业顺序排列；全部职业时展开即 28 个类型
    const WG_ORDER = JOB_ORDER.reduce((acc, job) => acc.concat(Object.keys(WG_LABEL).filter(wg => WG_JOB[wg] === job)), []);
    const WG_JOB_DEFS = [['all', '全部职业']].concat(JOB_ORDER.map(job => [job, job]));
    const PART_DEFS = [['all', '全部部位'], ['coat', '上衣'], ['pants', '下装'], ['shoulder', '头肩'], ['shoes', '鞋子'], ['belt', '腰带']];
    const ARMOR_DEFS = [['all', '全部甲种'], ['cloth', '布甲'], ['leather', '皮甲'], ['light', '轻甲'], ['heavy', '重甲'], ['plate', '板甲']];
    const JEWEL_DEFS = [['all', '全部'], ['wrist', '手镯'], ['amulet', '项链'], ['ring', '戒指']];
    const SPECIAL_DEFS = [['all', '全部'], ['magicstone', '魔法石'], ['support', '辅助装备']];
    let state = { q:'', cat:'all', job:'all', part:'all', armor:'all', jewel:'all', special:'all', wg:'all', rar:'all',
        open:false, detail:null, ostat:'all', oslot:'all', orar:'all' };
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
            .g85-more{padding:9px 0 12px;text-align:center;color:#c8a86a;font-size:12px;cursor:pointer;
                border-top:1px dashed #4a3c24;user-select:none}
            .g85-more:hover{color:#f5c542}

            /* v5.101：刷新按钮固定在标题栏关闭按钮正下方（标签行右端） */
            .g85-refresh{margin-left:auto;padding:3px 10px;border-radius:4px;cursor:pointer;
                border:1px solid #6b5633;background:#241d12;color:#d9c49a;
                font:12px/1.5 "Microsoft YaHei",sans-serif}
            .g85-refresh:hover{border-color:#f5c542;color:#f5c542;background:#3a2f18}
            .g85-confirm{position:fixed;inset:0;z-index:1000025;display:flex;align-items:center;justify-content:center;
                background:rgba(0,0,0,.55);animation:none}
            .g85-confirm-box{width:min(330px,calc(100vw - 32px));box-sizing:border-box;padding:16px 16px 14px;
                border-radius:10px;border:1px solid #9b7645;background:#2a2116;color:#edddc3;
                font:13px/1.7 "Microsoft YaHei",sans-serif;box-shadow:0 14px 40px #000a}
            .g85-confirm-title{color:#f5c542;font-weight:700;font-size:15px;margin-bottom:6px}
            .g85-confirm-text{color:#c9b696;white-space:pre-line}
            .g85-confirm-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
            .g85-cbtn{padding:6px 14px;border-radius:5px;cursor:pointer;border:1px solid #6b5633;
                background:#241d12;color:#d9c49a;font:13px/1 "Microsoft YaHei",sans-serif}
            .g85-cbtn:hover{border-color:#a4885a;color:#f0e7d2}
            .g85-cbtn.primary{border-color:#9b7645;background:#4a3517;color:#ffd794}
            .g85-cbtn.primary:hover{background:#5d4319;border-color:#f5c542}

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

            .g85-load{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px;
                background:#171109;border-bottom:1px solid #2e2516;font-size:11px;color:#b6a47e}
            .g85-load .g85-ltxt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .g85-load .g85-lbar{flex:1 1 auto;height:4px;border-radius:2px;background:#2e2516;overflow:hidden}
            .g85-load .g85-lbar i{display:block;height:100%;background:#f5c542;width:0;transition:width .2s ease}
            .g85-load button{flex:0 0 auto;padding:2px 8px;border-radius:3px;cursor:pointer;
                border:1px solid #6b5633;background:#241d12;color:#f5c542;font:11px/1.4 "Microsoft YaHei",sans-serif}
            .g85-load button:hover{border-color:#f5c542}
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
    let capsule = null, panel = null, listEl = null, detailEl = null, catWrap = null, subWrap = null, sub2Wrap = null, rarWrap = null,
        refreshEqBtn = null, refreshOrbBtn = null,
        countEl = null, searchEl = null, loadEl = null;

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function filtered() {
        const q = state.q.trim().toLowerCase();
        return equipData.filter(j => {
            if (state.rar !== 'all' && String(j.rarity) !== state.rar) return false;
            if (state.cat !== 'all') {
                if (CAT_SLOTS[state.cat].indexOf(j.slot) === -1) return false;
                if (state.cat === 'weapon' && state.job !== 'all' && (WG_JOB[j.wg] || '') !== state.job) return false;
                if (state.cat === 'weapon' && state.wg !== 'all' && j.wg !== state.wg) return false;
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

    // v5.101：列表分批渲染，首屏 120 条，滚动到底或点「加载更多」再追加
    const ATLAS_BATCH = 120;
    let renderArr = [];
    let renderShown = 0;
    let renderMoreEl = null;

    function renderList() {
        const arr = filtered();
        if (countEl) countEl.textContent = arr.length + ' / ' + equipData.length;
        const keepTop = listEl.scrollTop;
        listEl.innerHTML = '';
        renderArr = arr;
        renderShown = 0;
        renderMoreEl = null;
        if (!arr.length) {
            listEl.innerHTML = '<div class="g85-empty">没有匹配的装备</div>';
            return;
        }
        appendBatch();
        if (keepTop > 0) listEl.scrollTop = keepTop;
    }

    function appendBatch() {
        if (renderShown >= renderArr.length) return;
        const end = Math.min(renderArr.length, renderShown + ATLAS_BATCH);
        const frag = document.createDocumentFragment();
        for (let i = renderShown; i < end; i++) {
            const j = renderArr[i];
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
            frag.appendChild(div);
        }
        if (renderMoreEl && renderMoreEl.parentNode === listEl) listEl.insertBefore(frag, renderMoreEl);
        else listEl.appendChild(frag);
        renderShown = end;
        if (renderShown < renderArr.length) {
            if (!renderMoreEl) {
                renderMoreEl = document.createElement('div');
                renderMoreEl.className = 'g85-more';
                renderMoreEl.addEventListener('click', appendBatch);
                listEl.appendChild(renderMoreEl);
            }
            renderMoreEl.textContent = '加载更多（' + renderShown + ' / ' + renderArr.length + '）';
        } else if (renderMoreEl) {
            renderMoreEl.remove();
            renderMoreEl = null;
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
        detailEl.querySelector('.g85-dsub').textContent =
            (j.type || '') + ' · ' + (ATLAS_RARITY_LABEL[j.rarity] || '史诗') + ' · Lv.' + j.level;
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
            state.wg = 'all';
            buildSubChips();
            syncSubRows();
        });
    }

    // 第二行：随大类变化（武器=职业 / 防具=部位 / 首饰=类型 / 特殊装备=类型）
    function buildSubChips() {
        if (!subWrap) return;
        if (state.cat === 'all') { subWrap.innerHTML = ''; return; }
        if (state.cat === 'weapon') {
            fillChips(subWrap, WG_JOB_DEFS, state.job, key => { state.job = key; state.wg = 'all'; },
                () => { buildSub2Chips(); renderList(); });
        } else if (state.cat === 'armor') {
            fillChips(subWrap, PART_DEFS, state.part, key => { state.part = key; });
        } else if (state.cat === 'jewel') {
            fillChips(subWrap, JEWEL_DEFS, state.jewel, key => { state.jewel = key; });
        } else if (state.cat === 'special') {
            fillChips(subWrap, SPECIAL_DEFS, state.special, key => { state.special = key; });
        }
    }

    // 第三行：防具=甲种；v5.101 武器=武器类型（全部职业时 28 个，指定职业时 5 个/暗夜 3 个）
    function buildSub2Chips() {
        if (!sub2Wrap) return;
        if (state.cat === 'armor') {
            fillChips(sub2Wrap, ARMOR_DEFS, state.armor, key => { state.armor = key; });
            return;
        }
        if (state.cat === 'weapon') {
            const list = state.job === 'all' ? WG_ORDER : WG_ORDER.filter(wg => WG_JOB[wg] === state.job);
            fillChips(sub2Wrap, [['all', '全部类型']].concat(list.map(wg => [wg, WG_LABEL[wg]])), state.wg,
                key => { state.wg = key; });
            return;
        }
        sub2Wrap.innerHTML = '';
    }

    // 第四行：品质（仅装备页），与上面三级分类、搜索同时生效
    const RAR_DEFS = [['all', '全部品质'], ['3', '神器'], ['4', '史诗'], ['6', '传说']];
    function buildRarChips() {
        if (!rarWrap) return;
        fillChips(rarWrap, RAR_DEFS, state.rar, key => { state.rar = key; });
    }

    // v5.101：二次确认弹窗（不用原生 confirm，避免阻塞整页）
    let confirmEl = null;
    function closeConfirm() {
        if (confirmEl) { confirmEl.remove(); confirmEl = null; }
    }
    function askConfirm(title, text, okText, onOk) {
        closeConfirm();
        const box = document.createElement('div');
        box.className = 'g85-confirm';
        box.innerHTML = '<div class="g85-confirm-box"><div class="g85-confirm-title"></div><div class="g85-confirm-text"></div>' +
            '<div class="g85-confirm-btns"><button class="g85-cbtn" type="button" data-v="0">取消</button>' +
            '<button class="g85-cbtn primary" type="button" data-v="1"></button></div></div>';
        box.querySelector('.g85-confirm-title').textContent = title;
        box.querySelector('.g85-confirm-text').textContent = text;
        box.querySelector('.g85-cbtn.primary').textContent = okText || '确定';
        box.addEventListener('pointerdown', e => e.stopPropagation());
        box.addEventListener('click', e => {
            const b = e.target.closest('.g85-cbtn');
            if (!b) return;
            e.stopPropagation();
            const ok = b.getAttribute('data-v') === '1';
            closeConfirm();
            if (ok) onOk();
        });
        confirmEl = box;
        document.body.appendChild(box);
    }

    function askRefreshEquip() {
        askConfirm('刷新装备图鉴',
            '将重新枚举 7,745 个装备 ID 并逐件请求接口：约 75 秒、数千次请求（6 并发限速，可随时停止）。\n完成后覆盖本地缓存。\n确定现在刷新吗？',
            '确定刷新', () => { ensureEquipData(true); });
    }
    function askRefreshOrbs() {
        askConfirm('刷新宝珠图鉴',
            '将重新请求一次宝珠列表（当前 174 条）并覆盖本地缓存。\n只发 1 次请求，通常 1 秒内完成。\n确定现在刷新吗？',
            '确定刷新', () => { loadOrbs(true); });
    }

    function syncSubRows() {
        if (!subWrap || !sub2Wrap) return;
        subWrap.style.display = state.cat === 'all' ? 'none' : 'flex';
        sub2Wrap.style.display = (state.cat === 'armor' || state.cat === 'weapon') ? 'flex' : 'none';
        buildSub2Chips();
    }

    /* ================= v5.87 宝珠图鉴 =================
     * 数据：GET /api/orbs 一次拿全量（当前 174 条，需 Bearer dnf_idle_token）；
     * 图标：接口本身不带 icon_path，按 id 逐个 GET /api/items/{id} 取
     *       icon_path + icon_index 拼 sprite 文件名，串行 60ms 间隔，结果进
     *       localStorage（键 dnf_atlas_orbs_v5101，带版本号 v:5101，7 天过期）。
     * v5.101：缓存版本升到 5101，老用户旧缓存自动失效；补 avoid → 回避率。
     * 全部失败只影响宝珠页，装备页与其它功能不受影响。
     * ================================================== */
    const ORB_CACHE_KEY = 'dnf_atlas_orbs_v5101';
    const ORB_CACHE_VER = 5101;
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
        hitRate: '命中率', evasion: '回避率', avoid: '回避率', dmgReduce: '伤害减免',
    };
    const ORB_PCT_KEYS = ['pAtkPct', 'mAtkPct', 'atkSpd', 'castSpd', 'moveSpd', 'elemEnh', 'elemRes',
        'critP', 'critM', 'crit', 'hitRate', 'evasion', 'avoid', 'dmgReduce'];
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
        def: ['pDefFlat', 'mDefFlat', 'hpMax', 'mpMax', 'hpRegen', 'mpRegen', 'vit', 'avoid', 'dmgReduce'],
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
            // v5.90：小并发（4）+ 单请求 10s 超时；失败项保持空图标，下次打开再补。
            // 批与批之间留 120ms 间隔，避免对游戏接口形成并发风暴。
            const ROUND_SIZE = 4;
            let done = 0;
            for (let i = 0; i < todo.length; i += ROUND_SIZE) {
                const batch = todo.slice(i, i + ROUND_SIZE);
                await Promise.all(batch.map(async o => {
                    try {
                        const r = await apiFetch('/api/items/' + o.id, { headers: { Authorization: 'Bearer ' + token } });
                        if (r.ok) {
                            const d = await r.json();
                            o.icon = orbIconUrl(d.icon_path, d.icon_index);
                        }
                    } catch (_) { }
                }));
                done += batch.length;
                if (done % 20 === 0 || done >= todo.length) {
                    writeOrbCache();
                    if (atlasMode === 'orb' && !state.detail) renderOrbList();
                }
                if (i + ROUND_SIZE < todo.length) await orbSleep(ORB_ICON_GAP_MS * 2);
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
            const r = await apiFetch('/api/orbs', { headers: { Authorization: 'Bearer ' + token } });
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
        if (sub2Wrap) sub2Wrap.style.display = eq && (state.cat === 'armor' || state.cat === 'weapon') ? 'flex' : 'none';
        if (rarWrap) rarWrap.style.display = eq ? 'flex' : 'none';
        if (refreshEqBtn) refreshEqBtn.style.display = eq ? '' : 'none';
        if (refreshOrbBtn) refreshOrbBtn.style.display = eq ? 'none' : '';
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
        if (eq) { ensureEquipData(); renderList(); }
        else {
            if (!orbList && !orbState.loading) loadOrbs(false);
            renderOrbList();
        }
    }

    function switchAtlasMode(m) {
        if (atlasMode === m) return;
        closeConfirm();
        atlasMode = m;
        state.q = '';
        if (searchEl) searchEl.value = '';
        applyAtlasMode();
    }

    function buildPanel() {
        const p = document.createElement('div');
        p.className = 'g85-panel';
        p.style.display = 'none';
        p.innerHTML = '<div class="g85-head"><b>装备图鉴</b><span class="g85-count"></span><button class="g85-x" data-no-drag type="button" title="关闭">×</button></div>' +
            '<div class="g85-tabs"><div class="g85-tab on" data-mode="equip">装备</div><div class="g85-tab" data-mode="orb">宝珠</div>' +
            '<button class="g85-refresh" data-what="orb" type="button" title="刷新宝珠图鉴" style="display:none">刷新</button>' +
            '<button class="g85-refresh" data-what="equip" type="button" title="刷新装备图鉴">刷新</button></div>' +
            '<div class="g85-load" style="display:none"></div>' +
            '<div class="g85-search"><input placeholder="搜索名字 / 类型…" autocomplete="off"></div>' +
            '<div class="g85-chips g85-cats"></div>' +
            '<div class="g85-chips g85-sub"></div>' +
            '<div class="g85-chips g85-sub2"></div>' +
            '<div class="g85-chips g85-rar"></div>' +
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
        rarWrap = p.querySelector('.g85-rar');
        refreshEqBtn = p.querySelector('.g85-refresh[data-what="equip"]');
        refreshOrbBtn = p.querySelector('.g85-refresh[data-what="orb"]');
        countEl = p.querySelector('.g85-count');
        loadEl = p.querySelector('.g85-load');
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
        buildRarChips();
        // v5.101：滚动接近底部自动追加下一批，兜底还有「加载更多」按钮
        listEl.addEventListener('scroll', () => {
            if (!renderMoreEl) return;
            if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 160) appendBatch();
        });
        if (refreshEqBtn) refreshEqBtn.addEventListener('click', e => { e.stopPropagation(); askRefreshEquip(); });
        if (refreshOrbBtn) refreshOrbBtn.addEventListener('click', e => { e.stopPropagation(); askRefreshOrbs(); });
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
            // v5.100：装备页首次打开才开始按需拉取（有缓存则直接命中）
            if (atlasMode !== 'orb') ensureEquipData();
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
        // v5.88：移动端顶栏「兑换码」始终隐藏，不等商店打开；
        // 商店子标签里的克隆按原逻辑出现，克隆 click 仍转发给这个隐藏的原生按钮。
        if (!redeem.hasAttribute('data-dnf-redeem-native')) markHidden(redeem, 'data-dnf-redeem-native');
        // 原生按钮只隐藏不删除：克隆体 click 时还要靠它触发游戏自己的兑换码弹窗
        const produce = findGameButton('通用制作');
        if (!produce || !produce.parentElement) return;
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

    /* v5.90：记录是否真的注入过移动端改动。桌面端每秒调 applyGameUiTweaks 时
       若从未注入过，就直接返回，不再每次全文档查三个 data-* 属性。 */
    let _gameUiTweaksApplied = false;

    /** 撤回全部改动：删克隆、还原被隐藏的原生按钮（桌面端 / 切回桌面宽度时调用） */
    function revertGameUiTweaks() {
        if (!_gameUiTweaksApplied) return;
        _gameUiTweaksApplied = false;
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
        _gameUiTweaksApplied = true;
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

    /* ============================================================
     * 手动分解「获得物品」提示（v5.88）
     * ------------------------------------------------------------
     * 游戏分解成功后不展示产出，这里旁路读取服务端返回体（只读，不改请求/响应）：
     *   单件 POST /api/characters/{id}/decompose        {instance_id}
     *        → {item_name, outputs:[{item_id,count}], status:'decomposed'}
     *   批量 POST /api/characters/{id}/decompose-batch  {instance_ids}
     *        → {decomposed, outputs:[{item_id,count}], skipped:[], status}
     * outputs 只有 item_id + count，物品名按 id 查 /api/items/{id}（带内存+localStorage 缓存）。
     * 一次请求只弹一条 toast，按 item_id 累加数量；非 2xx / status 非 decomposed /
     * outputs 为空时一律不提示。axios 走 XHR，因此 fetch 与 XHR 两条路径都挂。
     * ============================================================ */
    const DECOMP_NAME_KEY = 'dnf_item_names_v588';
    let _decompNames = null;

    function decompNameCache() {
        if (_decompNames) return _decompNames;
        try { _decompNames = JSON.parse(localStorage.getItem(DECOMP_NAME_KEY) || '{}') || {}; } catch (_) { _decompNames = {}; }
        return _decompNames;
    }
    function saveDecompNames() {
        try { localStorage.setItem(DECOMP_NAME_KEY, JSON.stringify(_decompNames || {})); } catch (_) { }
    }
    function decompToken() {
        try { return localStorage.getItem('dnf_idle_token') || ''; } catch (_) { return ''; }
    }
    async function resolveItemName(itemId) {
        const cache = decompNameCache();
        if (cache[itemId]) return cache[itemId];
        const token = decompToken();
        if (!token) return '物品 ' + itemId;
        try {
            const r = await apiFetch('/api/items/' + itemId, { headers: { Authorization: 'Bearer ' + token } });
            if (r.ok) {
                const d = await r.json();
                if (d && d.name) { cache[itemId] = d.name; saveDecompNames(); return d.name; }
            }
        } catch (_) { }
        return '物品 ' + itemId;
    }

    /** 分解收益：与「立即处理」共用同一个收益弹窗（v5.96 起替代 toast） */
    async function presentDecomposeGain(outputs, count) {
        const agg = aggregateOutputs(outputs);
        if (!agg.size) return false;
        await renderGainPanel({
            title: '分解收益',
            sold: null,
            decomposed: Number(count) || 0,
            outputs: agg,
        });
        return true;
    }

    /** 只认分解接口的成功响应；其它情况静默 */
    function onDecomposeResponse(url, status, text) {
        try {
            if (!/\/decompose(-batch)?(\?|$)/.test(String(url || ''))) return;
            if (!(status >= 200 && status < 300)) return;
            const j = JSON.parse(text);
            if (!j || typeof j !== 'object') return;
            if (j.status && j.status !== 'decomposed') return;
            const count = Number(j.decomposed) || Number(j.count)
                || (Array.isArray(j.items) ? j.items.length : 0);
            presentDecomposeGain(j.outputs, count);
        } catch (_) { }
    }

    function initDecomposeGainToast() {
        if (window.__dnfDecompGain588) return;
        window.__dnfDecompGain588 = true;
        // ① fetch（保险：万一某次分解改走 fetch）
        if (typeof window.fetch === 'function') {
            const origFetch = window.fetch;
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const p = origFetch.apply(this, arguments);
                if (/\/decompose(-batch)?(\?|$)/.test(String(url))) {
                    p.then(resp => {
                        try {
                            const clone = resp.clone();
                            clone.text().then(txt => onDecomposeResponse(url, resp.status, txt)).catch(() => { });
                        } catch (_) { }
                    }).catch(() => { });
                }
                return p;
            };
        }
        // ② XHR（axios 默认走这里）
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__dnfDecompUrl = String(url || '');
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            const url = this.__dnfDecompUrl || '';
            if (/\/decompose(-batch)?(\?|$)/.test(url)) {
                this.addEventListener('load', () => {
                    onDecomposeResponse(url, this.status, this.responseText);
                });
            }
            return origSend.apply(this, arguments);
        };
    }

    /* ============================================================
     * 「立即处理」收益统计与弹窗（v5.95）
     * ------------------------------------------------------------
     * 游戏原生「自动过滤 → 立即处理现有背包」走：
     *   POST /api/characters/{id}/bag-filter-apply
     *   请求 {filter:{enabled,rarity_actions,below_level,slots}}
     *   响应 {sold, decomposed, gold_gained, outputs[]}
     * 原生只在 toast 里报件数，出售金币与分解产物都没有展示。
     *
     * 这里只旁路观察（不改请求/响应、不拦原生逻辑）：
     *   ① 请求发出前抓背包（装备 instance_id/品质/名称 + 材料数量）与金币；
     *   ② 响应成功后主动刷新背包，用前后差集推断「卖掉的是哪些品质」；
     *   ③ 分解产物优先用响应里的 outputs，缺失时用材料数量差兜底；
     *   ④ 弹窗只展示本次结果；装备详情页的分解收益也走同一个弹窗。
     * ============================================================ */
    let _gainPanelEl = null;

    function snapshotBagForFilter() {
        const store = getGameStore();
        if (!store) return null;
        const inv = (store.inventory && store.inventory.value) || [];
        const equip = new Map();
        const mats = new Map();
        for (const it of inv) {
            if (!it) continue;
            if (it.kind === 'equipment') {
                equip.set(String(it.instance_id), {
                    name: it.name || '',
                    rarity: Number(it.rarity) || 0,
                    price: Number(it.price) || 0,
                });
            } else {
                const id = Number(it.item_id);
                const n = Number(it.count) || 0;
                if (id && n > 0) mats.set(id, n);
            }
        }
        return {
            charId: (store.character && store.character.value && store.character.value.id) || 0,
            gold: (store.character && store.character.value && Number(store.character.value.gold)) || 0,
            equip, mats
        };
    }

    function filterActionsFromBody(body) {
        try {
            const obj = typeof body === 'string' ? JSON.parse(body) : body;
            const f = obj && obj.filter;
            if (!f || typeof f !== 'object') return null;
            const out = {};
            const ra = f.rarity_actions || {};
            Object.keys(ra).forEach(k => { out[Number(k)] = String(ra[k]); });
            return out;
        } catch (_) { return null; }
    }

    function aggregateOutputs(list) {
        const agg = new Map();
        (Array.isArray(list) ? list : []).forEach(o => {
            const id = Number(o && o.item_id);
            const n = Number(o && o.count) || 0;
            if (id && n > 0) agg.set(id, (agg.get(id) || 0) + n);
        });
        return agg;
    }

    function onFilterApplyResponse(url, status, text, before, body) {
        try {
            if (!/\/bag-filter-apply(\?|$)/.test(String(url || ''))) return;
            if (!(status >= 200 && status < 300)) return;
            const j = JSON.parse(text);
            if (!j || typeof j !== 'object') return;
            const sold = Number(j.sold) || 0;
            const decomposed = Number(j.decomposed) || 0;
            const gold = Number(j.gold_gained) || 0;
            if (sold <= 0 && decomposed <= 0 && gold <= 0) return;
            presentFilterGain(before, {
                sold, decomposed, gold,
                outputs: Array.isArray(j.outputs) ? j.outputs : [],
                actions: filterActionsFromBody(body),
            });
        } catch (_) { }
    }

    async function presentFilterGain(before, res) {
        const store = getGameStore();
        if (store && typeof store.loadInventory === 'function') {
            try { await store.loadInventory(); } catch (_) { }
        }
        await new Promise(r => setTimeout(r, 350));
        const after = snapshotBagForFilter();

        // 出售明细：处理前后消失的装备，按品质聚合；已知分解品质、以及 price<=0
        // （服务端卖不掉会自动转分解）的装备都不计入出售
        const soldByRarity = new Map();
        if (before && after) {
            before.equip.forEach((it, id) => {
                if (after.equip.has(id)) return;
                const act = res.actions ? res.actions[it.rarity] : '';
                if (act === 'decompose') return;
                if (!(Number(it.price) > 0)) return;
                soldByRarity.set(it.rarity, (soldByRarity.get(it.rarity) || 0) + 1);
            });
        }
        const inferredSold = Array.from(soldByRarity.values()).reduce((a, b) => a + b, 0);

        // 分解产物：优先服务端 outputs，缺失时用材料数量差
        let outputAgg = aggregateOutputs(res.outputs);
        if (!outputAgg.size && res.decomposed > 0 && before && after) {
            after.mats.forEach((n, id) => {
                const old = before.mats.get(id) || 0;
                if (n > old) outputAgg.set(id, n - old);
            });
            // 材料可能被同时消耗，过滤掉明显噪声（单项超过分解件数 * 20）
            const limit = Math.max(20, res.decomposed * 20);
            outputAgg.forEach((n, id) => { if (n > limit) outputAgg.delete(id); });
        }

        await renderGainPanel({
            title: '立即处理收益',
            sold: {
                count: res.sold,
                gold: res.gold,
                byRarity: soldByRarity,
                inferred: inferredSold,
            },
            decomposed: res.decomposed,
            outputs: outputAgg,
        });
    }

    /** 统一收益弹窗：出售（件数/金币/品质）+ 分解产物；只展示本次结果 */
    async function renderGainPanel(opts) {
        if (_gainPanelEl) { _gainPanelEl.remove(); _gainPanelEl = null; }
        const mask = uiEl('div', 'dnf-rp-mask');
        const panel = uiEl('div', 'dnf-rp-panel');
        _gainPanelEl = mask;
        panel.style.width = 'min(440px, calc(100vw - 16px))';
        panel.style.maxHeight = 'calc(100vh - 32px)';
        mask.addEventListener('click', (e) => {
            if (e.target === mask) { mask.remove(); if (_gainPanelEl === mask) _gainPanelEl = null; }
        });
        panel.addEventListener('click', (e) => e.stopPropagation());

        const head = uiEl('div', 'dnf-rp-head');
        const left = uiEl('div', '');
        const subParts = [];
        if (opts.sold) subParts.push(opts.sold.count + ' 件出售');
        if (opts.decomposed > 0) subParts.push(opts.decomposed + ' 件分解');
        left.append(
            uiEl('div', 'dnf-rp-title', opts.title || '收益'),
            uiEl('div', 'dnf-rp-sub', subParts.join(' · '))
        );
        const closeX = uiEl('button', 'dnf-rp-x', '×');
        closeX.type = 'button';
        closeX.title = '关闭';
        closeX.addEventListener('click', () => {
            mask.remove();
            if (_gainPanelEl === mask) _gainPanelEl = null;
        });
        head.append(left, closeX);

        const body = uiEl('div', 'dnf-rp-body');
        // ① 出售（仅立即处理路径有）
        if (opts.sold) {
            const sold = opts.sold;
            const soldSec = uiEl('div', 'dnf-fg-sec');
            const soldTitle = uiEl('div', 'dnf-fg-sec-title');
            soldTitle.append(uiEl('span', '', '出售'), uiEl('span', '', '+' + (Number(sold.gold) || 0).toLocaleString() + ' 金币'));
            soldSec.append(soldTitle);
            const soldCountRow = uiEl('div', 'dnf-fg-row');
            soldCountRow.append(uiEl('span', '', '共出售'), uiEl('span', '', sold.count + ' 件'));
            soldSec.append(soldCountRow);
            const raritys = Array.from((sold.byRarity || new Map()).keys()).sort((a, b) => a - b);
            if (raritys.length) {
                for (const r of raritys) {
                    const row = uiEl('div', 'dnf-fg-row');
                    row.append(uiEl('span', '', '· ' + (rarityNameOf(r) || ('品质 ' + r))),
                        uiEl('span', '', sold.byRarity.get(r) + ' 件'));
                    soldSec.append(row);
                }
                if (sold.inferred !== sold.count) {
                    soldSec.append(uiEl('div', 'dnf-fg-note',
                        '按品质为本地前后背包推断，' + (sold.inferred > sold.count ? '多于' : '少于')
                        + '服务端件数（可能含锁定/不可出售项）'));
                }
            } else if (sold.count > 0) {
                soldSec.append(uiEl('div', 'dnf-fg-note', '本次未能取得逐件明细（背包未加载或已被其他操作刷新）'));
            }
            body.append(soldSec);
        }

        // ② 分解产物（v5.98：没有分解件数也没有产物时整段不渲染）
        const hasDecompose = (Number(opts.decomposed) || 0) > 0
            || !!(opts.outputs && opts.outputs.size);
        if (hasDecompose) {
            const decSec = uiEl('div', 'dnf-fg-sec');
            const decTitle = uiEl('div', 'dnf-fg-sec-title');
            decTitle.append(uiEl('span', '', '分解'),
                uiEl('span', '', opts.decomposed > 0 ? (opts.decomposed + ' 件') : '产物'));
            decSec.append(decTitle);
            if (opts.outputs && opts.outputs.size) {
                for (const [id, n] of opts.outputs.entries()) {
                    const row = uiEl('div', 'dnf-fg-row');
                    row.append(uiEl('span', '', await resolveItemName(id)), uiEl('span', '', '×' + n));
                    decSec.append(row);
                }
            } else {
                decSec.append(uiEl('div', 'dnf-fg-note', '未返回分解产物明细'));
            }
            if ((Number(opts.decomposed) || 0) > 0) {
                decSec.append(uiEl('div', 'dnf-fg-note', '可能包含设为出售但无法卖出、由服务端自动转分解的装备'));
            }
            body.append(decSec);
        }

        const foot = uiEl('div', 'dnf-rp-foot');
        const ok = uiEl('button', 'dnf-rp-btn primary', '关闭');
        ok.type = 'button';
        ok.addEventListener('click', () => {
            mask.remove();
            if (_gainPanelEl === mask) _gainPanelEl = null;
        });
        foot.append(ok);

        panel.append(head, body, foot);
        mask.append(panel);
        document.body.append(mask);
    }

    /** 只旁路观察「立即处理」响应；不改请求、不拦原生流程 */
    function initFilterGainPopup() {
        if (window.__dnfFilterGain595) return;
        window.__dnfFilterGain595 = true;
        if (typeof window.fetch === 'function') {
            const origFetch = window.fetch;
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const hit = /\/bag-filter-apply(\?|$)/.test(String(url));
                const before = hit ? snapshotBagForFilter() : null;
                const body = hit && init ? init.body : null;
                const p = origFetch.apply(this, arguments);
                if (before) {
                    p.then(resp => {
                        try {
                            const clone = resp.clone();
                            clone.text().then(txt => onFilterApplyResponse(url, resp.status, txt, before, body)).catch(() => { });
                        } catch (_) { }
                    }).catch(() => { });
                }
                return p;
            };
        }
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__dnfFilterUrl = String(url || '');
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            const url = this.__dnfFilterUrl || '';
            if (/\/bag-filter-apply(\?|$)/.test(url)) {
                const before = snapshotBagForFilter();
                this.addEventListener('load', () => {
                    onFilterApplyResponse(url, this.status, this.responseText, before, body);
                });
            }
            return origSend.apply(this, arguments);
        };
    }

    /* ============================================================
     * 排行榜「复制技能」（v5.93 入口；v5.94 删除已死代码的三页面板）
     *
     * 入口：游戏原生排行榜角色详情弹窗 →「技能配置」页 →「技能配置（出战顺序）」
     *   块之后，只追加插件自己的按钮，不改写/移动原生节点；点击时才请求
     *   GET /api/characters/{id}/profile （一次点击只拉一次，禁止批量遍历榜单）。
     * 复制门槛：对方 character.job 与 grow_type 都与我方相同才可点「复制技能」。
     *
     * 复制流程（两段式）：
     *   阶段 0：拉双方数据 → 分「需降 / 需升 / 一致」，主动/被动分开；
     *           按归零返还与重学消耗分别算 SP/TP，给出够/不够与部分复制预演。
     *   一次总确认：对方信息、归零清单（含返还）、升级清单（含消耗）、
     *           合计与净变化、不可逆提示、0 级期间战力下降红字警告，
     *           勾选项「同时复制技能栏」（默认关）。
     *   阶段 1：按当前投入从大到小逐个 POST skill-reset-one，每项间隔 250ms，
     *           实时显示「已归零 k/N：名称 · 返还 SP +x」。
     *   阶段 2：被动优先、主动按 req_level 升序；目标 == max_level 先
     *           skill-upgrade-max 一次到位，否则逐级 skill-upgrade；
     *           TP 被动逐级 tp-learn；每级间隔 250ms；不足即停。
     *   收尾：GET /skills 对账，逐项输出「目标 / 实际 / 差额」+ 未完成项。
     *   技能栏：操作前快照自己的 skill-loadout；仅勾选时最后覆盖写入，
     *           未勾选但检测到被重置影响时用快照写回一次。
     * 失败：阶段一「继续 / 直接进入加点 / 中止」，阶段二「继续 / 停止并展示落差」；
     *       不自动回退、不自动重试。
     * ============================================================ */
    const SKILL_ACTION_GAP_MS = 250;

    let _copyPanelEl = null;
    let _copyBusy = false;
    let _copyTriggerBtn = null;

    function uiEl(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text != null) el.textContent = String(text);
        return el;
    }

    function sleepMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function authHeaders() {
        const token = localStorage.getItem('dnf_idle_token') || '';
        return token ? { Authorization: 'Bearer ' + token } : {};
    }

    async function fetchJson(url) {
        const res = await apiFetch(url, { headers: authHeaders() });
        let data = null;
        try { data = await res.json(); } catch (_) { }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || ('请求失败（HTTP ' + res.status + '）');
            throw new Error(msg);
        }
        return data;
    }

    async function getMyCharApi(store, path) {
        const charId = store && store.charId ? store.charId.value : null;
        if (!charId) throw new Error('未找到当前角色，无法读取技能数据');
        return fetchJson('/api/characters/' + charId + '/' + path);
    }

    /**
     * v5.93：复制技能入口——只追加在游戏原生排行榜角色详情弹窗的
     * 「技能配置（出战顺序）」块之后，不改写、不移动原生节点。
     * 识别方式：.modal-mask .modal .skill-pane 下存在 .loadout-box 且标题匹配；
     * 角色身份用弹窗头部「名字 + 职业名」匹配 store.rankingData，唯一匹配才注入。
     * 由 runLightScans 的 MutationObserver 驱动，弹窗关闭/切页后自动清理，避免残留与重复。
     */
    let _nativeCopyEl = null;
    let _nativeCopyKey = '';

    function removeNativeProfileCopyButton() {
        if (_nativeCopyEl && _nativeCopyEl.isConnected) _nativeCopyEl.remove();
        _nativeCopyEl = null;
        _nativeCopyKey = '';
    }

    /** 按「名字 + 职业名」在排行榜数据里找唯一记录；匹配到多条就不猜 */
    function findRankRecordByName(name, jobText) {
        const store = getGameStore();
        const rd = store && store.rankingData ? store.rankingData.value : null;
        const list = rd && Array.isArray(rd.ranking) ? rd.ranking : null;
        if (!name || !list || !list.length) return null;
        const hits = list.filter((r) => r && String(r.name || '').trim() === name
            && (!jobText || !r.job_name || jobText.indexOf(String(r.job_name)) >= 0));
        return hits.length === 1 ? hits[0] : null;
    }

    function applyNativeProfileCopyButton() {
        const pane = document.querySelector('.modal-mask .modal .skill-pane');
        const box = pane ? pane.querySelector('.loadout-box') : null;
        const titleOk = !!(box && Array.from(box.querySelectorAll('.box-title'))
            .some((t) => (t.textContent || '').indexOf('技能配置（出战顺序）') >= 0));
        if (!titleOk) { removeNativeProfileCopyButton(); return; }

        const mask = pane.closest('.modal-mask');
        const nameEl = mask && mask.querySelector('.head-name');
        const jobEl = mask && mask.querySelector('.head-job');
        const rec = findRankRecordByName(((nameEl || {}).textContent || '').trim(), ((jobEl || {}).textContent || '').trim());
        const store = getGameStore();
        const me = store && store.character ? store.character.value : null;
        // 找不到唯一记录、或查看的是自己：不注入，保持原生弹窗原样
        if (!rec || !rec.id || !me || (me.id && Number(rec.id) === Number(me.id))) {
            removeNativeProfileCopyButton();
            return;
        }

        const key = String(rec.id);
        if (_nativeCopyEl && _nativeCopyEl.isConnected && _nativeCopyKey === key) return;
        if (_nativeCopyEl && _nativeCopyEl.isConnected) _nativeCopyEl.remove();
        _nativeCopyEl = null;

        const same = rec.job === me.job && rec.grow_type === me.grow_type;
        const wrap = uiEl('div', 'dnf-npb');
        wrap.setAttribute('data-dnf-native-copy', key);
        const btn = uiEl('button', 'dnf-npb-btn', '复制技能');
        btn.type = 'button';
        const hint = uiEl('span', 'dnf-npb-hint', same
            ? '同职业、同成长方向：把对方的技能/被动等级复制到当前角色（执行前有一次总确认）'
            : '职业或成长方向与当前角色不同，无法复制技能');
        if (same) {
            btn.title = '把对方的技能/被动等级复制到当前角色（两段式，执行前有一次总确认）';
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (_copyBusy) { showTip('复制加点正在执行，请稍候'); return; }
                btn.disabled = true;
                btn.textContent = '读取中…';
                fetchJson('/api/characters/' + rec.id + '/profile').then((profile) => {
                    btn.textContent = '复制技能';
                    openCopyConfirm(profile, btn);
                }).catch((err) => {
                    btn.disabled = false;
                    btn.textContent = '复制技能';
                    showTip('读取对方技能失败：' + (err && err.message ? err.message : '未知错误'));
                });
            });
        } else {
            btn.disabled = true;
            btn.title = '仅同职业、同成长方向的角色可以复制技能';
        }
        wrap.append(btn, hint);
        box.insertAdjacentElement('afterend', wrap);
        _nativeCopyEl = wrap;
        _nativeCopyKey = key;
    }

    /** 阶段 0：拉双方数据，算差异、返还与消耗 */
    async function buildCopyPlan(profile) {
        const store = getGameStore();
        if (!store || !store.character || !store.character.value) throw new Error('未找到当前角色');
        const me = store.character.value;
        const [skills, loadout] = await Promise.all([
            getMyCharApi(store, 'skills'),
            getMyCharApi(store, 'skill-loadout')
        ]);

        const myEntries = [];
        for (const s of (skills.skills || [])) myEntries.push({ s, group: 'active' });
        for (const s of (skills.passives || [])) myEntries.push({ s, group: 'passive' });

        const otherActive = new Map();
        const otherPassive = new Map();
        for (const s of (profile.skills || [])) otherActive.set(Number(s.id), s);
        for (const s of (profile.passives || [])) otherPassive.set(Number(s.id), s);

        const resetItems = [];
        const raiseItems = [];
        const targets = [];
        const skipped = [];
        let sameCount = 0;

        for (const { s, group } of myEntries) {
            const id = Number(s.id);
            const oth = (group === 'active' ? otherActive : otherPassive).get(id);
            if (!oth) {
                skipped.push({ name: s.name || ('技能 ' + id), reason: '对方数据中没有该条' });
                continue;
            }
            if (s.auto_granted || s.automatic) {
                skipped.push({ name: s.name || ('技能 ' + id), reason: '自动习得，无法调整' });
                continue;
            }
            const cur = Number(s.learned_level) || 0;
            const max = Math.max(0, Number(s.max_level) || 0);
            let tgt = Number(oth.learned_level);
            if (!Number.isFinite(tgt)) tgt = Number(oth.eff_level) || 0;
            tgt = Math.max(0, Math.min(max, tgt));
            const starter = !!s.starter;
            if (group === 'active' && starter && tgt < 1) tgt = 1;

            const isTp = group === 'passive' && (s.passive_kind === 'tp'
                || (Number(s.tp_cost) > 0 && !(Number(s.sp_cost) > 0)));
            const spCost = Number(s.sp_cost) || 0;
            const tpCost = Number(s.tp_cost) || 0;
            const reqLevel = Number(s.req_level) || 0;

            if (tgt === cur) {
                targets.push({ id, name: s.name || ('技能 ' + id), target: tgt, group });
                sameCount++;
                continue;
            }

            if (tgt > cur) {
                const blocked = s.block_reason === 'awakening' || s.block_reason === 'level'
                    || s.block_reason === 'base' || (reqLevel > 0 && reqLevel > (Number(me.level) || 0));
                if (blocked) {
                    skipped.push({ name: s.name || ('技能 ' + id), reason: s.block_text || '当前无法学习（等级/觉醒限制）' });
                    continue;
                }
            }

            targets.push({ id, name: s.name || ('技能 ' + id), target: tgt, group });

            let lowered = false;
            if (cur > tgt) {
                const refundSp = isTp ? 0 : (starter ? Math.max(0, cur - 1) : cur) * spCost;
                const refundTp = isTp ? cur * (tpCost || 1) : 0;
                resetItems.push({
                    id, name: s.name || ('技能 ' + id), current: cur, target: tgt,
                    starter, isTp, refundSp, refundTp
                });
                lowered = true;
            }

            const base = lowered ? (starter ? 1 : 0) : cur;
            if (tgt > base) {
                const levels = tgt - base;
                raiseItems.push({
                    id, name: s.name || ('技能 ' + id), group, isTp,
                    from: base, to: tgt, max, reqLevel,
                    spCost, tpCost,
                    costSp: isTp ? 0 : levels * spCost,
                    costTp: isTp ? levels * (tpCost || 1) : 0
                });
            }
        }

        // 阶段一：按当前投入从大到小（等级优先，其次返还量）
        resetItems.sort((a, b) => (b.current - a.current)
            || ((b.refundSp + b.refundTp) - (a.refundSp + a.refundTp)));

        // 阶段二：被动优先，主动按 req_level 升序
        const raiseOrder = raiseItems.slice().sort((a, b) => {
            if (a.group !== b.group) return a.group === 'passive' ? -1 : 1;
            return (a.reqLevel - b.reqLevel) || (a.id - b.id);
        });

        const refundSp = resetItems.reduce((n, x) => n + x.refundSp, 0);
        const refundTp = resetItems.reduce((n, x) => n + x.refundTp, 0);
        const costSp = raiseOrder.reduce((n, x) => n + x.costSp, 0);
        const costTp = raiseOrder.reduce((n, x) => n + x.costTp, 0);
        const availSp = (Number(me.sp) || 0) + refundSp;
        const availTp = (Number(me.tp) || 0) + refundTp;
        const deficitSp = Math.max(0, costSp - availSp);
        const deficitTp = Math.max(0, costTp - availTp);

        // 部分复制预演（按阶段二顺序，整项分配）
        const partial = [];
        const unaffordable = [];
        if (deficitSp > 0 || deficitTp > 0) {
            let remSp = availSp;
            let remTp = availTp;
            for (const it of raiseOrder) {
                if (it.costSp <= remSp && it.costTp <= remTp) {
                    remSp -= it.costSp;
                    remTp -= it.costTp;
                    partial.push(it);
                } else {
                    unaffordable.push(it);
                }
            }
        }

        return {
            other: profile.character || {},
            me,
            resetItems,
            raiseItems,
            raiseOrder,
            targets,
            skipped,
            sameCount,
            refundSp, refundTp, costSp, costTp,
            availSp, availTp, deficitSp, deficitTp,
            partial, unaffordable,
            loadoutSnapshot: Array.isArray(loadout.entries) ? loadout.entries : [],
            otherLoadout: Array.isArray(profile.loadout) ? profile.loadout : []
        };
    }

    function closeCopyPanel() {
        if (_copyBusy) return;
        if (_copyPanelEl) {
            _copyPanelEl.remove();
            _copyPanelEl = null;
        }
        if (_copyTriggerBtn) {
            _copyTriggerBtn.disabled = false;
            _copyTriggerBtn = null;
        }
    }

    function openCopyConfirm(profile, triggerBtn) {
        if (_copyBusy) return;
        if (_copyPanelEl) closeCopyPanel();
        _copyTriggerBtn = triggerBtn || null;

        const mask = uiEl('div', 'dnf-rp-mask');
        const panel = uiEl('div', 'dnf-rp-panel');
        _copyPanelEl = mask;
        panel.addEventListener('click', (e) => e.stopPropagation());
        mask.addEventListener('click', (e) => { if (e.target === mask) closeCopyPanel(); });

        const head = uiEl('div', 'dnf-rp-head');
        const left = uiEl('div', '');
        const title = uiEl('div', 'dnf-rp-title', '复制加点');
        const sub = uiEl('div', 'dnf-rp-sub', '正在读取双方技能数据…');
        left.append(title, sub);
        const closeBtn = uiEl('button', 'dnf-rp-x', '×');
        closeBtn.type = 'button';
        closeBtn.title = '关闭';
        closeBtn.addEventListener('click', closeCopyPanel);
        head.append(left, closeBtn);

        const body = uiEl('div', 'dnf-rp-body', '加载中…');
        const foot = uiEl('div', 'dnf-rp-foot');
        panel.append(head, body, foot);
        mask.append(panel);
        document.body.append(mask);
        if (triggerBtn) triggerBtn.disabled = true;

        buildCopyPlan(profile).then((plan) => {
            if (_copyPanelEl !== mask) return;
            const ob = plan.other || {};
            sub.textContent = '对方：' + (ob.name || '?') + ' Lv.' + (ob.level != null ? ob.level : '?')
                + ' · ' + (ob.job_name || ob.job || '');
            renderCopyConfirm(plan, body, foot, closeBtn);
        }).catch((err) => {
            if (_copyPanelEl !== mask) return;
            sub.textContent = '读取失败';
            body.textContent = '';
            body.append(uiEl('div', 'dnf-rp-empty', '读取技能数据失败：' + (err && err.message ? err.message : '未知错误')));
            const cancel = uiEl('button', 'dnf-rp-btn', '关闭');
            cancel.type = 'button';
            cancel.addEventListener('click', closeCopyPanel);
            foot.append(cancel);
        });
    }

    function renderCopyConfirm(plan, body, foot, closeBtn) {
        body.textContent = '';
        foot.textContent = '';

        const sec = (titleText) => {
            const box = uiEl('div', 'dnf-cp-sec');
            box.append(uiEl('div', 'dnf-cp-sec-title', titleText));
            body.append(box);
            return box;
        };
        const ul = (parent, lines, cls) => {
            const list = uiEl('ul', cls || 'dnf-cp-list');
            for (const ln of lines) list.append(uiEl('li', '', ln));
            parent.append(list);
        };

        const totalActions = plan.resetItems.length + plan.raiseItems.length;
        if (!totalActions) {
            sec('无需调整').append(uiEl('div', 'dnf-cp-tip', '你与对方的主动/被动等级已经一致，没有需要归零或升级的项。'));
            if (plan.skipped.length) {
                const s = sec('跳过项');
                ul(s, plan.skipped.map(x => x.name + '：' + x.reason));
            }
            const done = uiEl('button', 'dnf-rp-btn', '关闭');
            done.type = 'button';
            done.addEventListener('click', closeCopyPanel);
            foot.append(done);
            return;
        }

        // 归零清单
        const r = sec('将归零（' + plan.resetItems.length + ' 项，返还 SP +' + plan.refundSp
            + (plan.refundTp ? ' / TP +' + plan.refundTp : '') + '）');
        if (!plan.resetItems.length) {
            r.append(uiEl('div', 'dnf-cp-tip', '无（没有高于对方的技能）'));
        } else {
            ul(r, plan.resetItems.map(x =>
                x.name + '：Lv.' + x.current + ' → ' + (x.starter ? 'Lv.1（起始技能）' : 'Lv.0')
                + ' · 返还 ' + (x.refundSp ? 'SP +' + x.refundSp : '') + (x.refundTp ? (x.refundSp ? '，' : '') + 'TP +' + x.refundTp : '')));
        }

        // 升级清单
        const u = sec('将升级（' + plan.raiseItems.length + ' 项，消耗 SP ' + plan.costSp
            + (plan.costTp ? ' / TP ' + plan.costTp : '') + '）');
        if (!plan.raiseItems.length) {
            u.append(uiEl('div', 'dnf-cp-tip', '无'));
        } else {
            ul(u, plan.raiseOrder.map(x =>
                x.name + '：Lv.' + x.from + ' → Lv.' + x.to
                + '（' + (x.isTp ? 'TP -' + x.costTp : 'SP -' + x.costSp) + '）'));
        }

        // 合计
        const sum = sec('合计');
        sum.append(uiEl('div', 'dnf-cp-tip',
            '可用 SP ' + plan.availSp + '（当前 ' + (Number(plan.me.sp) || 0) + ' + 返还 ' + plan.refundSp + '）'
            + ' · 升级需 ' + plan.costSp + '，净变化 ' + (plan.availSp - plan.costSp)));
        if (plan.costTp || plan.refundTp) {
            sum.append(uiEl('div', 'dnf-cp-tip',
                '可用 TP ' + plan.availTp + '（当前 ' + (Number(plan.me.tp) || 0) + ' + 返还 ' + plan.refundTp + '）'
                + ' · 升级需 ' + plan.costTp + '，净变化 ' + (plan.availTp - plan.costTp)));
        }
        if (plan.deficitSp > 0 || plan.deficitTp > 0) {
            sum.append(uiEl('div', 'dnf-cp-warn',
                '点数不足：还差 ' + (plan.deficitSp ? 'SP ' + plan.deficitSp : '')
                + (plan.deficitTp ? (plan.deficitSp ? ' / ' : '') + 'TP ' + plan.deficitTp : '')
                + '。按顺序最多可完成 ' + plan.partial.length + '/' + plan.raiseItems.length + ' 项升级，'
                + '剩余将停在可达等级。'));
        }
        if (plan.skipped.length) {
            sum.append(uiEl('div', 'dnf-cp-tip', '跳过 ' + plan.skipped.length + ' 项：'
                + plan.skipped.map(x => x.name).join('、')));
        }

        // 不可逆 + 中间态警告
        body.append(uiEl('div', 'dnf-cp-tip', '技能重置与学习均不可撤销，请确认后再执行。'));
        if (plan.resetItems.length) {
            body.append(uiEl('div', 'dnf-cp-warn',
                '执行期间以下 ' + plan.resetItems.length + ' 项会处于 0 级、战力明显下降，建议非战斗时执行：'
                + plan.resetItems.map(x => x.name).join('、') + '。'));
        }

        // 勾选项
        const opt = uiEl('label', 'dnf-cp-opt');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        opt.append(cb, uiEl('span', '', '同时复制技能栏（会覆盖你当前的出战技能配置）'));
        body.append(opt);

        const cancel = uiEl('button', 'dnf-rp-btn', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', closeCopyPanel);
        const start = uiEl('button', 'dnf-rp-btn primary', '开始执行');
        start.type = 'button';
        foot.append(cancel, start);

        start.addEventListener('click', () => {
            if (_copyBusy) return;
            const syncLoadout = cb.checked;
            start.disabled = true;
            cancel.disabled = true;
            cb.disabled = true;
            closeBtn.disabled = true;
            foot.textContent = '';
            body.textContent = '';
            const logEl = uiEl('div', 'dnf-cp-log');
            const actionsEl = uiEl('div', '');
            body.append(logEl, actionsEl);
            const ui = {
                actionsEl,
                append(text, kind) {
                    const line = uiEl('div', kind || '', text);
                    logEl.append(line);
                    logEl.scrollTop = logEl.scrollHeight;
                }
            };
            executeCopyPlan(plan, syncLoadout, ui).then(() => {
                closeBtn.disabled = false;
                const done = uiEl('button', 'dnf-rp-btn', '关闭');
                done.type = 'button';
                done.addEventListener('click', closeCopyPanel);
                foot.append(done);
            }).catch((err) => {
                ui.append('执行异常：' + (err && err.message ? err.message : '未知错误'), 'err');
                closeBtn.disabled = false;
                const done = uiEl('button', 'dnf-rp-btn', '关闭');
                done.type = 'button';
                done.addEventListener('click', closeCopyPanel);
                foot.append(done);
            });
        });
    }

    function askCopyChoice(ui, text, options) {
        return new Promise((resolve) => {
            const box = uiEl('div', 'dnf-cp-actions');
            box.append(uiEl('span', 'dnf-cp-warn', text));
            for (const o of options) {
                const b = uiEl('button', 'dnf-rp-btn' + (o.primary ? ' primary' : ''), o.label);
                b.type = 'button';
                b.addEventListener('click', () => {
                    box.remove();
                    resolve(o.key);
                });
                box.append(b);
            }
            ui.actionsEl.append(box);
        });
    }

    function isPointsShortError(msg) {
        const s = String(msg || '');
        return /(SP|TP|技能点|点数).{0,8}(不足|不够)/i.test(s) || /(不足|不够).{0,8}(SP|TP|技能点|点数)/i.test(s);
    }

    /** 单条技能升到目标等级；绝不越级 */
    async function raiseSkillTo(store, it, ui) {
        let cur = it.from;
        if (cur >= it.to) return;
        if (it.isTp) {
            while (cur < it.to) {
                await postCharacterApi(store, 'tp-learn', { skill_id: it.id }, 15000, '学习失败');
                cur++;
                ui.append('升级：' + it.name + ' Lv.' + cur + '/' + it.to, 'ok');
                if (cur < it.to) await sleepMs(SKILL_ACTION_GAP_MS);
            }
            return;
        }
        if (cur === 0) {
            await postCharacterApi(store, 'skill-learn', { skill_id: it.id }, 15000, '学习失败');
            cur = 1;
            ui.append('学习：' + it.name + ' Lv.1/' + it.to, 'ok');
            if (cur >= it.to) return;
            await sleepMs(SKILL_ACTION_GAP_MS);
        }
        if (it.to === it.max && it.max > 0) {
            const r = await postCharacterApi(store, 'skill-upgrade-max', { skill_id: it.id }, 15000, '升级失败');
            const lv = Number(r && r.level);
            const up = Number(r && r.upgraded);
            if (Number.isFinite(lv) && lv > cur) cur = lv;
            else if (Number.isFinite(up) && up > 0) cur = Math.min(it.to, cur + up);
            else cur = Math.min(it.to, cur + 1);
            ui.append('一次升满：' + it.name + ' Lv.' + cur + '/' + it.to, 'ok');
            if (cur < it.to) await sleepMs(SKILL_ACTION_GAP_MS);
        }
        while (cur < it.to) {
            await postCharacterApi(store, 'skill-upgrade', { skill_id: it.id }, 15000, '升级失败');
            cur++;
            ui.append('升级：' + it.name + ' Lv.' + cur + '/' + it.to, 'ok');
            if (cur < it.to) await sleepMs(SKILL_ACTION_GAP_MS);
        }
    }

    async function reconcileCopy(plan, store, ui) {
        let after = null;
        try { after = await getMyCharApi(store, 'skills'); }
        catch (err) {
            ui.append('对账失败：' + (err && err.message ? err.message : '未知错误'), 'err');
            return;
        }
        const map = new Map();
        for (const s of (after.skills || [])) map.set(Number(s.id), Number(s.learned_level) || 0);
        for (const s of (after.passives || [])) map.set(Number(s.id), Number(s.learned_level) || 0);
        ui.append('—— 对账（目标 / 实际 / 差额）——', 'warn');
        let bad = 0;
        for (const t of plan.targets) {
            if (!map.has(t.id)) {
                ui.append(t.name + '：目标 Lv.' + t.target + ' / 实际 未找到', 'warn');
                bad++;
                continue;
            }
            const actual = map.get(t.id);
            const diff = actual - t.target;
            if (diff !== 0) bad++;
            ui.append(t.name + '：目标 Lv.' + t.target + ' / 实际 Lv.' + actual
                + ' / 差额 ' + (diff > 0 ? '+' + diff : diff), diff === 0 ? 'ok' : 'err');
        }
        ui.append(bad ? ('仍有 ' + bad + ' 项与目标不一致') : '全部与目标一致', bad ? 'err' : 'ok');
    }

    function loadoutSignature(entries) {
        return JSON.stringify((entries || []).filter(e => e && e.enabled)
            .map(e => String(e.job) + ':' + String(e.skill_id)).sort());
    }

    async function syncSkillLoadout(plan, store, syncLoadout, ui) {
        try {
            if (syncLoadout) {
                const entries = (plan.otherLoadout || [])
                    .filter(e => e && e.enabled)
                    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
                    .map(e => ({ job: e.job, skill_id: e.skill_id }));
                if (!entries.length) {
                    ui.append('对方技能栏为空，已跳过技能栏复制', 'warn');
                    return;
                }
                await postCharacterApi(store, 'skill-loadout', { entries }, 15000, '技能栏覆盖失败');
                ui.append('已复制对方技能栏（' + entries.length + ' 项）', 'ok');
                return;
            }
            // 未勾选：只有检测到条目被重置动作影响时才写回一次快照
            const cur = await getMyCharApi(store, 'skill-loadout');
            if (loadoutSignature(cur.entries) === loadoutSignature(plan.loadoutSnapshot)) return;
            const entries = (plan.loadoutSnapshot || [])
                .filter(e => e && e.enabled)
                .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
                .map(e => ({ job: e.job, skill_id: e.skill_id }));
            if (!entries.length) return;
            await postCharacterApi(store, 'skill-loadout', { entries }, 15000, '技能栏恢复失败');
            ui.append('检测到技能栏被改动，已按快照写回（' + entries.length + ' 项）', 'warn');
        } catch (err) {
            ui.append('技能栏处理失败：' + (err && err.message ? err.message : '未知错误'), 'err');
        }
    }

    async function executeCopyPlan(plan, syncLoadout, ui) {
        if (_copyBusy) return;
        _copyBusy = true;
        const store = getGameStore();
        try {
            if (!store) throw new Error('未找到游戏状态，无法执行');

            // ===== 阶段 1：逐个归零 =====
            let abortAll = false;
            if (plan.resetItems.length) {
                ui.append('阶段一：逐个归零（' + plan.resetItems.length + ' 项）', 'warn');
            }
            for (let i = 0; i < plan.resetItems.length; i++) {
                const it = plan.resetItems[i];
                try {
                    const r = await postCharacterApi(store, 'skill-reset-one', { skill_id: it.id }, 15000, '重置失败');
                    const rs = Number(r && r.refund_sp) || 0;
                    const rt = Number(r && r.refund_tp) || 0;
                    ui.append('已归零 ' + (i + 1) + '/' + plan.resetItems.length + '：' + it.name
                        + ' · 返还 SP +' + rs + (rt ? '，TP +' + rt : ''), 'ok');
                } catch (err) {
                    const msg = err && err.message ? err.message : '未知错误';
                    ui.append('重置失败：' + it.name + ' · ' + msg, 'err');
                    const choice = await askCopyChoice(ui, '阶段一重置失败（' + it.name + '），如何处理？', [
                        { key: 'continue', label: '继续' },
                        { key: 'skipStage1', label: '直接进入加点' },
                        { key: 'abort', label: '中止' }
                    ]);
                    if (choice === 'abort') { abortAll = true; break; }
                    if (choice === 'skipStage1') break;
                }
                await sleepMs(SKILL_ACTION_GAP_MS);
            }

            // ===== 阶段 2：统一加点 =====
            if (!abortAll) {
                if (plan.raiseOrder.length) {
                    ui.append('阶段二：加点（' + plan.raiseOrder.length + ' 项，被动优先）', 'warn');
                }
                for (let i = 0; i < plan.raiseOrder.length; i++) {
                    const it = plan.raiseOrder[i];
                    try {
                        await raiseSkillTo(store, it, ui);
                    } catch (err) {
                        const msg = err && err.message ? err.message : '未知错误';
                        if (isPointsShortError(msg)) {
                            ui.append('点数不足，停止加点：' + msg, 'err');
                            const rest = plan.raiseOrder.slice(i).map(x => x.name);
                            if (rest.length) ui.append('未完成：' + rest.join('、'), 'warn');
                            break;
                        }
                        ui.append('升级失败（已跳过）：' + it.name + ' · ' + msg, 'err');
                        const choice = await askCopyChoice(ui, '阶段二升级失败（' + it.name + '），如何处理？', [
                            { key: 'continue', label: '继续' },
                            { key: 'stop', label: '停止并展示落差', primary: true }
                        ]);
                        if (choice === 'stop') {
                            ui.append('剩余未完成：' + plan.raiseOrder.slice(i + 1).map(x => x.name).join('、'), 'warn');
                            break;
                        }
                    }
                    await sleepMs(SKILL_ACTION_GAP_MS);
                }
            } else {
                ui.append('已中止：不再执行加点', 'err');
            }

            // ===== 对账 =====
            await reconcileCopy(plan, store, ui);

            // ===== 技能栏 =====
            await syncSkillLoadout(plan, store, syncLoadout, ui);

            ui.append('执行结束', 'warn');
        } finally {
            _copyBusy = false;
        }
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
        initProtectGuard();

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
        // v5.88：旁路读取分解响应，用 toast 提示实际获得的材料
        initDecomposeGainToast();
        // v5.95：旁路读取「立即处理」响应，弹窗展示出售金币与分解产物
        initFilterGainPopup();

        // 1. 扫描分层（v5.90：统一走模块级 runScans / runLightScans，不再本地重复定义）
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
