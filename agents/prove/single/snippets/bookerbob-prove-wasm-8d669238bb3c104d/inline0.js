
const channel = new BroadcastChannel('bookerbob-prove');
export function emit(kind, text, n) { channel.postMessage({ kind, text, n, at: performance.now() }); }
