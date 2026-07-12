// srv/lib/curl-transport.js
//
// (#1033 follow-up) TLS-fingerprint transport for RSS fetches.
//
// Root cause of the community-blogs-fetch 403s: Cloudflare's bot management
// on community.sap.com escalated from UA-based to TLS/HTTP-2 client
// FINGERPRINT-based challenges (JA3/JA4). Node's undici (Node 26) presents a
// ClientHello Cloudflare now flags; curl's ClientHello passes. Proven on the
// same egress IP:
//   curl  (browser UA)      → 200
//   node  fetch (any UA)    → 403
// So bumping the User-Agent cannot fix it — headers ride inside a connection
// whose fingerprint is already flagged. We route the fetch through the curl
// binary (present in the cflinuxfs4 rootfs) to borrow its TLS fingerprint.
//
// SECURITY: this is a `fetch`-shaped TRANSPORT only. It performs NO SSRF
// validation of its own — it is designed to be injected into safeFetch()
// (srv/lib/safe-fetch.js) as `fetchImpl`, so the protocol/host allowlist,
// private-IP rejection, and per-hop redirect re-validation all still run in
// safeFetch. curl is invoked WITHOUT -L (no auto-follow): redirects are
// surfaced as a 3xx status + Location header and re-checked by safeFetch's
// own loop, exactly as the native-fetch path does with redirect:'manual'.
//
// curl is invoked via execFile with an argv array (no shell), so the URL and
// header values are never interpolated into a command line — no injection.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CURL_BIN = process.env.RSS_CURL_BIN || 'curl';

/** Parse a raw HTTP header block (from curl -D) into a case-insensitive map. */
function parseHeaderBlock(raw) {
  // curl -D dumps every response's headers, including those of intermediate
  // 1xx / redirect responses when -L is used. We do NOT use -L, so there is
  // at most one status line + header set — but guard by taking the LAST
  // status line and the headers that follow it anyway.
  const lines = raw.split(/\r?\n/);
  let status = 0;
  const map = new Map();
  for (const line of lines) {
    const statusMatch = line.match(/^HTTP\/[\d.]+\s+(\d{3})/i);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      map.clear(); // reset — headers belonging to the final response only
      continue;
    }
    const idx = line.indexOf(':');
    if (idx > 0) {
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      map.set(name, value);
    }
  }
  return { status, map };
}

/**
 * A `fetch`-shaped transport backed by the curl binary. Signature matches the
 * subset of the WHATWG fetch API that safeFetch relies on.
 *
 * @param {string} url
 * @param {object} [init]
 * @param {Record<string,string>} [init.headers]
 * @param {AbortSignal} [init.signal]  Used to derive the curl --max-time.
 * @returns {Promise<{ok:boolean,status:number,headers:{get(name:string):string|null},text:()=>Promise<string>}>}
 */
export function curlFetch(url, init = {}) {
  const headers = init.headers || {};
  // safeFetch always passes an AbortSignal.timeout(timeoutMs); derive curl's
  // own hard cap from it so a hung TLS handshake can't outlive the job tick.
  // We can't read the timeout off the signal, so accept an explicit override
  // and otherwise fall back to a conservative default.
  const timeoutMs = Number(init.__timeoutMs) || 15000;
  const maxTimeSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const headerArgs = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push('-H', `${k}: ${v}`);
  }

  return (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rss-curl-'));
    const headerFile = path.join(dir, 'h');
    const bodyFile = path.join(dir, 'b');
    try {
      const args = [
        '-sS',                 // silent, but surface transport errors on stderr
        '--fail-with-body',    // exit nonzero on HTTP >=400 but still write body
        '--max-time', String(maxTimeSec),
        '--max-redirs', '0',   // do NOT follow — safeFetch re-validates each hop
        '-D', headerFile,      // dump response headers here
        '-o', bodyFile,        // write body here
        ...headerArgs,
        url,
      ];
      await new Promise((resolve, reject) => {
        execFile(CURL_BIN, args, { timeout: timeoutMs + 2000, maxBuffer: 16 * 1024 * 1024 },
          (err) => {
            // --fail-with-body makes curl exit 22 on HTTP >=400; that is NOT a
            // transport failure — we still wrote headers+body and want to
            // return the real status (e.g. 403) to the caller. Only reject on
            // genuine transport errors (DNS, TLS, timeout: exit codes != 22).
            if (err && err.code !== 22) return reject(err);
            resolve();
          });
      });

      const rawHeaders = await fs.readFile(headerFile, 'utf8').catch(() => '');
      const { status, map } = parseHeaderBlock(rawHeaders);
      let bodyRead = false;
      let bodyCache = '';
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
        async text() {
          if (!bodyRead) { bodyCache = await fs.readFile(bodyFile, 'utf8').catch(() => ''); bodyRead = true; }
          return bodyCache;
        },
      };
    } finally {
      // Best-effort cleanup; never let a temp-file error mask the fetch result.
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}
