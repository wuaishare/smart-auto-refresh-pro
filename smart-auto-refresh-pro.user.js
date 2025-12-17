// ==UserScript==
// @name         自动刷新页面（高级增强版）
// @namespace    https://www.wuaishare.cn/
// @version      1.1
// @description  自动刷新页面，支持油猴菜单设置刷新时间，带右下角倒计时与控制按钮，支持暂停、重置。让网页自动定时刷新，解放双手！可自行设置刷新时间。
// @author       逸轩
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const MIN_INTERVAL = 5;
    const key = 'urlRefreshMap';
    const currentUrl = location.href;

    let timeLeft = 0;
    let interval = 0;
    let isPaused = false;
    const originalTitle = document.title;

    (async function init() {
        const config = await loadConfig();
        if (config[currentUrl] && config[currentUrl] >= MIN_INTERVAL) {
            interval = config[currentUrl];
            timeLeft = interval;
            createControlPanel();
            countdown();
        }
    })();

    GM_registerMenuCommand('🛠 设置当前页面刷新间隔', async () => {
        const config = await loadConfig();
        let input = prompt(`请输入刷新间隔时间（单位：秒，≥${MIN_INTERVAL}）：`, config[currentUrl] || 60);
        let val = parseInt(input);
        if (!isNaN(val) && val >= MIN_INTERVAL) {
            config[currentUrl] = val;
            await GM_setValue(key, JSON.stringify(config));
            alert(`✅ 当前页面设置为每 ${val} 秒刷新一次，刷新页面后生效`);
        } else {
            alert('❌ 无效输入，刷新时间必须为数字且 ≥ ' + MIN_INTERVAL);
        }
    });

    GM_registerMenuCommand('❌ 关闭当前页面自动刷新', async () => {
        const config = await loadConfig();
        if (config[currentUrl]) {
            delete config[currentUrl];
            await GM_setValue(key, JSON.stringify(config));
            alert('✅ 已关闭当前页面刷新，刷新页面后停止生效');
        } else {
            alert('ℹ️ 当前页面未设置刷新');
        }
    });

    function countdown() {
        if (!isPaused) {
            document.title = `[${formatTime(timeLeft)}] ${originalTitle}`;
            timeLeft--;
        } else {
            document.title = `[已暂停] ${originalTitle}`;
        }

        if (timeLeft <= 0 && !isPaused) {
            location.reload();
        } else {
            setTimeout(countdown, 1000);
        }
    }

    function createControlPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: rgba(0,0,0,0.75);
            color: white;
            font-size: 14px;
            padding: 10px;
            border-radius: 8px;
            z-index: 99999;
            font-family: sans-serif;
            line-height: 1.8;
        `;
        panel.innerHTML = `
            ⏱️ 剩余：<span id="countdown">${formatTime(timeLeft)}</span><br/>
            <button id="pauseBtn">⏸ 暂停</button>
            <button id="resetBtn">🔁 重置</button>
            <button id="setBtn">⚙ 设置</button>
        `;
        document.body.appendChild(panel);

        const countdownEl = panel.querySelector('#countdown');
        const pauseBtn = panel.querySelector('#pauseBtn');
        const resetBtn = panel.querySelector('#resetBtn');
        const setBtn = panel.querySelector('#setBtn');

        setInterval(() => {
            countdownEl.textContent = formatTime(timeLeft);
            pauseBtn.textContent = isPaused ? '▶️ 继续' : '⏸ 暂停';
        }, 1000);

        pauseBtn.onclick = () => { isPaused = !isPaused; };
        resetBtn.onclick = () => { timeLeft = interval; };

        setBtn.onclick = async () => {
            const config = await loadConfig();
            let input = prompt(`设置新的刷新时间（单位：秒，≥${MIN_INTERVAL}）：`, interval);
            let val = parseInt(input);
            if (!isNaN(val) && val >= MIN_INTERVAL) {
                config[currentUrl] = val;
                await GM_setValue(key, JSON.stringify(config));
                interval = val;
                timeLeft = interval;
                alert(`✅ 当前页面刷新间隔已更新为 ${val} 秒`);
            } else {
                alert('❌ 输入无效，必须为数字且不小于 ' + MIN_INTERVAL);
            }
        };
    }

    async function loadConfig() {
        const raw = await GM_getValue(key, '{}');
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    function formatTime(t) {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = t % 60;
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }

    function pad(n) {
        return String(n).padStart(2, '0');
    }

})();