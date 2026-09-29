import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
const preferences = source.slice(source.indexOf('function getDisplayMode('), source.indexOf('// Settings migrations'));
const start = source.indexOf("document.getElementById('charlib-display-mode').addEventListener('change'");
const handler = source.slice(start, source.indexOf("document.getElementById('charlib-clear-css').addEventListener", start));

function setup(saved = {}) {
    const settings = { displayMode: 'tab', ...saved };
    let change;
    const elements = {
        'charlib-display-mode': { addEventListener: (_event, callback) => { change = callback; } },
        'charlib-embedded-options': { style: {} },
        'charlib-show-topbar': { checked: saved.showTopBar ?? false },
        'charlib-exclusive-panes': { checked: saved.exclusivePanes ?? false },
    };
    const context = vm.createContext({
        CL_SETTINGS_KEY: 'SillyTavernCharacterGallery', EXTENSION_NAME: 'Character Library',
        SillyTavern: { getContext: () => ({ extensionSettings: { SillyTavernCharacterGallery: settings }, saveSettingsDebounced() {} }) },
        document: { getElementById: id => elements[id] || null }, console,
        isEmbeddedActive: () => false, _iframeContainer: null,
    });
    vm.runInContext(preferences + handler, context);
    return { elements, change };
}

test('launcher mode changes keep topbar and exclusive-panel controls aligned with current defaults', () => {
    const { elements, change } = setup();
    change({ target: { value: 'embedded' } });
    assert.equal(elements['charlib-show-topbar'].checked, true);
    assert.equal(elements['charlib-exclusive-panes'].checked, true);
    change({ target: { value: 'tab' } });
    assert.equal(elements['charlib-show-topbar'].checked, false);
    assert.equal(elements['charlib-exclusive-panes'].checked, false);
});

test('launcher mode changes preserve explicit topbar and exclusive-panel choices', () => {
    const { elements, change } = setup({ showTopBar: false, exclusivePanes: true });
    change({ target: { value: 'embedded' } });
    assert.equal(elements['charlib-show-topbar'].checked, false);
    assert.equal(elements['charlib-exclusive-panes'].checked, true);
});
