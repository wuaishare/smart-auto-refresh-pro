// ==UserScript==
// @name         网页自动刷新 Pro
// @namespace    https://www.wuaishare.cn/
// @version      1.3.1
// @description  自动刷新页面：支持网站范围或精准网址规则、统一设置管理、Mini Timer、倒计时/暂停/重置、可拖拽面板与位置记忆；采用绝对时间计时。
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
    const COLLAPSE_DELAY_MS = 5000;

    let activeRule = null;
    let intervalSeconds = 0;
    let isPaused = false;
    let deadlineMs = 0;
    let pausedRemainingMs = 0;
    let countdownTimer = null;
    let countdownEl = null;
    let pauseBtn = null;
    let miniTimeEl = null;
    let miniIconEl = null;
    let miniButtonEl = null;
    let uiHost = null;
    let uiRoot = null;
    let panelEl = null;
    let panelMode = 'expanded';
    let collapseTimer = null;
    let isDragging = false;
    let settingsDialogOpen = false;
    let hasCustomPanelPosition = false;
    const originalTitle = document.title;

    void init().catch((error) => {
        console.error('[网页自动刷新 Pro] 初始化失败：', error);
    });

    GM_registerMenuCommand('⚙ 设置 / 管理自动刷新', () => runSafely(openSettingsDialog));

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

    async function openSettingsDialog() {
        const currentUrl = location.href;
        const currentHost = location.hostname;
        const config = await loadConfig();
        const state = getSettingsState(config, currentUrl, currentHost);
        const root = ensureUiSurface();
        const previousFocus = root.activeElement || document.activeElement;

        root.querySelector('#sarSettingsBackdrop')?.remove();
        settingsDialogOpen = true;
        clearCollapseTimer();
        if (panelEl) setPanelMode('expanded');

        const backdrop = document.createElement('div');
        backdrop.id = 'sarSettingsBackdrop';
        backdrop.className = 'sar-dialog-backdrop';
        backdrop.innerHTML = `
            <section class="sar-dialog" role="dialog" aria-modal="true" aria-labelledby="sarDialogTitle">
                <div class="sar-dialog-head">
                    <div>
                        <h2 id="sarDialogTitle">设置 / 管理自动刷新</h2>
                        <p id="sarDialogStatus" class="sar-dialog-status"></p>
                    </div>
                    <button class="sar-icon-btn" id="sarDialogClose" type="button" aria-label="关闭设置">×</button>
                </div>

                <form id="sarSettingsForm" novalidate>
                    <label class="sar-field">
                        <span class="sar-label">刷新间隔</span>
                        <span class="sar-number-wrap">
                            <input id="sarIntervalInput" type="text" inputmode="numeric" autocomplete="off" value="${state.seconds}">
                            <span>秒</span>
                        </span>
                    </label>

                    <fieldset class="sar-fieldset">
                        <legend>适用范围</legend>
                        <label class="sar-radio-card">
                            <input type="radio" name="sarScope" value="exact" ${state.scope === 'exact' ? 'checked' : ''}>
                            <span><strong>精准网址</strong><small>仅当前完整 URL，优先级最高</small></span>
                        </label>
                        <label class="sar-radio-card">
                            <input type="radio" name="sarScope" value="site" ${state.scope === 'site' ? 'checked' : ''}>
                            <span><strong>网站范围</strong><small>${currentHost} 下的页面默认使用此规则</small></span>
                        </label>
                    </fieldset>

                    <div id="sarOverrideChoice" class="sar-inline-card" hidden>
                        <strong>当前页面已有精准网址规则</strong>
                        <p>精准规则会优先于网站范围规则。请选择保存网站规则后如何处理当前精准规则。</p>
                        <label><input type="radio" name="sarOverride" value="keep" checked> 保留精准规则</label>
                        <label><input type="radio" name="sarOverride" value="remove"> 删除精准规则，让网站规则立即生效</label>
                    </div>

                    <div id="sarDialogMessage" class="sar-message" hidden></div>

                    <button class="sar-primary-btn" id="sarSaveBtn" type="submit">保存设置</button>
                </form>

                <div id="sarManageActions" class="sar-manage-actions">
                    ${state.hasExactRule || (state.hasSiteRule && !state.isDisabled)
                        ? '<button class="sar-secondary-btn" id="sarDisableBtn" type="button">停用当前页面</button>'
                        : ''}
                    ${state.hasSiteRule
                        ? '<button class="sar-danger-btn" id="sarDeleteSiteBtn" type="button">删除网站范围规则</button>'
                        : ''}
                </div>

                <div id="sarActionConfirm" class="sar-action-confirm" hidden>
                    <p id="sarActionConfirmText"></p>
                    <div class="sar-confirm-actions">
                        <button class="sar-danger-btn" id="sarActionConfirmYes" type="button">确认</button>
                        <button class="sar-secondary-btn" id="sarActionConfirmNo" type="button">取消</button>
                    </div>
                </div>
            </section>
        `;
        root.appendChild(backdrop);

        const dialog = backdrop.querySelector('.sar-dialog');
        const form = backdrop.querySelector('#sarSettingsForm');
        const intervalInput = backdrop.querySelector('#sarIntervalInput');
        const saveBtn = backdrop.querySelector('#sarSaveBtn');
        const messageEl = backdrop.querySelector('#sarDialogMessage');
        const statusEl = backdrop.querySelector('#sarDialogStatus');
        const overrideChoice = backdrop.querySelector('#sarOverrideChoice');
        const closeBtn = backdrop.querySelector('#sarDialogClose');
        const disableBtn = backdrop.querySelector('#sarDisableBtn');
        const deleteSiteBtn = backdrop.querySelector('#sarDeleteSiteBtn');
        const actionConfirm = backdrop.querySelector('#sarActionConfirm');
        const actionConfirmText = backdrop.querySelector('#sarActionConfirmText');
        const actionConfirmYes = backdrop.querySelector('#sarActionConfirmYes');
        const actionConfirmNo = backdrop.querySelector('#sarActionConfirmNo');
        let pendingHighFrequencyValue = null;

        statusEl.textContent = describeSettingsStatus(state);

        const setMessage = (text, kind = 'error') => {
            messageEl.textContent = text;
            messageEl.dataset.kind = kind;
            messageEl.hidden = !text;
        };

        const resetPendingSave = () => {
            pendingHighFrequencyValue = null;
            saveBtn.textContent = '保存设置';
            setMessage('');
        };

        const hideActionConfirm = () => {
            actionConfirm.hidden = true;
            actionConfirmYes.onclick = null;
        };

        const showActionConfirm = (text, onConfirm) => {
            setMessage('');
            actionConfirmText.textContent = text;
            actionConfirm.hidden = false;
            actionConfirmYes.onclick = async () => {
                actionConfirmYes.disabled = true;
                try {
                    await onConfirm();
                } catch (error) {
                    actionConfirmYes.disabled = false;
                    console.error('[网页自动刷新 Pro] 管理操作失败：', error);
                    setMessage('操作失败，请稍后重试。');
                }
            };
            actionConfirmNo.focus();
        };

        const updateOverrideChoice = () => {
            const scope = form.elements.sarScope.value;
            overrideChoice.hidden = !(scope === 'site' && state.hasExactRule);
        };

        const closeDialog = () => {
            if (!backdrop.isConnected) return;
            backdrop.remove();
            settingsDialogOpen = false;
            if (panelEl) scheduleCollapse();
            if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
                previousFocus.focus();
            }
        };

        const focusableElements = () => [...dialog.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter((element) => !element.hidden && element.offsetParent !== null);

        const handleKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (!actionConfirm.hidden) {
                    hideActionConfirm();
                    return;
                }
                closeDialog();
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = focusableElements();
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const activeElement = root.activeElement || document.activeElement;
            if (event.shiftKey && activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        form.addEventListener('change', (event) => {
            if (event.target.name === 'sarScope') updateOverrideChoice();
            resetPendingSave();
        });

        intervalInput.addEventListener('input', resetPendingSave);

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            hideActionConfirm();

            const seconds = parseIntervalInput(intervalInput.value);
            if (seconds === null) {
                saveBtn.textContent = '保存设置';
                setMessage(`刷新时间必须是十进制整数，且不小于 ${MIN_INTERVAL} 秒。`);
                intervalInput.focus();
                return;
            }

            if (seconds < HIGH_FREQUENCY_WARNING_BELOW && pendingHighFrequencyValue !== seconds) {
                pendingHighFrequencyValue = seconds;
                setMessage(`${seconds} 秒属于高频刷新，可能增加服务器负载并触发限流或风控。确认无误后再次点击“保存设置”。`, 'warning');
                saveBtn.textContent = '确认高频并保存';
                return;
            }

            const scope = form.elements.sarScope.value;
            const overrideDecision = form.elements.sarOverride?.value || 'keep';
            applyRuleUpdate(config, {
                url: currentUrl,
                host: currentHost,
                seconds,
                scope,
                removeExactOverride: scope === 'site' && overrideDecision === 'remove'
            });

            saveBtn.disabled = true;
            setMessage('正在保存设置…', 'success');
            try {
                await saveConfig(config);
                setMessage('设置已保存，正在应用…', 'success');
                location.reload();
            } catch (error) {
                saveBtn.disabled = false;
                saveBtn.textContent = '保存设置';
                console.error('[网页自动刷新 Pro] 设置保存失败：', error);
                setMessage('设置保存失败，请稍后重试。');
            }
        });

        closeBtn.addEventListener('click', closeDialog);
        backdrop.addEventListener('pointerdown', (event) => {
            if (event.target === backdrop) closeDialog();
        });
        backdrop.addEventListener('keydown', handleKeydown);
        actionConfirmNo.addEventListener('click', hideActionConfirm);

        disableBtn?.addEventListener('click', () => {
            showActionConfirm(
                state.hasSiteRule
                    ? '确认停用当前页面？网站范围规则仍会继续作用于同站其他页面。'
                    : '确认停用当前页面？当前精准网址规则将被删除。',
                async () => {
                    disableUrl(config, { url: currentUrl, host: currentHost });
                    await saveConfig(config);
                    location.reload();
                }
            );
        });

        deleteSiteBtn?.addEventListener('click', () => {
            showActionConfirm(
                `确认删除 ${currentHost} 的网站范围规则？该网站已有的页面排除记录也会一并清理。`,
                async () => {
                    removeSiteRule(config, { host: currentHost });
                    await saveConfig(config);
                    location.reload();
                }
            );
        });

        updateOverrideChoice();
        intervalInput.focus();
        intervalInput.select();
    }

    function describeSettingsStatus(state) {
        if (state.effectiveScope === 'exact') {
            return `当前状态：精准网址 · 每 ${state.seconds} 秒刷新`;
        }
        if (state.effectiveScope === 'site') {
            return `当前状态：网站范围 · 每 ${state.seconds} 秒刷新`;
        }
        if (state.isDisabled && state.hasSiteRule) {
            return '当前状态：此页面已停用，网站范围规则仍存在';
        }
        return '当前状态：未启用自动刷新';
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
        const presentation = getPanelPresentation(panelMode, isPaused, remainingSeconds);

        if (countdownEl) countdownEl.textContent = presentation.time;
        if (pauseBtn) pauseBtn.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
        if (miniTimeEl) miniTimeEl.textContent = presentation.time;
        if (miniIconEl) miniIconEl.textContent = presentation.icon;
        if (miniButtonEl) miniButtonEl.setAttribute('aria-label', presentation.label);

        document.title = isPaused
            ? `[已暂停 ${presentation.time}] ${originalTitle}`
            : `[${presentation.time}] ${originalTitle}`;
    }

    function ensureUiSurface() {
        if (uiHost?.isConnected && uiRoot) return uiRoot;

        uiHost = document.createElement('div');
        uiHost.id = 'autoRefreshProPanel';
        uiHost.style.cssText = [
            'position:fixed',
            'right:10px',
            'bottom:10px',
            'z-index:2147483647'
        ].join(';');

        uiRoot = typeof uiHost.attachShadow === 'function'
            ? uiHost.attachShadow({ mode: 'open' })
            : uiHost;

        const style = document.createElement('style');
        style.textContent = `
            *, *::before, *::after { box-sizing: border-box; }
            button, input { font: inherit; }
            button { -webkit-tap-highlight-color: transparent; }

            .sar-panel {
                width: max-content;
                max-width: calc(100vw - 20px);
                color: #fff;
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                user-select: none;
                -webkit-font-smoothing: antialiased;
            }
            .sar-expanded {
                padding: 10px;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 10px;
                background: rgba(20,20,24,.9);
                box-shadow: 0 8px 24px rgba(0,0,0,.28);
                transform-origin: bottom right;
                animation: sarIn 150ms ease-out;
            }
            .sar-mini {
                display: none;
                align-items: center;
                gap: 6px;
                min-height: 32px;
                padding: 6px 9px;
                border: 1px solid rgba(255,255,255,.1);
                border-radius: 999px;
                background: rgba(20,20,24,.76);
                color: #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,.2);
                font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-variant-numeric: tabular-nums;
                cursor: pointer;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }
            .sar-mini:hover,
            .sar-mini:focus-visible {
                background: rgba(20,20,24,.9);
                outline: 2px solid rgba(120,180,255,.8);
                outline-offset: 2px;
            }
            .sar-panel[data-mode="mini"] .sar-expanded { display: none; }
            .sar-panel[data-mode="mini"] .sar-mini { display: flex; }
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
                padding: 1px 6px;
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
            .sar-btn,
            .sar-primary-btn,
            .sar-secondary-btn,
            .sar-danger-btn,
            .sar-icon-btn {
                border: 0;
                border-radius: 7px;
                cursor: pointer;
            }
            .sar-btn {
                padding: 5px 8px;
                border: 1px solid rgba(255,255,255,.14);
                background: rgba(255,255,255,.08);
                color: #fff;
                font-size: 12px;
            }
            .sar-btn:hover,
            .sar-btn:focus-visible {
                background: rgba(255,255,255,.16);
                outline: 2px solid rgba(120,180,255,.8);
                outline-offset: 1px;
            }

            .sar-dialog-backdrop {
                position: fixed;
                inset: 0;
                z-index: 10;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                background: rgba(0,0,0,.34);
                backdrop-filter: blur(2px);
                -webkit-backdrop-filter: blur(2px);
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                color: #18181b;
            }
            .sar-dialog {
                width: min(430px, calc(100vw - 24px));
                max-height: min(720px, calc(100vh - 24px));
                overflow: auto;
                padding: 18px;
                border: 1px solid rgba(0,0,0,.08);
                border-radius: 16px;
                background: #fff;
                box-shadow: 0 24px 64px rgba(0,0,0,.26);
                animation: sarDialogIn 170ms ease-out;
            }
            .sar-dialog-head {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 14px;
                margin-bottom: 16px;
            }
            .sar-dialog h2 {
                margin: 0;
                color: #111827;
                font-size: 18px;
                line-height: 1.3;
            }
            .sar-dialog-status {
                margin: 5px 0 0;
                color: #6b7280;
                font-size: 12px;
            }
            .sar-icon-btn {
                width: 30px;
                height: 30px;
                flex: 0 0 30px;
                background: #f3f4f6;
                color: #4b5563;
                font-size: 20px;
                line-height: 1;
            }
            .sar-icon-btn:hover,
            .sar-icon-btn:focus-visible {
                background: #e5e7eb;
                outline: 2px solid #93c5fd;
            }
            .sar-field {
                display: grid;
                gap: 7px;
                margin-bottom: 16px;
            }
            .sar-label,
            .sar-fieldset legend {
                color: #374151;
                font-size: 13px;
                font-weight: 650;
            }
            .sar-number-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .sar-number-wrap input {
                width: 100%;
                min-width: 0;
                height: 40px;
                padding: 0 11px;
                border: 1px solid #d1d5db;
                border-radius: 9px;
                background: #fff;
                color: #111827;
                font-variant-numeric: tabular-nums;
                outline: none;
            }
            .sar-number-wrap input:focus {
                border-color: #60a5fa;
                box-shadow: 0 0 0 3px rgba(96,165,250,.18);
            }
            .sar-number-wrap > span { color: #6b7280; }
            .sar-fieldset {
                display: grid;
                gap: 8px;
                margin: 0 0 16px;
                padding: 0;
                border: 0;
            }
            .sar-fieldset legend { margin-bottom: 8px; }
            .sar-radio-card {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                padding: 10px 11px;
                border: 1px solid #e5e7eb;
                border-radius: 10px;
                cursor: pointer;
            }
            .sar-radio-card:has(input:checked) {
                border-color: #60a5fa;
                background: #eff6ff;
            }
            .sar-radio-card input { margin-top: 3px; }
            .sar-radio-card span { display: grid; gap: 2px; }
            .sar-radio-card strong { color: #1f2937; font-size: 13px; }
            .sar-radio-card small { color: #6b7280; font-size: 11px; }
            .sar-inline-card,
            .sar-action-confirm {
                margin-bottom: 14px;
                padding: 11px;
                border: 1px solid #fde68a;
                border-radius: 10px;
                background: #fffbeb;
                color: #78350f;
                font-size: 12px;
            }
            .sar-inline-card p,
            .sar-action-confirm p { margin: 5px 0 8px; }
            .sar-inline-card label { display: block; margin-top: 6px; }
            .sar-message {
                margin-bottom: 12px;
                padding: 9px 10px;
                border-radius: 9px;
                background: #fef2f2;
                color: #b91c1c;
                font-size: 12px;
            }
            .sar-message[data-kind="warning"] { background: #fffbeb; color: #92400e; }
            .sar-message[data-kind="success"] { background: #ecfdf5; color: #047857; }
            .sar-primary-btn,
            .sar-secondary-btn,
            .sar-danger-btn {
                min-height: 38px;
                padding: 0 12px;
                font-weight: 650;
            }
            .sar-primary-btn {
                width: 100%;
                background: #2563eb;
                color: #fff;
            }
            .sar-primary-btn:hover,
            .sar-primary-btn:focus-visible { background: #1d4ed8; outline: 2px solid #93c5fd; outline-offset: 2px; }
            .sar-primary-btn:disabled { cursor: default; opacity: .6; }
            .sar-manage-actions {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 8px;
                margin-top: 14px;
                padding-top: 14px;
                border-top: 1px solid #e5e7eb;
            }
            .sar-manage-actions:empty { display: none; }
            .sar-secondary-btn { background: #f3f4f6; color: #374151; }
            .sar-secondary-btn:hover,
            .sar-secondary-btn:focus-visible { background: #e5e7eb; outline: 2px solid #bfdbfe; }
            .sar-danger-btn { background: #fef2f2; color: #b91c1c; }
            .sar-danger-btn:hover,
            .sar-danger-btn:focus-visible { background: #fee2e2; outline: 2px solid #fecaca; }
            .sar-action-confirm { margin-top: 12px; margin-bottom: 0; border-color: #fecaca; background: #fef2f2; color: #7f1d1d; }
            .sar-confirm-actions { display: flex; gap: 8px; }

            @keyframes sarIn { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
            @keyframes sarDialogIn { from { opacity: 0; transform: translateY(5px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @media (max-width: 600px) {
                .sar-dialog-backdrop { align-items: flex-end; padding: 12px; }
                .sar-dialog { width: 100%; max-height: calc(100vh - 24px); border-radius: 16px; }
                .sar-manage-actions { grid-template-columns: 1fr; }
            }
            @media (prefers-reduced-motion: reduce) {
                .sar-expanded, .sar-dialog { animation: none; }
            }
        `;

        const mount = document.createElement('div');
        mount.id = 'sarMount';
        uiRoot.appendChild(style);
        uiRoot.appendChild(mount);
        (document.body || document.documentElement).appendChild(uiHost);
        return uiRoot;
    }

    function clearCollapseTimer() {
        if (collapseTimer !== null) {
            clearTimeout(collapseTimer);
            collapseTimer = null;
        }
    }

    function isPanelFocused() {
        const activeElement = uiRoot?.activeElement || document.activeElement;
        return Boolean(panelEl && activeElement && panelEl.contains(activeElement));
    }

    function setPanelMode(mode) {
        if (!panelEl) return;
        panelMode = mode === 'mini' ? 'mini' : 'expanded';
        panelEl.dataset.mode = panelMode;

        if (panelMode === 'expanded' && hasCustomPanelPosition && uiHost) {
            const rect = uiHost.getBoundingClientRect();
            setPanelPosition(uiHost, rect.left, rect.top);
        }
    }

    function scheduleCollapse() {
        clearCollapseTimer();
        if (!panelEl || settingsDialogOpen || isDragging) return;

        collapseTimer = setTimeout(() => {
            collapseTimer = null;
            if (settingsDialogOpen || isDragging || isPanelFocused() || panelEl.matches(':hover')) return;
            setPanelMode('mini');
        }, COLLAPSE_DELAY_MS);
    }

    async function createControlPanel() {
        const root = ensureUiSurface();
        const mount = root.querySelector('#sarMount');
        const scopeLabel = activeRule?.scope === 'site' ? '网站范围' : '精准网址';
        const initialPresentation = getPanelPresentation('expanded', false, intervalSeconds);

        mount.innerHTML = `
            <div class="sar-panel" id="sarControlPanel" data-mode="expanded">
                <button class="sar-mini" id="sarMiniButton" type="button" aria-label="${initialPresentation.label}">
                    <span id="sarMiniIcon">${initialPresentation.icon}</span>
                    <strong id="sarMiniTime">${initialPresentation.time}</strong>
                </button>
                <div class="sar-expanded" role="region" aria-label="自动刷新控制面板">
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
            </div>
        `;

        panelEl = root.querySelector('#sarControlPanel');
        countdownEl = root.querySelector('#countdown');
        pauseBtn = root.querySelector('#pauseBtn');
        miniButtonEl = root.querySelector('#sarMiniButton');
        miniIconEl = root.querySelector('#sarMiniIcon');
        miniTimeEl = root.querySelector('#sarMiniTime');
        const resetBtn = root.querySelector('#resetBtn');
        const setBtn = root.querySelector('#setBtn');
        const dragHandle = root.querySelector('#dragHandle');

        pauseBtn.addEventListener('click', togglePause);
        resetBtn.addEventListener('click', resetCountdown);
        setBtn.addEventListener('click', () => runSafely(openSettingsDialog));
        miniButtonEl.addEventListener('click', () => {
            setPanelMode('expanded');
            scheduleCollapse();
        });

        const savedPos = await loadPanelPos();
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            hasCustomPanelPosition = true;
            setPanelPosition(uiHost, savedPos.left, savedPos.top);
        }

        panelEl.addEventListener('mouseenter', () => {
            clearCollapseTimer();
            setPanelMode('expanded');
        }, true);
        panelEl.addEventListener('mouseleave', scheduleCollapse, true);
        panelEl.addEventListener('pointerdown', () => {
            clearCollapseTimer();
            setPanelMode('expanded');
        }, true);
        panelEl.addEventListener('focusin', () => {
            clearCollapseTimer();
            setPanelMode('expanded');
        }, true);
        panelEl.addEventListener('focusout', () => {
            setTimeout(() => {
                if (!isPanelFocused()) scheduleCollapse();
            }, 0);
        }, true);

        let startOffsetX = 0;
        let startOffsetY = 0;

        dragHandle.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch' && event.button !== 0) return;

            isDragging = true;
            hasCustomPanelPosition = true;
            clearCollapseTimer();
            setPanelMode('expanded');

            const rect = uiHost.getBoundingClientRect();
            startOffsetX = event.clientX - rect.left;
            startOffsetY = event.clientY - rect.top;
            setPanelPosition(uiHost, rect.left, rect.top);

            dragHandle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });

        window.addEventListener('pointermove', (event) => {
            if (!isDragging) return;
            setPanelPosition(uiHost, event.clientX - startOffsetX, event.clientY - startOffsetY);
        }, true);

        const finishDrag = (event) => {
            if (!isDragging) return;
            isDragging = false;
            dragHandle.releasePointerCapture?.(event.pointerId);
            void savePanelPosition(uiHost);
            scheduleCollapse();
        };

        window.addEventListener('pointerup', finishDrag, true);
        window.addEventListener('pointercancel', finishDrag, true);
        window.addEventListener('resize', () => {
            if (!hasCustomPanelPosition || !uiHost) return;
            const rect = uiHost.getBoundingClientRect();
            setPanelPosition(uiHost, rect.left, rect.top);
        });

        document.addEventListener('pointerdown', (event) => {
            if (!panelEl || settingsDialogOpen || panelMode !== 'expanded') return;
            const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
            const isInside = path.includes(uiHost) || uiHost.contains(event.target);
            if (!isInside) {
                clearCollapseTimer();
                setPanelMode('mini');
            }
        }, true);

        setPanelMode('expanded');
        scheduleCollapse();
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

    function applyRuleUpdate(config, { url, host, seconds, scope, removeExactOverride = false }) {
        delete config.disabled[url];

        if (scope === 'site') {
            config.site[host] = seconds;
            if (removeExactOverride) {
                delete config.exact[url];
            }
            return config;
        }

        config.exact[url] = seconds;
        return config;
    }

    function disableUrl(config, { url, host }) {
        const hasSiteRule = isValidInterval(config.site[host]);
        delete config.exact[url];

        if (hasSiteRule) {
            config.disabled[url] = true;
        } else {
            delete config.disabled[url];
        }

        return config;
    }

    function removeSiteRule(config, { host }) {
        delete config.site[host];
        return clearDisabledRulesForHost(config, host);
    }

    function getSettingsState(config, url, host) {
        const hasExactRule = isValidInterval(config?.exact?.[url]);
        const hasSiteRule = isValidInterval(config?.site?.[host]);
        const isDisabled = config?.disabled?.[url] === true && !hasExactRule;
        const effectiveRule = resolveRule(config, url, host);

        return {
            seconds: effectiveRule?.seconds
                || (hasExactRule ? config.exact[url] : null)
                || (hasSiteRule ? config.site[host] : null)
                || DEFAULT_INTERVAL,
            scope: effectiveRule?.scope || (hasExactRule ? 'exact' : (hasSiteRule && !isDisabled ? 'site' : 'exact')),
            effectiveScope: effectiveRule?.scope || null,
            hasExactRule,
            hasSiteRule,
            isDisabled
        };
    }

    function getPanelPresentation(mode, paused, remainingSeconds) {
        const time = formatTime(remainingSeconds);
        return {
            mode,
            icon: paused ? '⏸' : '⏱',
            time,
            label: paused
                ? `自动刷新已暂停，剩余 ${time}`
                : `自动刷新，剩余 ${time}`
        };
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
