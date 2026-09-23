// Interactive Datacat export. Verification and account credentials stay on Datacat.
// The optional companion script only exports after a visible click in the frame.

export const DATACAT_EXPORT_ORIGIN = 'https://datacat.run';
export const DATACAT_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const DATACAT_EXPORT_PROTOCOL = 'cl-datacat-export-v1';
const PANEL_ID = 'datacatExportPanel';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[a-zA-Z0-9-]{16,128}$/;
const REQUEST_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
let panel = null;
let activeRequest = null;

function bridgeError(code, message) {
    return Object.assign(new Error(message), { code });
}

export function normalizeDatacatExportRequest(options = {}) {
    const characterId = String(options.characterId || '').trim().toLowerCase();
    if (!UUID.test(characterId)) throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'A valid Datacat character ID is required.');
    const sourceKind = String(options.sourceKind || '').trim().toLowerCase();
    if (!['', 'janitor', 'saucepan', 'direct_upload'].includes(sourceKind)) {
        throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'The Datacat character source is invalid.');
    }
    const definitionSource = options.definitionSource === undefined ? 'source' : options.definitionSource;
    if (!['source', 'reimagination'].includes(definitionSource)) {
        throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'Choose Source or Reimagination for this export.');
    }
    if (sourceKind === 'direct_upload' && definitionSource === 'reimagination') {
        throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'Datacat uploads use their source definition.');
    }
    const variantId = String(options.variantId || '').trim();
    if (variantId.length > 256 || /[\u0000-\u001f\u007f]/.test(variantId)) {
        throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'The Datacat content variant is invalid.');
    }
    return {
        characterId, sourceKind, definitionSource, variantId,
        characterName: String(options.characterName || '').trim().slice(0, 256),
        creatorName: String(options.creatorName || '').trim().slice(0, 256),
    };
}

export function buildDatacatExportUrl(request, nonce, parentOrigin) {
    if (!NONCE.test(nonce)) throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'Invalid export nonce.');
    const parent = new URL(parentOrigin);
    if (!['https:', 'http:'].includes(parent.protocol) || parent.origin !== parentOrigin) {
        throw bridgeError('DATACAT_BRIDGE_INVALID_REQUEST', 'Character Library must run on an HTTP or HTTPS origin.');
    }
    const source = { janitor: 'janitor', saucepan: 'sauce', direct_upload: 'direct' }[request.sourceKind];
    const url = new URL(`/characters/recent/${source ? `${source}/` : ''}${request.characterId}`, DATACAT_EXPORT_ORIGIN);
    url.searchParams.set('cl_datacat_export', '1');
    url.searchParams.set('cl_datacat_nonce', nonce);
    url.searchParams.set('cl_datacat_parent', parentOrigin);
    return url.href;
}

/** Messages from another window/request are ignored, never allowed to settle a request. */
export function isDatacatExportMessage(event, expected) {
    const data = event?.data;
    if (event?.origin !== DATACAT_EXPORT_ORIGIN || event?.source !== expected.frameWindow || !data || typeof data !== 'object') return false;
    if (data.protocol !== DATACAT_EXPORT_PROTOCOL || data.nonce !== expected.nonce || !NONCE.test(data.nonce)) return false;
    if (data.requestId !== expected.requestId || !REQUEST_ID.test(data.requestId)) return false;
    const metadata = data.metadata;
    return !!metadata && ['characterId', 'sourceKind', 'definitionSource', 'variantId'].every(key => metadata[key] === expected.request[key]);
}

export function validateDatacatExportPng(value) {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 20 || value.byteLength > DATACAT_EXPORT_MAX_BYTES) {
        throw bridgeError('DATACAT_BRIDGE_INVALID_PNG', 'Datacat returned an invalid PNG, or the card exceeds the 32 MB limit.');
    }
    const bytes = new Uint8Array(value);
    if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) throw bridgeError('DATACAT_BRIDGE_INVALID_PNG', 'Datacat did not return a PNG card.');
    // Validate chunk bounds before handing untrusted binary data to the shared decoder.
    const view = new DataView(value);
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset, false);
        if (length > bytes.length - offset - 12) throw bridgeError('DATACAT_BRIDGE_INVALID_PNG', 'The Datacat PNG is truncated.');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (offset === 8 && (type !== 'IHDR' || length !== 13 || !view.getUint32(16, false) || !view.getUint32(20, false))) {
            throw bridgeError('DATACAT_BRIDGE_INVALID_PNG', 'The Datacat PNG has no valid image header.');
        }
        offset += length + 12;
        if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended) throw bridgeError('DATACAT_BRIDGE_INVALID_PNG', 'The Datacat PNG is incomplete.');
    return value;
}

