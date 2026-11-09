/**
 * Keeps scraper fetches of retailer-derived URLs (permalinks, redirects) off
 * the server's own network: loopback, private, link-local and cloud-metadata,
 * CGNAT, compose service names (they resolve to private addresses) and other
 * non-public ranges.
 *
 * Zero project imports on purpose: an external-boundary check that anything
 * can import without cycles. Hostnames listed in `allowed` (an operator knob,
 * SCRAPER_ALLOWED_PRIVATE_HOSTS) skip the address check.
 */

import { BlockList, isIP } from 'node:net';
import dns, { type LookupAddress, type LookupOptions } from 'node:dns';

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

/**
 * Whether `ip` is a publicly routable address. IPv4-mapped IPv6
 * (`::ffff:10.0.0.1`, `::ffff:a00:1`) is judged by its IPv4 address.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !NON_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedDestinationError extends Error {
  readonly code = 'EDESTBLOCKED';
  constructor(hostname: string) {
    super(`Blocked fetch to non-public destination ${hostname}`);
    this.name = 'BlockedDestinationError';
  }
}

function bareHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function isAllowed(host: string, allowed: readonly string[] | undefined): boolean {
  return !!allowed?.includes(host);
}

/**
 * Throws unless `url` is http(s) and its host is public: an IP literal is
 * checked directly, a name by every address it resolves to. Call before each
 * redirect hop. The connection itself may resolve again (DNS rebinding); pair
 * with `publicOnlyLookup` on the dispatcher where the stack allows it.
 */
export async function assertPublicDestination(url: string, allowed?: readonly string[]): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedDestinationError(`${u.protocol} URL`);
  const host = bareHost(u.hostname);
  if (isAllowed(host, allowed)) return;
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedDestinationError(host);
    return;
  }
  const addresses = await dns.promises.lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) throw new BlockedDestinationError(host);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `net.connect` (undici `connect.lookup`) that fails when a name
 * resolves to any non-public address, so the address checked is the one the
 * socket connects to. Node skips `lookup` for IP literals, which
 * `assertPublicDestination` covers.
 */
export function publicOnlyLookup(allowed?: readonly string[]) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const host = bareHost(hostname);
      if (!isAllowed(host, allowed) && (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address)))) {
        return callback(new BlockedDestinationError(host), []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
