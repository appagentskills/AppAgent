// Phase 4 (fix-all/4-high) — P4_* kill-switch flags in core/030-config.js.
// Hydrated inside loadAssumedContextTokens() from the IDB settings store
// ('p4_<NAME>'); default OFF; saveP4Flag persists via setSetting.
describe('P4 flags (core/030-config.js)', function() {
    async function load(stored) {
        var setCalls = [];
        var m = await loadModules(['src/js/core/030-config.js'], {
            lenient: true,
            globals: {
                window: fakeWindow(),
                getSetting: async function(key, dflt) { return (key in stored) ? stored[key] : dflt; },
                setSetting: async function(key, value) { setCalls.push([key, value]); }
            }
        });
        m.__setCalls = setCalls;
        return m;
    }
    test('defaults: every P4 flag is OFF before hydration; unknown name is false', async function() {
        var m = await load({});
        assert.strictEqual(typeof m.getP4Flag, 'function');
        assert.deepStrictEqual(Object.keys(m.P4_FLAG_DEFAULTS).sort(), ['P4_ACTION_WATCHDOG', 'P4_BOOT_PLACEHOLDER_SWEEP', 'P4_OFFSCREEN_SELF_HEAL', 'P4_SUB_SATURATION_HARDSTOP']);
        Object.keys(m.P4_FLAG_DEFAULTS).forEach(function(k) {
            assert.strictEqual(m.P4_FLAG_DEFAULTS[k], false, k + ' default must be OFF');
            assert.strictEqual(m.getP4Flag(k), false, k + ' reads OFF before hydration');
        });
        assert.strictEqual(m.getP4Flag('P4_NOPE'), false);
        assert.strictEqual(m.getP4Flag(undefined), false);
    });
    test('loadAssumedContextTokens hydrates p4_<NAME>: one ON, the others stay OFF', async function() {
        var m = await load({ p4_P4_ACTION_WATCHDOG: true });
        await m.loadAssumedContextTokens();
        assert.strictEqual(m.getP4Flag('P4_ACTION_WATCHDOG'), true);
        assert.strictEqual(m.getP4Flag('P4_OFFSCREEN_SELF_HEAL'), false);
        assert.strictEqual(m.getP4Flag('P4_SUB_SATURATION_HARDSTOP'), false);
        assert.strictEqual(m.getP4Flag('P4_BOOT_PLACEHOLDER_SWEEP'), false);
        assert.strictEqual(m.getP4Flag('P4_NOPE'), false);
    });
    test('hydration coerces truthy/falsy stored values and re-applies defaults when the key is absent', async function() {
        var m = await load({ p4_P4_OFFSCREEN_SELF_HEAL: 1, p4_P4_BOOT_PLACEHOLDER_SWEEP: 0 });
        await m.loadAssumedContextTokens();
        assert.strictEqual(m.getP4Flag('P4_OFFSCREEN_SELF_HEAL'), true, '1 → true');
        assert.strictEqual(m.getP4Flag('P4_BOOT_PLACEHOLDER_SWEEP'), false, '0 → false');
        assert.strictEqual(m.getP4Flag('P4_ACTION_WATCHDOG'), false, 'absent → default');
    });
    test('saveP4Flag persists setSetting("p4_<NAME>", bool) and updates the live value; unknown names are ignored', async function() {
        var m = await load({});
        var r = await m.saveP4Flag('P4_SUB_SATURATION_HARDSTOP', 'yes');
        assert.strictEqual(r, true);
        assert.strictEqual(m.getP4Flag('P4_SUB_SATURATION_HARDSTOP'), true);
        assert.deepStrictEqual(m.__setCalls, [['p4_P4_SUB_SATURATION_HARDSTOP', true]]);
        await m.saveP4Flag('P4_SUB_SATURATION_HARDSTOP', 0);
        assert.strictEqual(m.getP4Flag('P4_SUB_SATURATION_HARDSTOP'), false);
        assert.deepStrictEqual(m.__setCalls[1], ['p4_P4_SUB_SATURATION_HARDSTOP', false]);
        var bad = await m.saveP4Flag('P4_NOPE', true);
        assert.strictEqual(bad, false);
        assert.strictEqual(m.__setCalls.length, 2, 'unknown flag must not hit setSetting');
        assert.strictEqual(m.getP4Flag('P4_NOPE'), false);
    });
    test('self.getP4Flag is exported for background.js (loaded before the bundle)', async function() {
        var m = await load({});
        assert.strictEqual(m.__scope.window.getP4Flag, m.getP4Flag);
    });
});
