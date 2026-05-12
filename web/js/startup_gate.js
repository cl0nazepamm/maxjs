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

        // Mark rail-groups whose only remaining children are labels /
        // separators (so the CSS can collapse them). Runs once — the
        // DOM isn't reordered after this point.
        var groups = document.querySelectorAll('#rightRail .rail-group');
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            var hasLive = false;
            var kids = g.children;
            for (var j = 0; j < kids.length; j++) {
                var c = kids[j];
                if (c.classList.contains('rail-group-label')) continue;
                if (c.classList.contains('maxonly') && !isMaxHost) continue;
                if (c.classList.contains('devonly') && !isDev) continue;
                hasLive = true;
                break;
            }
            if (!hasLive) g.classList.add('rail-empty');
        }
    } catch (e) { /* defensive — don't break boot on rail cleanup */ }
})();
