/**
 * Outbound requests go to the public internet only, checked where it cannot be faked:
 * the address a host name resolves to, at the moment of connecting.
 *
 * lib/guard.mjs checks a link's text (internal-tool domains, private address literals).
 * A public-looking name can still resolve to a private, loopback, link-local or
 * cloud-metadata address. On a hosted copy that would let a pasted link reach into the
 * company network (server-side request forgery), so this refuses to connect to any
 * such address, for every fetch() in the process once installNetworkGuard() has run.
 * scripts/dashboard.mjs installs it in every mode.
 */
import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

const V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
// ::/96 covers the unspecified and loopback addresses and the old IPv4-compatible form.
const V6 = [["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]];
const blockList = new net.BlockList();
for (const [a, p] of V4) blockList.addSubnet(a, p, "ipv4");
for (const [a, p] of V6) blockList.addSubnet(a, p, "ipv6");

/** An IPv4 address carried inside an IPv4-mapped IPv6 address (::ffff:127.0.0.1 or ::ffff:7f00:1), else null. */
function mappedV4(ip) {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** True for any address that is not a public internet address (or not an address at all). */
export function ipBlocked(ip) {
  const addr = String(ip ?? "").replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v = net.isIP(addr);
  if (!v) return true;
  if (v === 6) {
    const v4 = mappedV4(addr);
    if (v4) return blockList.check(v4, "ipv4");
    return blockList.check(addr, "ipv6");
  }
  return blockList.check(addr, "ipv4");
}

const refuse = (host, addr) => Object.assign(new Error(`Blocked: ${host === addr ? `${host} is` : `${host} resolves to ${addr},`} a private or reserved address. Only public pages are read.`), { code: "EBLOCKED" });

/**
 * dns.lookup, refusing a name if any address it resolves to is private or reserved
 * (a name that mixes public and private answers is refused too). `resolve` is for tests.
 */
export function makeGuardedLookup(resolve = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      const bad = list.find((a) => ipBlocked(a.address));
      if (bad) return callback(refuse(hostname, bad.address));
      if (!list.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }));
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}
export const guardedLookup = makeGuardedLookup();

const connector = buildConnector({ lookup: guardedLookup, timeout: 20000 });
function guardedConnect(opts, callback) {
  const host = String(opts.hostname ?? "").replace(/^\[|\]$/g, "");
  // An address literal never reaches the lookup: check it here.
  if (net.isIP(host) && ipBlocked(host)) return callback(refuse(host, host), null);
  return connector(opts, callback);
}

export const guardedAgent = new Agent({ connect: guardedConnect });

/** fetch() that can reach public internet addresses only. */
export function guardedFetch(input, init = {}) {
  return undiciFetch(input, { ...init, dispatcher: guardedAgent });
}

/** Route every fetch() in this process through the guard. */
export function installNetworkGuard() {
  globalThis.fetch = guardedFetch;
  return guardedFetch;
}

export default { ipBlocked, makeGuardedLookup, guardedLookup, guardedFetch, installNetworkGuard };
