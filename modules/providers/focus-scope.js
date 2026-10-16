// Opt-in modal focus ownership. The top scope owns inertness; nested scopes
// restore the previous scope, including inert values set before either opened.
const scopes = [];
const savedInert = new Map();
const selector = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])';

function reconcile() {
    for (const [element, value] of savedInert) element.inert = value;
    savedInert.clear();
    const root = scopes.at(-1)?.root;
    if (!root?.isConnected) return;
    const set = (element, value) => {
        if (!savedInert.has(element)) savedInert.set(element, element.inert);
        element.inert = value;
    };
    for (let node = root; node && node !== document.body; node = node.parentElement) {
        set(node, false);
        for (const sibling of node.parentElement?.children || []) {
            if (sibling !== node) set(sibling, true);
        }
    }
}

export function createFocusScope(root, { initialFocus, fallbackFocus, opener = document.activeElement } = {}) {
    const scope = { root };
    scopes.push(scope);
    const stops = () => [...root.querySelectorAll(selector)].filter(el =>
        !el.hasAttribute('data-focus-boundary') && !el.closest('[inert]') && el.getClientRects().length);
    const focus = element => element?.focus?.({ preventScroll: true });
    const boundary = last => {
        const node = document.createElement('span');
        node.tabIndex = 0;
        node.setAttribute('data-focus-boundary', '');
        node.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
        node.addEventListener('focus', () => focus(last ? stops().at(0) || root : stops().at(-1) || root));
        return node;
    };
    const start = boundary(false), end = boundary(true);
    root.prepend(start);
    root.append(end);
    const oldTabindex = root.getAttribute('tabindex');
    if (oldTabindex === null) root.tabIndex = -1;
    const onKey = event => {
        if (scopes.at(-1) !== scope || event.key !== 'Tab') return;
        const elements = stops();
        const current = document.activeElement;
        if (!elements.length || (event.shiftKey && current === elements[0])
            || (!event.shiftKey && current === elements.at(-1)) || current === root) {
            event.preventDefault();
            focus((event.shiftKey ? elements.at(-1) : elements[0]) || root);
        }
    };
    const onFocus = event => {
        if (scopes.at(-1) === scope && !root.contains(event.target)) focus(stops()[0] || root);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        const wasTop = scopes.at(-1) === scope;
        const index = scopes.indexOf(scope);
        if (index >= 0) scopes.splice(index, 1);
        observer.disconnect();
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocus, true);
        start.remove(); end.remove();
        if (oldTabindex === null) root.removeAttribute('tabindex');
        else root.setAttribute('tabindex', oldTabindex);
        reconcile();
        if (wasTop) {
            const target = opener?.isConnected && opener.matches?.('button,a[href],input,select,textarea,iframe,[tabindex]')
                && !opener.disabled && !opener.closest?.('[inert]') && opener.getClientRects().length
                ? opener : (typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus);
            focus(target || scopes.at(-1)?.root);
        }
    };
    const observer = new MutationObserver(() => {
        if (!root.isConnected || root.classList.contains('hidden')) release();
        else if (scopes.at(-1) === scope) reconcile();
    });
    observer.observe(document.body, { childList: true });
    if (root.parentElement !== document.body) observer.observe(root.parentElement, { childList: true });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    reconcile();
    focus(initialFocus || stops()[0] || root);
    return release;
}
