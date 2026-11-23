// Imported first by every test file, before any application module reads the environment:
// settings that happen to be exported in the developer's shell must not change what the tests
// observe (a short DB_BUSY_TIMEOUT_MS, for one, would make the lock tests give up early).
// SQLITE_DRIVER is left alone on purpose - the suite is meant to be run with either driver.
for (const name of [
  'PORT',
  'HOST',
  'DB_PATH',
  'STATIC_DIR',
  'LOG_REQUESTS',
  'DB_BUSY_TIMEOUT_MS',
  'EXPORT_MAX_CONCURRENT',
  'EXPORT_IDLE_TIMEOUT_MS',
]) {
  delete process.env[name];
}