function abortError(panelClosed = false) {
    return Object.assign(new DOMException('Datacat export cancelled.', 'AbortError'), { codeName: 'DATACAT_BRIDGE_CANCELLED', panelClosed });
}

function removePanel() {
    panel?.root.remove();
    panel = null;
}

export function closeDatacatExportPanel() {
    activeRequest?.cancel(true);
    removePanel();
}

function ensurePanel() {
    if (panel?.root.isConnected) return panel;
    if (!document.getElementById('datacatExportStyles')) {
        const style = document.createElement('style');
        style.id = 'datacatExportStyles';
        style.textContent = `
            #${PANEL_ID}{z-index:100100;padding:12px;background:#000b;position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
            #${PANEL_ID} .dc-export-content{width:min(1200px,100%);height:min(900px,94dvh);background:var(--bg-primary,#17191f);color:var(--text-primary,#eee);border:1px solid var(--border-color,#555);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
            #${PANEL_ID} .dc-export-header,#${PANEL_ID} .dc-export-footer{display:flex;gap:12px;align-items:center;padding:10px 14px;flex-shrink:0;flex-wrap:wrap}
            #${PANEL_ID} .dc-export-title{margin:0;flex:1;font-size:1.1rem}
            #${PANEL_ID} .dc-export-status{margin:0;flex:1;min-width:180px;font-size:.9rem}
            #${PANEL_ID} iframe{width:100%;flex:1;min-height:0;border:0;background:#111}
            #${PANEL_ID} .dc-export-help{padding:0 14px 10px;margin:0;font-size:.85rem}
            #${PANEL_ID} .dc-export-help a{color:var(--accent,#b7a7ff)}
            @media(max-width:600px){#${PANEL_ID}{padding:0}#${PANEL_ID} .dc-export-content{height:100dvh;border-radius:0}}
        `;
        document.head.append(style);
    }
    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = 'cl-modal visible';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'datacatExportTitle');
    root.innerHTML = `<div class="dc-export-content">
        <div class="dc-export-header"><h3 id="datacatExportTitle" class="dc-export-title">Export from Datacat</h3><button type="button" class="glass-btn dc-export-close" aria-label="Cancel and close Datacat export">Close</button></div>
        <p class="dc-export-help">Use the Character Library export button inside Datacat. Complete any verification there. <a class="dc-export-install" target="_blank" rel="noopener noreferrer">Install companion userscript</a>, then reload this panel. If the page is blocked, <a class="dc-export-open" target="_blank" rel="noopener noreferrer">open Datacat in a new tab</a>, finish its site checks, then reload.</p>
        <iframe title="Datacat character export" referrerpolicy="no-referrer" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
        <div class="dc-export-footer"><p class="dc-export-status" role="status" aria-live="polite"></p><button type="button" class="glass-btn dc-export-reload">Reload</button><button type="button" class="glass-btn dc-export-cancel">Cancel character</button></div>
    </div>`;
    root.querySelector('.dc-export-install').href = new URL('../../../extras/cl-datacat-bridge.user.js', import.meta.url).href;
    root.querySelector('.dc-export-close').addEventListener('click', closeDatacatExportPanel);
    root.querySelector('.dc-export-cancel').addEventListener('click', () => activeRequest?.cancel(false));
    root.querySelector('.dc-export-reload').addEventListener('click', () => activeRequest?.reload());
    document.body.append(root);
    panel = { root, frame: root.querySelector('iframe'), status: root.querySelector('.dc-export-status'), title: root.querySelector('h3') };
    window.registerOverlay?.({ id: PANEL_ID, tier: 1, close: closeDatacatExportPanel, visible: el => el.classList.contains('visible') });
    // This dynamically inserted panel is already visible when the mobile observer sees it.
    window.pushOverlayGuard?.();
    root.querySelector('.dc-export-close').focus();
    return panel;
}

