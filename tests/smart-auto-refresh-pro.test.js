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
        applyRuleUpdate: typeof applyRuleUpdate === 'function' ? applyRuleUpdate : null,
        disableUrl: typeof disableUrl === 'function' ? disableUrl : null,
        removeSiteRule: typeof removeSiteRule === 'function' ? removeSiteRule : null,
        getSettingsState: typeof getSettingsState === 'function' ? getSettingsState : null,
        getPanelPresentation: typeof getPanelPresentation === 'function' ? getPanelPresentation : null,
        stepIntervalValue: typeof stepIntervalValue === 'function' ? stepIntervalValue : null,
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
        getMenuLabels() {
            return [...menuCommands.keys()];
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

test('userscript metadata is pinned to the canonical v1.3.2 project links', () => {
    assert.match(source, /^\/\/ @version\s+1\.3\.2$/m);
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

test('userscript exposes one unified management menu entry', () => {
    const runtime = createRuntime();
    assert.deepEqual(runtime.getMenuLabels(), ['⚙ 设置 / 管理自动刷新']);
});

test('site scope takes over the current page by default when an exact rule exists', () => {
    const { api } = createRuntime();
    const url = 'https://example.com/path';
    const config = {
        version: 2,
        site: { 'example.com': 60 },
        exact: { [url]: 10 },
        disabled: {}
    };

    api.applyRuleUpdate(config, {
        url,
        host: 'example.com',
        seconds: 30,
        scope: 'site'
    });

    assert.equal(config.site['example.com'], 30);
    assert.equal(config.exact[url], undefined);
    assert.deepEqual(plain(api.resolveRule(config, url, 'example.com')), {
        scope: 'site',
        key: 'example.com',
        seconds: 30
    });
});

test('interval stepper helper supports 1-second and 10-second steps with a minimum of one', () => {
    const { api } = createRuntime();
    assert.equal(typeof api.stepIntervalValue, 'function');
    assert.equal(api.stepIntervalValue(60, 1, 1), 61);
    assert.equal(api.stepIntervalValue(60, -1, 1), 59);
    assert.equal(api.stepIntervalValue(60, 1, 10), 70);
    assert.equal(api.stepIntervalValue(5, -1, 10), 1);
    assert.equal(api.stepIntervalValue(1, -1, 1), 1);
    assert.equal(api.stepIntervalValue('invalid', 1, 1), 2);
});

test('rule update helpers preserve site fallback and exact override semantics', () => {
    const { api } = createRuntime();
    assert.equal(typeof api.applyRuleUpdate, 'function');

    const url = 'https://example.com/path';
    const config = {
        version: 2,
        site: { 'example.com': 60 },
        exact: { [url]: 10 },
        disabled: { [url]: true }
    };

    api.applyRuleUpdate(config, {
        url,
        host: 'example.com',
        seconds: 30,
        scope: 'site',
        removeExactOverride: false
    });
    assert.equal(config.site['example.com'], 30);
    assert.equal(config.exact[url], 10);
    assert.equal(config.disabled[url], undefined);

    api.applyRuleUpdate(config, {
        url,
        host: 'example.com',
        seconds: 20,
        scope: 'site',
        removeExactOverride: true
    });
    assert.equal(config.site['example.com'], 20);
    assert.equal(config.exact[url], undefined);

    api.applyRuleUpdate(config, {
        url,
        host: 'example.com',
        seconds: 8,
        scope: 'exact',
        removeExactOverride: false
    });
    assert.equal(config.exact[url], 8);
});

test('disable and delete helpers keep site scope changes bounded', () => {
    const { api } = createRuntime();
    assert.equal(typeof api.disableUrl, 'function');
    assert.equal(typeof api.removeSiteRule, 'function');

    const url = 'https://example.com/path';
    const config = {
        version: 2,
        site: { 'example.com': 60, 'other.example': 90 },
        exact: { [url]: 10 },
        disabled: {
            'https://example.com/old': true,
            'https://other.example/a': true
        }
    };

    api.disableUrl(config, { url, host: 'example.com' });
    assert.equal(config.exact[url], undefined);
    assert.equal(config.disabled[url], true);
    assert.equal(config.site['example.com'], 60);

    const cleared = api.removeSiteRule(config, { host: 'example.com' });
    assert.equal(cleared, 2);
    assert.equal(config.site['example.com'], undefined);
    assert.equal(config.site['other.example'], 90);
    assert.equal(config.disabled['https://other.example/a'], true);
});

test('settings state describes exact, site, disabled and empty pages', () => {
    const { api } = createRuntime();
    assert.equal(typeof api.getSettingsState, 'function');
    const url = 'https://example.com/path';

    const config = {
        version: 2,
        site: { 'example.com': 60 },
        exact: { [url]: 10 },
        disabled: {}
    };
    assert.deepEqual(plain(api.getSettingsState(config, url, 'example.com')), {
        seconds: 10,
        scope: 'exact',
        effectiveScope: 'exact',
        hasExactRule: true,
        hasSiteRule: true,
        isDisabled: false
    });

    delete config.exact[url];
    assert.deepEqual(plain(api.getSettingsState(config, url, 'example.com')), {
        seconds: 60,
        scope: 'site',
        effectiveScope: 'site',
        hasExactRule: false,
        hasSiteRule: true,
        isDisabled: false
    });

    config.disabled[url] = true;
    assert.deepEqual(plain(api.getSettingsState(config, url, 'example.com')), {
        seconds: 60,
        scope: 'exact',
        effectiveScope: null,
        hasExactRule: false,
        hasSiteRule: true,
        isDisabled: true
    });
});

test('panel presentation exposes readable running and paused mini timer labels', () => {
    const { api } = createRuntime();
    assert.equal(typeof api.getPanelPresentation, 'function');
    assert.deepEqual(plain(api.getPanelPresentation('mini', false, 273)), {
        mode: 'mini',
        icon: '⏱',
        time: '00:04:33',
        label: '自动刷新，剩余 00:04:33'
    });
    assert.deepEqual(plain(api.getPanelPresentation('mini', true, 273)), {
        mode: 'mini',
        icon: '⏸',
        time: '00:04:33',
        label: '自动刷新已暂停，剩余 00:04:33'
    });
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
