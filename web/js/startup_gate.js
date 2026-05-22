// Early body class gates for host/dev/theme visibility.

(function () {
    try {
        if (localStorage.getItem('maxjs-theme') === 'light') {
            document.body.classList.add('light-mode');
            var t = document.getElementById('btnTheme');
            /* icon swaps via CSS — no label rewrite needed */
            void t;
        }
    } catch (e) { /* private mode / disabled storage */ }

    // Rail visibility: set body classes before the rail paints so
    // maxonly/devonly CSS gates resolve without a flash.
    try {
        var isMaxHost = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
        var qs = new URLSearchParams(location.search);
        var modeParam = qs.get('mode');
        var devFlag = qs.get('dev') === '1' || modeParam === 'dev';
        // Dev mode when: running in Max, or explicitly requested via
        // ?dev=1 / ?mode=dev. Standalone release demos stay clean.
        var isDev = isMaxHost || devFlag;
        if (isMaxHost) document.body.classList.add('is-max-host');
        if (isDev) document.body.classList.add('is-dev');

        // Collapse viewport-menu items whose every row is gated out by the
        // maxonly/devonly host filters (e.g. a standalone release demo only
        // keeps Theme + Mute, so View/Renderer/Shading/Tools vanish). Runs
        // once — the DOM isn't reordered after this point.
        // A row is shown by the maxonly/devonly CSS gate when it carries no
        // gate class, or when one of its gates is active. Mirror that here so
        // we only collapse menus whose every row is truly hidden.
        function rowLive(r) {
            if (r.classList.contains('vpmenu-row-debug')) return false; // shown only when app un-hides #btnDebug
            var hasMax = r.classList.contains('maxonly');
            var hasDev = r.classList.contains('devonly');
            if (!hasMax && !hasDev) return true;
            return (hasMax && isMaxHost) || (hasDev && isDev);
        }
        var items = document.querySelectorAll('#viewportMenu .vpmenu-item');
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var rows = item.querySelectorAll('.vpmenu-row');
            var hasLive = false;
            for (var j = 0; j < rows.length; j++) {
                if (rowLive(rows[j])) { hasLive = true; break; }
            }
            if (!hasLive) item.classList.add('vpmenu-empty');
        }
    } catch (e) { /* defensive — don't break boot on rail cleanup */ }
})();