/** One interactive request at a time; bulk callers may reuse the panel serially. */
export async function requestDatacatBrowserExport(options) {
    const request = normalizeDatacatExportRequest(options);
    if (options.signal?.aborted) throw abortError();
    if (activeRequest) throw bridgeError('DATACAT_BRIDGE_BUSY', 'Another Datacat export is already open.');
    const nonce = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const url = buildDatacatExportUrl(request, nonce, window.location.origin);
    const currentPanel = ensurePanel();
    const browserUrl = new URL(url);
    browserUrl.search = '';
    currentPanel.root.querySelector('.dc-export-open').href = browserUrl.href;
    currentPanel.title.textContent = `${request.characterName || 'Character'} — ${request.definitionSource === 'source' ? 'Source' : 'Reimagination'}`;
    return new Promise((resolve, reject) => {
        let settled = false;
        let ready = false;
        let decoding = false;
        let heartbeat;
        let diagnostic;
        let timeout;
        const expected = { nonce, requestId, request, frameWindow: currentPanel.frame.contentWindow };
        const report = message => {
            currentPanel.status.textContent = message;
            try { options.onStatus?.(message); } catch { /* UI callback must not break cleanup. */ }
        };
        const post = type => currentPanel.frame.contentWindow?.postMessage({
            protocol: DATACAT_EXPORT_PROTOCOL, type, nonce, requestId, metadata: request,
        }, DATACAT_EXPORT_ORIGIN);
        const finish = (error, result, panelClosed = false) => {
            if (settled) return;
            settled = true;
            post('cancel');
            clearInterval(heartbeat);
            clearTimeout(diagnostic);
            clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            currentPanel.frame.removeEventListener('load', onLoad);
            options.signal?.removeEventListener('abort', onAbort);
            activeRequest = null;
            if (!options.reusePanel || panelClosed) removePanel();
            else report(error ? error.message : 'Export received. Preparing the next character…');
            if (error) reject(error); else resolve(result);
        };
        const onAbort = () => finish(abortError(), null);
        const onLoad = () => {
            ready = false;
            expected.frameWindow = currentPanel.frame.contentWindow;
            post('init');
        };
        const onMessage = async event => {
            if (settled || !isDatacatExportMessage(event, expected)) return;
            const data = event.data;
            if (data.type === 'ready') {
                ready = true;
                clearTimeout(diagnostic);
                report('Ready. Click “Export to Character Library” inside Datacat to continue.');
            } else if (data.type === 'status') {
                report(String(data.message || 'Datacat is preparing your export.').slice(0, 500));
            } else if (data.type === 'cancelled') {
                finish(abortError(), null);
            } else if (data.type === 'error') {
                finish(bridgeError('DATACAT_BRIDGE_EXPORT_FAILED', String(data.message || 'Datacat could not export this card.').slice(0, 500)));
            } else if (data.type === 'card' && !decoding) {
                decoding = true;
                try {
                    const imageBuffer = validateDatacatExportPng(data.png);
                    const { default: CoreAPI } = await import('../../core-api.js');
                    const card = CoreAPI.extractCharacterDataFromPng(imageBuffer);
                    if (!card?.data || typeof card.data !== 'object' || Array.isArray(card.data)) {
                        throw bridgeError('DATACAT_BRIDGE_INVALID_CARD', 'The Datacat PNG contains no readable character card.');
                    }
                    // Use the PNG's canonical card rather than trusting a separate JSON envelope.
                    finish(null, { card, imageBuffer, definitionSource: request.definitionSource });
                } catch (error) { finish(error); }
            }
        };
        activeRequest = {
            cancel: panelClosed => finish(abortError(panelClosed), null, panelClosed),
            reload: () => {
                if (decoding || settled) return;
                ready = false;
                report('Reloading Datacat. Waiting for the companion userscript…');
                currentPanel.frame.src = url;
            },
        };
        window.addEventListener('message', onMessage);
        currentPanel.frame.addEventListener('load', onLoad);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        heartbeat = setInterval(() => { if (!ready) post('init'); }, 1500);
        diagnostic = setTimeout(() => {
            if (!ready) report('Companion not detected. Install extras/cl-datacat-bridge.user.js and allow it on Datacat. If the frame is blocked, open Datacat using the link above and complete its site checks, then click Reload.');
        }, 15000);
        timeout = setTimeout(() => finish(bridgeError('DATACAT_BRIDGE_TIMEOUT', 'Datacat export timed out. Reopen the export to try again.')), 10 * 60 * 1000);
        report('Opening Datacat. Waiting for the companion userscript…');
        currentPanel.frame.src = url;
    });
}
