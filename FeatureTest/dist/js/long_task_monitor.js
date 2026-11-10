// long_task_monitor.js — attributes main-thread stalls to a named phase.
//
// PerformanceObserver('longtask') reports every task over 50 ms, but not what
// the page was doing. Callers stamp a phase ('scene:apply', 'scene:compile',
// 'sync:delta', 'render', …) around their work; each long task is recorded
// with the phase that was current when it ended. The last entries are kept
// for inspection (window.maxjsLongTasks.getEntries()) and, when enabled,
// logged as they happen so a freeze can be attributed without a profiler.
//
// No-ops cleanly where the API is missing (Node, old webviews).

const MAX_ENTRIES = 100;

export function createLongTaskMonitor({
    isLogEnabled = () => false,
    thresholdMs = 50,
    log = (message) => console.warn(message),
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
    let phase = 'idle';
    let phaseSince = now();
    let observer = null;
    const entries = [];
    const totals = new Map(); // phase -> { count, totalMs, maxMs }

    function record(durationMs, startTime, name = 'longtask') {
        const rec = {
            phase,
            durationMs: Math.round(durationMs),
            startTime: Math.round(startTime),
            name,
        };
        entries.push(rec);
        if (entries.length > MAX_ENTRIES) entries.shift();
        const agg = totals.get(phase) ?? { count: 0, totalMs: 0, maxMs: 0 };
        agg.count += 1;
        agg.totalMs += rec.durationMs;
        agg.maxMs = Math.max(agg.maxMs, rec.durationMs);
        totals.set(phase, agg);
        if (isLogEnabled()) log(`[max.js longtask] ${rec.durationMs} ms during "${rec.phase}"`);
        return rec;
    }

    return {
        get phase() { return phase; },
        get supported() {
            return typeof PerformanceObserver !== 'undefined'
                && Array.isArray(PerformanceObserver.supportedEntryTypes)
                && PerformanceObserver.supportedEntryTypes.includes('longtask');
        },
        start() {
            if (observer) return true;
            if (!this.supported) return false;
            try {
                observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.duration >= thresholdMs) record(entry.duration, entry.startTime, entry.name);
                    }
                });
                observer.observe({ entryTypes: ['longtask'] });
                return true;
            } catch {
                observer = null;
                return false;
            }
        },
        stop() {
            if (!observer) return;
            try { observer.disconnect(); } catch { /* already gone */ }
            observer = null;
        },
        setPhase(next) {
            const name = typeof next === 'string' && next.length > 0 ? next : 'idle';
            if (name === phase) return;
            phase = name;
            phaseSince = now();
        },
        // Runs fn under a phase and restores the previous one, including
        // across an await when fn returns a promise.
        withPhase(name, fn) {
            const previous = phase;
            this.setPhase(name);
            let result;
            try {
                result = fn();
            } catch (error) {
                this.setPhase(previous);
                throw error;
            }
            if (result && typeof result.then === 'function') {
                return result.finally(() => this.setPhase(previous));
            }
            this.setPhase(previous);
            return result;
        },
        // Manual attribution for hosts without the observer (or for tests).
        record,
        getEntries() { return entries.slice(); },
        getTotals() {
            const out = {};
            for (const [key, agg] of totals) out[key] = { ...agg };
            return out;
        },
        clear() {
            entries.length = 0;
            totals.clear();
        },
        get phaseElapsedMs() { return now() - phaseSince; },
    };
}
