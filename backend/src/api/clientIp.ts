import type { Context } from "hono";
import { normaliseIp, rateLimitKey } from "../net/ip";
import type { AppEnv } from "./server";

/**
 * The client's address. Each reverse proxy in front of the API appends the address it received the request from to
 * X-Forwarded-For, so behind `trustedProxyHops` proxies the client is the entry that many places from the right;
 * everything to its left was written by the client itself and proves nothing. With no trusted proxy the socket peer is
 * the client, whatever the headers say. DigitalOcean App Platform puts one proxy in front of the app.
 */
export function clientAddress(
  forwardedFor: string | null | undefined,
  peer: string | null | undefined,
  trustedProxyHops: number,
): string {
  if (trustedProxyHops > 0 && forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (hops.length > 0) {
      const ip = normaliseIp(hops[Math.max(0, hops.length - trustedProxyHops)]!);
      if (ip) return ip;
    }
  }
  return (peer ? normaliseIp(peer) : null) ?? "unknown";
}

/** The rate-limit key of a request: its client address, IPv6 reduced to the /64. */
export function clientKey(c: Context<AppEnv>): string {
  const { config } = c.get("deps");
  return rateLimitKey(clientAddress(c.req.header("x-forwarded-for"), c.env?.ip, config.trustedProxyHops));
}
