// Phase 1 scaffold — real polling loop wired up in Phase 4.
console.log("[worker] scaffold ready; OpenSky poller lands in Phase 4");

// Keep the process alive so local dev runs can be killed with ^C without
// the process exiting immediately (removed once the real loop is in place).
if (process.env.NODE_ENV !== "production") {
  setInterval(() => {}, 1 << 30);
}
