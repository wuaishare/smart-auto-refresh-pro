'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'smart-auto-refresh-pro.user.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
const closeMarker = '\n})();';
const closeIndex = source.lastIndexOf(closeMarker);

if (closeIndex === -1) {
    throw new Error('Unable to instrument userscript: closing IIFE marker not found.');
}

const injection = `
    globalThis.__SAR_TEST_API__ = {
        createEmptyConfig,
        normalizeConfig,
        migrateLegacyConfig,
        resolveRule,
        clearDisabledRulesForHost,
        parseIntervalInput,
        isValidInterval,
        formatTime,
        startCountdown,
        tick,
        togglePause,
        resetCountdown,
        loadConfig,
        getTimerState: () => ({
            intervalSeconds,
            isPaused,
            deadlineMs,
            pausedRemainingMs
        })
    };
`;

const instrumentedSource = source.slice(0, closeIndex) + injection + source.slice(closeIndex);

function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createRuntime(options = {}) {
    const storage = { ...(options.storage || {}) };
    const href = options.href || 'https://example.com/path?x=1';
    let now = options.now || 0;
    let reloadCount = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const menuCommands = new Map();
    const alerts = [];
    const promptResponses = [...(options.promptResponses || [])];
    const confirmResponses = [...(options.confirmResponses || [])];

    class FakeDate extends Date {
        static now() {
            return now;
        }
    }

    const context = {
        console,
        URL,
        Date: FakeDate,
        document: {
            title: 'Example page'
        },
        location: {
            href,
            hostname: new URL(href).hostname,
            reload() {
                reloadCount++;
            }
        },
        window: {
            innerWidth: 1280,
            innerHeight: 720,
            addEventListener() {}
        },
        GM_registerMenuCommand(label, callback) {
            menuCommands.set(label, callback);
        },
        async GM_getValue(key, fallback) {
            return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback;
        },
        async GM_setValue(key, value) {
            storage[key] = value;
        },
        alert(message) {
            alerts.push(String(message));
        },
        prompt() {
            return promptResponses.length > 0 ? promptResponses.shift() : null;
        },
        confirm() {
            return confirmResponses.length > 0 ? confirmResponses.shift() : true;
        },
        setTimeout(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay, cancelled: false });
            return id;
        },
        clearTimeout(id) {
            const timer = timers.get(id);
            if (timer) timer.cancelled = true;
        }
    };

    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(instrumentedSource, context, { filename: SCRIPT_PATH });

    function runNextTimer() {
        for (const [id, timer] of timers) {
            timers.delete(id);
            if (!timer.cancelled) {
                timer.callback();
                return timer.delay;
            }
        }
        return null;
    }

    return {
        api: context.__SAR_TEST_API__,
        storage,
        alerts,
        async invokeMenu(label) {
            const callback = menuCommands.get(label);
            assert.ok(callback, `Menu command not registered: ${label}`);
            return callback();
        },
        setNow(value) {
            now = value;
        },
        runNextTimer,
        getReloadCount() {
            return reloadCount;
        }
    };
}

test('userscript metadata is pinned to the canonical v1.3 project links', () => {
    assert.match(source, /^\/\/ @version\s+1\.3$/m);
    assert.match(source, /^\/\/ @homepageURL\s+https:\/\/github\.com\/wuaishare\/smart-auto-refresh-pro$/m);
    assert.match(source, /^\/\/ @supportURL\s+https:\/\/github\.com\/wuaishare\/smart-auto-refresh-pro\/issues$/m);
    assert.doesNotMatch(source, /^\/\/ @(downloadURL|updateURL)\s+/m);
    assert.doesNotMatch(source, /582415|update\.greasyfork\.org/);
});

test('legacy v1/v1.2 URL map migrates into v2 exact and site rules', () => {
    const { api } = createRuntime();
    const migrated = plain(api.migrateLegacyConfig({
        'https://example.com/a?x=1': 30,
        'example.com': '15',
        'invalid.example': 0,
        'fraction.example': 1.5
    }));

    assert.deepEqual(migrated, {
        version: 2,
        site: {
            'example.com': 15
        },
        exact: {
            'https://example.com/a?x=1': 30
        },
        disabled: {}
    });
});

test('loadConfig persists migrated v2 data without deleting legacy storage', async () => {
    const legacy = JSON.stringify({
        'https://example.com/a': 12,
        'example.com': 20
    });
    const runtime = createRuntime({
        href: 'https://unmatched.test/',
        storage: {
            urlRefreshMap: legacy
        }
    });

    const config = plain(await runtime.api.loadConfig());

    assert.equal(runtime.storage.urlRefreshMap, legacy);
    assert.deepEqual(config.exact, { 'https://example.com/a': 12 });
    assert.deepEqual(config.site, { 'example.com': 20 });

    const persisted = JSON.parse(runtime.storage.autoRefreshConfig_v2);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.exact['https://example.com/a'], 12);
    assert.equal(persisted.site['example.com'], 20);
});

test('exact URL rule wins over site rule; page exclusion wins over site fallback', () => {
    const { api } = createRuntime();
    const url = 'https://example.com/path?x=1';
    const config = {
        version: 2,
        site: { 'example.com': 60 },
        exact: { [url]: 10 },
        disabled: {}
    };

    assert.deepEqual(plain(api.resolveRule(config, url, 'example.com')), {
        scope: 'exact',
        key: url,
        seconds: 10
    });

    delete config.exact[url];
    config.disabled[url] = true;
    assert.equal(api.resolveRule(config, url, 'example.com'), null);

    delete config.disabled[url];
    assert.deepEqual(plain(api.resolveRule(config, url, 'example.com')), {
        scope: 'site',
        key: 'example.com',
        seconds: 60
    });
});

