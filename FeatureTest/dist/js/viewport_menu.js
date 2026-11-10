// Viewport label menu — 3ds Max-style dropdown bar pinned top-left.
//
// The bar replaces the old vertical rail. Every actionable control still
// lives under its original element id, so the main app script keeps wiring
// behaviour by getElementById; this module only owns the open/close of the
// dropdowns and forwards label clicks to the icon button in the same row.

(function () {
    var menu = document.getElementById('viewportMenu');
    if (!menu) return;

    var items = Array.prototype.slice.call(menu.querySelectorAll('.vpmenu-item'));

    function closeItem(item) {
        if (!item.classList.contains('open')) return;
        item.classList.remove('open');
        var trigger = item.querySelector('.vpmenu-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function closeAll(except) {
        for (var i = 0; i < items.length; i++) {
            if (items[i] !== except) closeItem(items[i]);
        }
    }

    function toggleItem(item) {
        var willOpen = !item.classList.contains('open');
        closeAll(item);
        item.classList.toggle('open', willOpen);
        var trigger = item.querySelector('.vpmenu-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    // A click anywhere on the bar: triggers open/close, forwards row-label
    // clicks to the row's button, and dismisses on data-vpmenu-close rows.
    menu.addEventListener('click', function (e) {
        var trigger = e.target.closest('.vpmenu-trigger');
        if (trigger) {
            toggleItem(trigger.closest('.vpmenu-item'));
            return;
        }
        var row = e.target.closest('.vpmenu-row');
        if (!row) return;
        // Real interactive children (icon button, segmented switch, camera
        // select) handle their own clicks — only forward bare label clicks.
        var interactive = e.target.closest('.rail-btn, .rail-mode-switch, select, input[type="color"]');
        if (!interactive) {
            var btn = row.querySelector('.rail-btn');
            if (btn) btn.click(); // re-enters here with interactive set
            else return;
        }
        if (row.hasAttribute('data-vpmenu-close')) closeAll();
    });

    // Dismiss when focus/click leaves the bar entirely.
    document.addEventListener('pointerdown', function (e) {
        if (!e.target.closest('#viewportMenu')) closeAll();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeAll();
    });

    // Mirror the active camera name into the POV trigger, like Max's label.
    var sel = document.getElementById('selSceneCamera');
    var povLabel = menu.querySelector('[data-pov-label]');
    function syncPovLabel() {
        if (!sel || !povLabel) return;
        var opt = sel.options[sel.selectedIndex];
        var text = opt ? opt.textContent.trim() : '';
        povLabel.textContent = text || 'Perspective';
    }
    if (sel) {
        sel.addEventListener('change', syncPovLabel);
        // Camera list is populated later by the app; pick up new options too.
        if (typeof MutationObserver === 'function') {
            new MutationObserver(syncPovLabel).observe(sel, { childList: true });
        }
    }
    syncPovLabel();

    // Mirror the active renderer pipeline (WebGL / WGPU) into the
    // Standard trigger label. The app marks the active pipeline button with
    // `.active`; we read its short name straight off the segmented switch.
    var pipeSwitch = document.getElementById('rendererPipelineSwitch');
    var pipeLabel = menu.querySelector('[data-pipeline-label]');
    function syncPipelineLabel() {
        if (!pipeSwitch || !pipeLabel) return;
        var active = pipeSwitch.querySelector('.rail-mode-option.active');
        if (active) pipeLabel.textContent = active.textContent.trim();
    }
    if (pipeSwitch && typeof MutationObserver === 'function') {
        new MutationObserver(syncPipelineLabel).observe(pipeSwitch, {
            subtree: true, attributes: true, attributeFilter: ['class']
        });
    }
    syncPipelineLabel();
})();
