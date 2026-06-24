// Small, dependency-free timing helpers shared by the UI modules.
//
// The frontend has many ad-hoc `let t; clearTimeout(t); t = setTimeout(…)`
// debounces. This collapses the simple trailing-edge cases into one tested
// helper. Stateful debounces that need a dynamic delay or external
// cancellation (the live-preview render, the draft autosave) keep their
// bespoke timers on purpose — they're not a fit for this shape.

// Trailing-edge debounce: the wrapped function runs `ms` after the last
// call, with the most recent arguments and `this`. The returned function
// carries a `.cancel()` that drops any pending invocation.
export function debounce(fn, ms) {
  let timer = null;
  function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  }
  debounced.cancel = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  return debounced;
}