test('removing a site rule can clear only exclusions belonging to that host', () => {
    const { api } = createRuntime();
    const config = {
        version: 2,
        site: {},
        exact: {},
        disabled: {
            'https://example.com/a': true,
            'https://example.com/b?x=1': true,
            'https://other.example/a': true,
            'not-a-url': true
        }
    };

    const cleared = api.clearDisabledRulesForHost(config, 'example.com');

    assert.equal(cleared, 2);
    assert.deepEqual(plain(config.disabled), {
        'https://other.example/a': true,
        'not-a-url': true
    });
});

test('interval parsing accepts decimal integers and rejects loose numeric formats', () => {
    const { api } = createRuntime();

    assert.equal(api.parseIntervalInput('1'), 1);
    assert.equal(api.parseIntervalInput(' 60 '), 60);
    assert.equal(api.parseIntervalInput('001'), 1);
    assert.equal(api.parseIntervalInput('0'), null);
    assert.equal(api.parseIntervalInput('1.5'), null);
    assert.equal(api.parseIntervalInput('5.0'), null);
    assert.equal(api.parseIntervalInput('1e2'), null);
    assert.equal(api.parseIntervalInput('5abc'), null);
    assert.equal(api.parseIntervalInput(''), null);

    assert.equal(api.isValidInterval(1), true);
    assert.equal(api.isValidInterval(5), true);
    assert.equal(api.isValidInterval(0), false);
    assert.equal(api.isValidInterval(1.5), false);
    assert.equal(api.isValidInterval('5'), false);
});

test('menu setting can create a site-wide rule and reload once', async () => {
    const runtime = createRuntime({
        href: 'https://example.com/path',
        promptResponses: ['30', '1']
    });

    await runtime.invokeMenu('🛠 设置当前页面刷新间隔');

    const persisted = JSON.parse(runtime.storage.autoRefreshConfig_v2);
    assert.deepEqual(persisted.site, { 'example.com': 30 });
    assert.deepEqual(persisted.exact, {});
    assert.deepEqual(persisted.disabled, {});
    assert.equal(runtime.getReloadCount(), 1);
});

test('menu setting can create an exact rule without deleting the site fallback', async () => {
    const runtime = createRuntime({
        href: 'https://example.com/path',
        promptResponses: ['10', '2']
    });
    runtime.storage.autoRefreshConfig_v2 = JSON.stringify({
        version: 2,
        site: { 'example.com': 60 },
        exact: {},
        disabled: {}
    });

    await runtime.invokeMenu('🛠 设置当前页面刷新间隔');

    const persisted = JSON.parse(runtime.storage.autoRefreshConfig_v2);
    assert.equal(persisted.site['example.com'], 60);
    assert.equal(persisted.exact['https://example.com/path'], 10);
    assert.equal(runtime.getReloadCount(), 1);
});

test('closing the current page preserves the site rule and adds an exact exclusion', async () => {
    const runtime = createRuntime({
        href: 'https://example.com/path'
    });
    runtime.storage.autoRefreshConfig_v2 = JSON.stringify({
        version: 2,
        site: { 'example.com': 60 },
        exact: { 'https://example.com/path': 10 },
        disabled: {}
    });

    await runtime.invokeMenu('❌ 关闭当前页面自动刷新');

    const persisted = JSON.parse(runtime.storage.autoRefreshConfig_v2);
    assert.equal(persisted.site['example.com'], 60);
    assert.equal(persisted.exact['https://example.com/path'], undefined);
    assert.equal(persisted.disabled['https://example.com/path'], true);
    assert.equal(runtime.getReloadCount(), 1);
});

test('one-second countdown does not reload immediately and reloads at deadline', () => {
    const runtime = createRuntime({ now: 0 });

    runtime.api.startCountdown(1);
    assert.equal(runtime.getReloadCount(), 0);

    const initialDelay = runtime.runNextTimer();
    assert.equal(initialDelay, 0);
    assert.equal(runtime.getReloadCount(), 0);
    assert.equal(runtime.api.getTimerState().deadlineMs, 1000);

    runtime.setNow(999);
    runtime.api.tick();
    assert.equal(runtime.getReloadCount(), 0);

    runtime.setNow(1000);
    runtime.api.tick();
    assert.equal(runtime.getReloadCount(), 1);
});

test('pause freezes remaining time and resume creates a fresh absolute deadline', () => {
    const runtime = createRuntime({ now: 0 });

    runtime.api.startCountdown(5);
    runtime.runNextTimer();

    runtime.setNow(2000);
    runtime.api.togglePause();
    let state = runtime.api.getTimerState();
    assert.equal(state.isPaused, true);
    assert.equal(state.pausedRemainingMs, 3000);

    runtime.setNow(10000);
    runtime.api.togglePause();
    state = runtime.api.getTimerState();
    assert.equal(state.isPaused, false);
    assert.equal(state.deadlineMs, 13000);

    runtime.setNow(12999);
    runtime.api.tick();
    assert.equal(runtime.getReloadCount(), 0);

    runtime.setNow(13000);
    runtime.api.tick();
    assert.equal(runtime.getReloadCount(), 1);
});

test('formatTime remains stable for hours and invalid negative input', () => {
    const { api } = createRuntime();

    assert.equal(api.formatTime(3661), '01:01:01');
    assert.equal(api.formatTime(0), '00:00:00');
    assert.equal(api.formatTime(-10), '00:00:00');
});
