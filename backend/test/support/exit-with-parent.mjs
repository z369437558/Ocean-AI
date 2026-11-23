// Preloaded into every server the tests start (node --import). The test process keeps the write
// end of this process's stdin; when it goes away - even killed outright - stdin ends and the
// server stops too, instead of living on as an orphan that still listens on its port.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
