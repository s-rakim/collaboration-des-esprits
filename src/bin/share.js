#!/usr/bin/env node
/**
 * The room, opened to your other devices: `npm run serve`.
 *
 * The same server as `npm start`, started so that a phone on the Wi-Fi, a
 * laptop on the VPN or anything on your tailnet can reach it — with a token
 * it makes for itself, and with callers from anywhere that is not a private
 * network turned away. What that means and why is in src/share.js.
 */

import { resolveDbPath } from '../db.js';
import { accessToken } from '../share.js';

const access = accessToken({ dbPath: resolveDbPath() });

// Every interface, so a network that comes up later is answered too. Somebody
// who wants one address only can still say which.
process.env.ESPRITS_HOST ??= '0.0.0.0';
process.env.ESPRITS_PRIVATE_ONLY ??= '1';
process.env.ESPRITS_TOKEN = access.token;
process.env.ESPRITS_TOKEN_FROM = access.from;
if (access.file) process.env.ESPRITS_TOKEN_FILE = access.file;
process.env.ESPRITS_SHARE = '1';

await import('./serve.js');
