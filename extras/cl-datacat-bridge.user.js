// ==UserScript==
// @name         Character Library - Datacat Export Companion
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      1.0.2
// @description  Export a selected Datacat character to Character Library after your click and Datacat's normal verification. No account credentials are shared.
// @author       Sillyanonymous
// @match        https://datacat.run/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

/*
 * Optional companion for Character Library's embedded Datacat export panel.
 * Runs only in an explicitly marked iframe. It uses Datacat's own public export
 * function, including its normal human verification and creator restrictions.
 * There are no direct network requests, account-token reads, or verification
 * shortcuts. The only result is the requested character card and its PNG.
 *
 * Install in a userscript manager with page-context support. Enable the script
 * on datacat.run and reload Character Library's export panel after installing.
 */
(function () {
    'use strict';

    const PROTOCOL = 'cl-datacat-export-v1';
    const MAX_BYTES = 32 * 1024 * 1024;
    const params = new URLSearchParams(location.search);
    const nonce = params.get('cl_datacat_nonce') || '';
    const parentOrigin = params.get('cl_datacat_parent') || '';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (location.origin !== 'https://datacat.run' || window.parent === window || params.get('cl_datacat_export') !== '1') return;
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(nonce)) return;
    try {
        const parent = new URL(parentOrigin);
        if (!['http:', 'https:'].includes(parent.protocol) || parent.origin !== parentOrigin) return;
    } catch { return; }

    let current = null;
    let box = null;
    let readyTimer = null;

    function validMetadata(metadata) {
        return metadata && typeof metadata === 'object'
            && UUID.test(metadata.characterId)
            && ['', 'janitor', 'saucepan', 'direct_upload'].includes(metadata.sourceKind)
            && ['source', 'reimagination'].includes(metadata.definitionSource)
            && !(metadata.sourceKind === 'direct_upload' && metadata.definitionSource === 'reimagination')
            && typeof metadata.variantId === 'string' && metadata.variantId.length <= 256
            && !/[\u0000-\u001f\u007f]/.test(metadata.variantId);
    }

    function sameRequest(data, request) {
        return data.requestId === request.requestId && ['characterId', 'sourceKind', 'definitionSource', 'variantId']
            .every(key => data.metadata?.[key] === request.metadata[key]);
    }

    function send(request, type, extra = {}, transfer = []) {
        if (request.cancelled) return;
        window.parent.postMessage({ protocol: PROTOCOL, type, nonce, requestId: request.requestId, metadata: request.metadata, ...extra }, parentOrigin, transfer);
    }

    function dismiss() {
        clearInterval(readyTimer);
        readyTimer = null;
        box?.remove();
        box = null;
    }

    function cancelFromUser() {
        if (!current) return;
        send(current, 'cancelled');
        current.cancelled = true;
        dismiss();
    }

    function ensureBox(request) {
        dismiss();
        box = document.createElement('section');
        box.id = 'cl-datacat-export-companion';
        box.setAttribute('aria-label', 'Character Library export');
        // Datacat's character modal is 15000 and download verification is 23000.
        // Show the consent dock above the character while keeping verification above it.
        box.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:22000;background:#171923;color:#f5f5f8;border:1px solid #999;border-radius:10px;padding:14px;box-shadow:0 5px 24px #0008;font:14px/1.45 system-ui,sans-serif;max-width:760px;margin:auto;';
        const title = document.createElement('strong');
        title.textContent = `Character Library — ${request.metadata.definitionSource === 'source' ? 'Source definition' : 'Reimagination (experimental)'}`;
        const detail = document.createElement('p');
        detail.style.margin = '6px 0';
        detail.textContent = `Send ${request.metadata.characterName || 'this character'} to ${new URL(parentOrigin).host}. Datacat may ask you to complete its normal verification.`;
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.style.margin = '6px 0';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Export to Character Library';
        button.style.cssText = 'padding:9px 14px;border-radius:7px;border:1px solid #aaa;background:#ddd4ff;color:#171222;font:inherit;cursor:pointer;margin-right:10px;';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'padding:9px 14px;border-radius:7px;border:1px solid #aaa;background:#282b38;color:white;font:inherit;cursor:pointer;';
        cancel.addEventListener('click', cancelFromUser);
        box.append(title, detail, status, button, cancel);
        document.body.append(box);

        function checkReady() {
            if (request.cancelled || request.busy) return;
            const api = window.DatacatCharacterExport;
            if (typeof api?.buildPngPayload !== 'function' || typeof api?.getCurrentModalContext !== 'function') {
                button.disabled = true;
                status.textContent = 'Waiting for Datacat’s character export tools. If this persists, reload the panel.';
                return;
            }
            let context;
            try { context = api.getCurrentModalContext(); } catch { context = null; }
            const matching = String(context?.characterId || '').toLowerCase() === request.metadata.characterId
                && (!request.metadata.sourceKind || context?.sourceKind === request.metadata.sourceKind);
            button.disabled = !matching;
            status.textContent = matching ? 'Ready. Your click authorizes this character export.' : 'Waiting for the requested character. Open its character details if they are not already visible.';
        }
        button.addEventListener('click', async event => {
            if (!event.isTrusted || request.busy || request.cancelled || current !== request) return;
            checkReady();
            if (button.disabled) return;
            request.busy = true;
            button.disabled = true;
            status.textContent = 'Preparing your card. Complete any verification shown by Datacat.';
            send(request, 'status', { message: status.textContent });
            // Hide the dock while Datacat controls the verification flow; the CL
            // parent retains its cancel button throughout the native operation.
            box.style.display = 'none';
            try {
                const metadata = request.metadata;
                const payload = await window.DatacatCharacterExport.buildPngPayload(
                    metadata.characterId, metadata.characterName, metadata.creatorName,
                    metadata.variantId, metadata.sourceKind || null,
                    { definitionSource: metadata.definitionSource },
                );
                if (request.cancelled || current !== request) return;
                const bytes = payload?.pngBytes;
                // Enforce the transfer limit before duplicating the native buffer;
                // otherwise a rejected export can still exhaust a mobile tab's memory.
                if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
                    || bytes.byteLength < 20 || bytes.byteLength > MAX_BYTES) {
                    throw new Error('Datacat returned an invalid PNG, or the card exceeds the 32 MB limit.');
                }
                const png = bytes instanceof ArrayBuffer ? bytes.slice(0)
                    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                if (!payload?.cardData?.data || JSON.stringify(payload.cardData).length > MAX_BYTES) throw new Error('Datacat returned an invalid character card.');
                send(request, 'card', { png, cardData: payload.cardData }, [png]);
                request.cancelled = true;
                dismiss();
            } catch (error) {
                if (request.cancelled || current !== request) return;
                // Datacat signals its native verification dialog's Cancel with
                // this message rather than an AbortError.
                if (error?.name === 'AbortError' || /download verification cancelled/i.test(String(error?.message || ''))) {
                    send(request, 'cancelled');
                } else if (error?.creatorRedirectHandled === true) {
                    send(request, 'error', {
                        code: 'creator_restricted',
                        message: 'This creator restricts downloads. Open the character on Datacat and follow its creator link.',
                    });
                } else {
                    send(request, 'error', { message: String(error?.message || 'Datacat could not export this character.').slice(0, 500) });
                }
                request.cancelled = true;
                dismiss();
            }
        });
        checkReady();
        readyTimer = setInterval(checkReady, 700);
    }

    window.addEventListener('message', event => {
        if (event.source !== window.parent || event.origin !== parentOrigin) return;
        const data = event.data;
        if (!data || data.protocol !== PROTOCOL || data.nonce !== nonce || !/^[a-zA-Z0-9._:-]{1,128}$/.test(data.requestId) || !validMetadata(data.metadata)) return;
        if (data.type === 'cancel') {
            if (current && sameRequest(data, current)) { current.cancelled = true; dismiss(); }
            return;
        }
        if (data.type !== 'init') return;
        if (current) {
            if (sameRequest(data, current) && !current.cancelled) send(current, 'ready');
            return;
        }
        current = {
            requestId: data.requestId, cancelled: false, busy: false,
            metadata: {
                characterId: data.metadata.characterId, sourceKind: data.metadata.sourceKind,
                definitionSource: data.metadata.definitionSource, variantId: data.metadata.variantId,
                characterName: String(data.metadata.characterName || '').slice(0, 256),
                creatorName: String(data.metadata.creatorName || '').slice(0, 256),
            },
        };
        ensureBox(current);
        send(current, 'ready');
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && current && !current.cancelled) {
            event.preventDefault();
            cancelFromUser();
        }
    });
})();
