const w = console.warn, e = console.error;
function dump(where, args) {
  const msg = args.map(String).join(" ");
  if (msg.includes("Failed to load bindings") || msg.includes("pure JS will be used")) {
    const err = new Error("trace");
    Error.captureStackTrace(err, dump);
    e.call(console, `\n[trace-native] ${where}: ${msg}\n${err.stack}\n`);
  }
}
console.warn = (...a) => { dump("warn", a); return w.apply(console, a); };
console.error = (...a) => { dump("error", a); return e.apply(console, a); };
