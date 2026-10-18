// Timer Web Worker - runs independently of main thread throttling
let timerId = null;

// start: tick after `delay` (default `milliseconds`); recurring timers then tick every `milliseconds`.
self.onmessage = function (e) {
    const { action, milliseconds, delay = milliseconds, type } = e.data;

    // Both actions first cancel the pending tick.
    clearTimeout(timerId);
    timerId = null;
    if (action !== 'start') return;

    timerId = setTimeout(function tick() {
        self.postMessage({ type: 'tick' });
        timerId = type === 'recurring' ? setTimeout(tick, milliseconds) : null;
    }, delay);
};
