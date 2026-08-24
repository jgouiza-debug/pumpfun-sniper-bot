// Side-effect module: installs the console→bot.log tee at import time.
// Imported by server.ts IMMEDIATELY after loadEnv, before any service module,
// so even construction-time lines (state restore, watcher wiring, key checks)
// reach the durable log. A plain function call at the top of server.ts would
// run only after every import finished constructing its singletons.
import { installConsoleTee } from './fileLogger';

installConsoleTee();
