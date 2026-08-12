// ==UserScript==
// @name         网页自动刷新 Pro
// @namespace    https://www.wuaishare.cn/
// @version      1.3
// @description  自动刷新页面：支持网站范围或精准网址规则、倒计时/暂停/重置/设置、可拖拽面板与位置记忆；采用绝对时间计时，后台标签页也能保持更准确的刷新节奏。
// @author       吾爱分享网
// @homepageURL  https://github.com/wuaishare/smart-auto-refresh-pro
// @supportURL   https://github.com/wuaishare/smart-auto-refresh-pro/issues
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG_VERSION = 2;
    const CONFIG_KEY = 'autoRefreshConfig_v2';
    const LEGACY_CONFIG_KEY = 'urlRefreshMap';
    const PANEL_POS_KEY = 'autoRefreshPanelPos_v1';
    const MIN_INTERVAL = 1;
    const HIGH_FREQUENCY_WARNING_BELOW = 5;
    const DEFAULT_INTERVAL = 60;
    const FADE_DELAY_MS = 3000;
    const FADE_OPACITY = 0.35;

    let activeRule = null;
    let intervalSeconds = 0;
    let isPaused = false;
    let deadlineMs = 0;
    let pausedRemainingMs = 0;
    let countdownTimer = null;
    let countdownEl = null;
    let pauseBtn = null;
    const originalTitle = document.title;

    void init().catch((error) => {
        console.error('[网页自动刷新 Pro] 初始化失败：', error);
    });

    GM_registerMenuCommand('🛠 设置当前页面刷新间隔', () => runSafely(configureCurrentPage));
    GM_registerMenuCommand('❌ 关闭当前页面自动刷新', () => runSafely(disableCurrentPage));
    GM_registerMenuCommand('🗑 删除当前网站范围规则', () => runSafely(removeCurrentSiteRule));

    async function init() {
        const config = await loadConfig();
        activeRule = resolveRule(config, location.href, location.hostname);
        if (!activeRule) return;

        intervalSeconds = activeRule.seconds;
        await createControlPanel();
        startCountdown(intervalSeconds);
    }

    async function runSafely(action) {
        try {
            await action();
        } catch (error) {
            console.error('[网页自动刷新 Pro] 操作失败：', error);
            alert('❌ 操作失败，请打开开发者工具查看错误信息后重试。');
        }
    }

    async function configureCurrentPage() {
        const currentUrl = location.href;
        const currentHost = location.hostname;
        const config = await loadConfig();
        const currentRule = resolveRule(config, currentUrl, currentHost);
        const fallbackInterval = currentRule?.seconds
            || config.exact[currentUrl]
            || config.site[currentHost]
            || DEFAULT_INTERVAL;

        const seconds = askInterval(fallbackInterval);
        if (seconds === null) return;

        const scope = askScope(currentRule?.scope || 'exact', currentHost);
        if (!scope) return;

        delete config.disabled[currentUrl];

        let note = '';
        if (scope === 'site') {
            config.site[currentHost] = seconds;

            if (isValidInterval(config.exact[currentUrl])) {
                const removeExact = confirm(
                    `当前精准网址已有 ${config.exact[currentUrl]} 秒规则，它会优先于网站范围规则。\n\n` +
                    '点击“确定”：删除当前精准规则，让新的网站规则立即生效。\n' +
                    '点击“取消”：保留精准规则，仅更新网站默认规则。'
                );
                if (removeExact) {
                    delete config.exact[currentUrl];
                } else {
                    note = `\nℹ️ 当前页面仍会优先使用精准网址规则（${config.exact[currentUrl]} 秒）。`;
                }
            }
        } else {
            config.exact[currentUrl] = seconds;
        }

        await saveConfig(config);
        const scopeLabel = scope === 'site' ? `网站范围（${currentHost}）` : '当前精准网址';
        alert(`✅ 已将 ${scopeLabel} 设置为每 ${seconds} 秒刷新一次。${note}`);
        location.reload();
    }

    async function disableCurrentPage() {
        const currentUrl = location.href;
        const currentHost = location.hostname;
        const config = await loadConfig();
        const hasExactRule = isValidInterval(config.exact[currentUrl]);
        const hasSiteRule = isValidInterval(config.site[currentHost]);
        const isAlreadyExcluded = config.disabled[currentUrl] === true;

        if (!hasExactRule && !hasSiteRule) {
            alert(isAlreadyExcluded ? 'ℹ️ 当前页面已经处于关闭状态。' : 'ℹ️ 当前页面没有自动刷新规则。');
            return;
        }

        if (hasExactRule) {
            delete config.exact[currentUrl];
        }

        if (hasSiteRule) {
            config.disabled[currentUrl] = true;
        } else {
            delete config.disabled[currentUrl];
        }

        await saveConfig(config);

        const detail = hasSiteRule
            ? '网站范围规则会继续作用于同域名的其他页面；当前精准网址已加入排除列表。'
            : '当前精准网址规则已删除。';
        alert(`✅ 已关闭当前页面自动刷新。\n${detail}`);
        location.reload();
    }

    async function removeCurrentSiteRule() {
        const currentUrl = location.href;
        const currentHost = location.hostname;
        const config = await loadConfig();

        if (!isValidInterval(config.site[currentHost])) {
            alert('ℹ️ 当前网站没有网站范围刷新规则。');
            return;
        }

        delete config.site[currentHost];
        const clearedExclusions = clearDisabledRulesForHost(config, currentHost);
        await saveConfig(config);

        const exactStillActive = isValidInterval(config.exact[currentUrl]);
        const exclusionNote = clearedExclusions > 0
            ? `，并清理了 ${clearedExclusions} 条该网站的页面排除记录`
            : '';
        const exactNote = exactStillActive
            ? '\nℹ️ 当前页面仍有精准网址规则，因此会继续自动刷新。'
            : '';

        alert(`✅ 已删除 ${currentHost} 的网站范围规则${exclusionNote}。${exactNote}`);
        location.reload();
    }

    function askInterval(defaultValue) {
        const input = prompt(
            `请输入刷新间隔时间（单位：秒，整数且 ≥ ${MIN_INTERVAL}）：`,
            String(defaultValue)
        );
        if (input === null) return null;

        const value = parseIntervalInput(input);
        if (value === null) {
            alert(`❌ 无效输入。刷新时间必须是十进制整数，且不小于 ${MIN_INTERVAL} 秒。`);
            return null;
        }

        if (value < HIGH_FREQUENCY_WARNING_BELOW) {
            const accepted = confirm(
                `⚠️ ${value} 秒属于高频刷新，可能增加服务器负载并触发站点限流或风控。\n\n` +
                '仅在你确认目标网站允许高频刷新时使用。是否继续？'
            );
            if (!accepted) return null;
        }

        return value;
    }

    function askScope(defaultScope, currentHost) {
        const defaultChoice = defaultScope === 'exact' ? '2' : '1';
        const choice = prompt(
            '请选择刷新适用范围（输入数字）：\n\n' +
            `1. 网站范围：${currentHost} 下的页面默认使用此规则\n` +
            '2. 精准网址（更安全）：仅当前完整 URL 使用此规则\n\n' +
            '精准网址规则始终优先于网站范围规则。',
            defaultChoice
        );

        if (choice === null) return null;
        if (choice.trim() === '1') return 'site';
        if (choice.trim() === '2') return 'exact';

        alert('❌ 无效选择，请输入 1 或 2。');
        return null;
    }

    function startCountdown(seconds) {
        intervalSeconds = seconds;
        isPaused = false;
        pausedRemainingMs = seconds * 1000;
        deadlineMs = Date.now() + pausedRemainingMs;
        scheduleTick(0);
    }

    function scheduleTick(delayMs) {
        if (countdownTimer !== null) {
            clearTimeout(countdownTimer);
        }
        countdownTimer = setTimeout(tick, delayMs);
    }

    function tick() {
        countdownTimer = null;
        if (isPaused) {
            updateCountdownDisplay(pausedRemainingMs);
            return;
        }

        const remainingMs = Math.max(0, deadlineMs - Date.now());
        if (remainingMs <= 0) {
            location.reload();
            return;
        }

        updateCountdownDisplay(remainingMs);
        scheduleTick(Math.min(1000, remainingMs));
    }

    function togglePause() {
        if (isPaused) {
            isPaused = false;
            deadlineMs = Date.now() + Math.max(1, pausedRemainingMs);
            scheduleTick(0);
            return;
        }

        pausedRemainingMs = Math.max(0, deadlineMs - Date.now());
        isPaused = true;
        if (countdownTimer !== null) {
            clearTimeout(countdownTimer);
            countdownTimer = null;
        }
        updateCountdownDisplay(pausedRemainingMs);
    }

    function resetCountdown() {
        pausedRemainingMs = intervalSeconds * 1000;
        if (isPaused) {
            updateCountdownDisplay(pausedRemainingMs);
            return;
        }

        deadlineMs = Date.now() + pausedRemainingMs;
        scheduleTick(0);
    }

    function updateCountdownDisplay(remainingMs) {
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        const formatted = formatTime(remainingSeconds);

        if (countdownEl) {
            countdownEl.textContent = formatted;
        }
        if (pauseBtn) {
            pauseBtn.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
        }

        document.title = isPaused
            ? `[已暂停 ${formatted}] ${originalTitle}`
            : `[${formatted}] ${originalTitle}`;
    }

    async function createControlPanel() {
        const host = document.createElement('div');
        host.id = 'autoRefreshProPanel';
        host.style.cssText = [
            'position:fixed',
            'right:10px',
            'bottom:10px',
            'z-index:2147483647',
            'opacity:1',
            'transition:opacity 200ms ease'
        ].join(';');

        const root = typeof host.attachShadow === 'function'
            ? host.attachShadow({ mode: 'open' })
            : host;
        const scopeLabel = activeRule?.scope === 'site' ? '网站范围' : '精准网址';

        root.innerHTML = `
            <style>
                .sar-panel,
                .sar-panel * {
                    box-sizing: border-box;
                }
                .sar-panel {
                    width: max-content;
                    max-width: calc(100vw - 20px);
                    padding: 10px;
                    border: 1px solid rgba(255,255,255,.12);
                    border-radius: 9px;
                    background: rgba(20,20,24,.88);
                    color: #fff;
                    box-shadow: 0 8px 24px rgba(0,0,0,.28);
                    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    user-select: none;
                    -webkit-font-smoothing: antialiased;
                }
                .sar-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 10px;
                    margin-bottom: 7px;
                    cursor: move;
                    touch-action: none;
                }
                .sar-title {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-width: 0;
                    font-weight: 650;
                    white-space: nowrap;
                }
                .sar-badge {
                    padding: 1px 5px;
                    border: 1px solid rgba(255,255,255,.16);
                    border-radius: 999px;
                    background: rgba(255,255,255,.08);
                    font-size: 11px;
                    font-weight: 500;
                    opacity: .9;
                }
                .sar-drag-tip {
                    font-size: 11px;
                    white-space: nowrap;
                    opacity: .55;
                }
                .sar-time {
                    margin-bottom: 7px;
                    font-variant-numeric: tabular-nums;
                }
                .sar-time strong {
                    font-size: 15px;
                    font-weight: 650;
                }
                .sar-actions {
                    display: flex;
                    gap: 6px;
                    flex-wrap: wrap;
                }
                .sar-btn {
                    all: unset;
                    box-sizing: border-box;
                    padding: 4px 8px;
                    border: 1px solid rgba(255,255,255,.16);
                    border-radius: 6px;
                    background: rgba(255,255,255,.08);
                    color: #fff;
                    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    cursor: pointer;
                }
                .sar-btn:hover,
                .sar-btn:focus-visible {
                    background: rgba(255,255,255,.16);
                    outline: none;
                }
            </style>
            <div class="sar-panel" role="region" aria-label="自动刷新控制面板">
                <div class="sar-header" id="dragHandle">
                    <div class="sar-title">
                        <span>⏱ 自动刷新</span>
                        <span class="sar-badge">${scopeLabel}</span>
                    </div>
                    <span class="sar-drag-tip">拖动这里</span>
                </div>
                <div class="sar-time">剩余：<strong id="countdown">${formatTime(intervalSeconds)}</strong></div>
                <div class="sar-actions">
                    <button class="sar-btn" id="pauseBtn" type="button">⏸ 暂停</button>
                    <button class="sar-btn" id="resetBtn" type="button">↻ 重置</button>
                    <button class="sar-btn" id="setBtn" type="button">⚙ 设置</button>
                </div>
            </div>
        `;

        (document.body || document.documentElement).appendChild(host);

        countdownEl = root.querySelector('#countdown');
        pauseBtn = root.querySelector('#pauseBtn');
        const resetBtn = root.querySelector('#resetBtn');
        const setBtn = root.querySelector('#setBtn');
        const dragHandle = root.querySelector('#dragHandle');

        pauseBtn.addEventListener('click', togglePause);
        resetBtn.addEventListener('click', resetCountdown);
        setBtn.addEventListener('click', () => runSafely(configureCurrentPage));

        const savedPos = await loadPanelPos();
        let hasCustomPosition = false;
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            hasCustomPosition = true;
            setPanelPosition(host, savedPos.left, savedPos.top);
        }

        let fadeTimer = null;
        const setOpaque = (opaque) => {
            host.style.opacity = opaque ? '1' : String(FADE_OPACITY);
        };
        const clearFadeTimer = () => {
            if (fadeTimer !== null) {
                clearTimeout(fadeTimer);
                fadeTimer = null;
            }
        };
        const showPanel = () => {
            clearFadeTimer();
            setOpaque(true);
        };
        const scheduleFade = () => {
            clearFadeTimer();
            fadeTimer = setTimeout(() => {
                fadeTimer = null;
                setOpaque(false);
            }, FADE_DELAY_MS);
        };

        host.addEventListener('mouseenter', showPanel, true);
        host.addEventListener('pointerdown', showPanel, true);
        host.addEventListener('focusin', showPanel, true);
        host.addEventListener('mouseleave', scheduleFade, true);
        host.addEventListener('focusout', scheduleFade, true);
        scheduleFade();

        let dragging = false;
        let startOffsetX = 0;
        let startOffsetY = 0;

        dragHandle.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch' && event.button !== 0) return;

            dragging = true;
            hasCustomPosition = true;
            showPanel();

            const rect = host.getBoundingClientRect();
            startOffsetX = event.clientX - rect.left;
            startOffsetY = event.clientY - rect.top;
            setPanelPosition(host, rect.left, rect.top);

            dragHandle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });

        window.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            showPanel();
            setPanelPosition(host, event.clientX - startOffsetX, event.clientY - startOffsetY);
        }, true);

        const finishDrag = (event) => {
            if (!dragging) return;
            dragging = false;
            dragHandle.releasePointerCapture?.(event.pointerId);
            void savePanelPosition(host);
            scheduleFade();
        };

        window.addEventListener('pointerup', finishDrag, true);
        window.addEventListener('pointercancel', finishDrag, true);

        window.addEventListener('resize', () => {
            if (!hasCustomPosition) return;
            const rect = host.getBoundingClientRect();
            setPanelPosition(host, rect.left, rect.top);
        });
    }

    function setPanelPosition(panel, requestedLeft, requestedTop) {
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        const left = clamp(requestedLeft, 0, maxLeft);
        const top = clamp(requestedTop, 0, maxTop);

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    async function savePanelPosition(panel) {
        const rect = panel.getBoundingClientRect();
        try {
            await GM_setValue(PANEL_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
        } catch (error) {
            console.warn('[网页自动刷新 Pro] 面板位置保存失败：', error);
        }
    }

    async function loadPanelPos() {
        const raw = await GM_getValue(PANEL_POS_KEY, '');
        const parsed = parseStoredValue(raw, null);
        if (!parsed || typeof parsed !== 'object') return null;

        const left = Number(parsed.left);
        const top = Number(parsed.top);
        return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
    }

    async function loadConfig() {
        const rawV2 = await GM_getValue(CONFIG_KEY, '');
        const parsedV2 = parseStoredValue(rawV2, null);
        const normalizedV2 = normalizeConfig(parsedV2);
        if (normalizedV2) return normalizedV2;

        const legacyRaw = await GM_getValue(LEGACY_CONFIG_KEY, '{}');
        const legacyConfig = parseStoredValue(legacyRaw, {});
        const migrated = migrateLegacyConfig(legacyConfig);

        if (hasAnyConfigData(migrated)) {
            try {
                await saveConfig(migrated);
            } catch (error) {
                console.warn('[网页自动刷新 Pro] 旧配置迁移后保存失败，将继续使用本次迁移结果：', error);
            }
        }

        return migrated;
    }

    async function saveConfig(config) {
        const normalized = normalizeConfig(config) || createEmptyConfig();
        await GM_setValue(CONFIG_KEY, JSON.stringify(normalized));
    }

    function createEmptyConfig() {
        return {
            version: CONFIG_VERSION,
            site: {},
            exact: {},
            disabled: {}
        };
    }

    function normalizeConfig(value) {
        if (!value || typeof value !== 'object' || Number(value.version) !== CONFIG_VERSION) {
            return null;
        }

        return {
            version: CONFIG_VERSION,
            site: sanitizeIntervalMap(value.site),
            exact: sanitizeIntervalMap(value.exact),
            disabled: sanitizeDisabledMap(value.disabled)
        };
    }

    function migrateLegacyConfig(value) {
        const migrated = createEmptyConfig();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return migrated;

        for (const [ruleKey, rawSeconds] of Object.entries(value)) {
            const seconds = Number(rawSeconds);
            if (!ruleKey || !isValidInterval(seconds)) continue;

            if (/^https?:\/\//i.test(ruleKey)) {
                migrated.exact[ruleKey] = seconds;
            } else {
                migrated.site[ruleKey] = seconds;
            }
        }

        return migrated;
    }

    function sanitizeIntervalMap(value) {
        const result = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;

        for (const [ruleKey, rawSeconds] of Object.entries(value)) {
            const seconds = Number(rawSeconds);
            if (ruleKey && isValidInterval(seconds)) {
                result[ruleKey] = seconds;
            }
        }
        return result;
    }

    function sanitizeDisabledMap(value) {
        const result = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return result;

        for (const [url, disabled] of Object.entries(value)) {
            if (url && disabled === true) {
                result[url] = true;
            }
        }
        return result;
    }

    function resolveRule(config, url, host) {
        const exactSeconds = config?.exact?.[url];
        if (isValidInterval(exactSeconds)) {
            return { scope: 'exact', key: url, seconds: exactSeconds };
        }

        if (config?.disabled?.[url] === true) {
            return null;
        }

        const siteSeconds = config?.site?.[host];
        if (isValidInterval(siteSeconds)) {
            return { scope: 'site', key: host, seconds: siteSeconds };
        }

        return null;
    }

    function clearDisabledRulesForHost(config, host) {
        let cleared = 0;
        for (const url of Object.keys(config.disabled)) {
            try {
                if (new URL(url).hostname === host) {
                    delete config.disabled[url];
                    cleared++;
                }
            } catch {
                // Ignore malformed legacy/manual entries.
            }
        }
        return cleared;
    }

    function hasAnyConfigData(config) {
        return Object.keys(config.site).length > 0
            || Object.keys(config.exact).length > 0
            || Object.keys(config.disabled).length > 0;
    }

    function parseStoredValue(raw, fallback) {
        if (raw && typeof raw === 'object') return raw;
        if (typeof raw !== 'string' || raw === '') return fallback;

        try {
            return JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function parseIntervalInput(input) {
        if (typeof input !== 'string') return null;
        const normalized = input.trim();
        if (!/^\d+$/.test(normalized)) return null;

        const value = Number(normalized);
        return isValidInterval(value) ? value : null;
    }

    function isValidInterval(value) {
        return Number.isSafeInteger(value) && value >= MIN_INTERVAL;
    }

    function formatTime(totalSeconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
})();
