import { describe, expect, test } from "bun:test";
import { isPublicAddress, normaliseIp, rateLimitKey } from "../src/net/ip";
import { allowAddressRanges, FetchFailedError, fetchPublic, UrlRefusedError, type FetchLike, type LookupFn } from "../src/net/fetchPublic";
import { clientAddress } from "../src/api/clientIp";

describe("address classification", () => {
  test("test_isPublicAddress_refusesPrivateAndSpecialIPv4", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.215.14", "172.32.0.1", "100.128.0.1"]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    }
  });

  test("test_isPublicAddress_refusesPrivateAndSpecialIPv6", () => {
    for (const ip of [
      "::",
      "::1",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "fd00:ec2::254",
      "ff02::1",
      "2001:db8::1",
      "2001::1", // Teredo
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:a9fe:a9fe", // IPv4-mapped 169.254.169.254
      "64:ff9b::10.0.0.1", // NAT64 to a private address
      "2002:0a00:0001::1", // 6to4 of 10.0.0.1
      "::10.0.0.1",
      "not-an-address",
    ]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    }
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    }
  });

  test("test_normaliseIp_canonicalForms", () => {
    expect(normaliseIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normaliseIp("[2001:DB8::1]:443")).toBe("2001:db8:0:0:0:0:0:1");
    expect(normaliseIp("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(normaliseIp("example.com")).toBeNull();
  });

  test("test_rateLimitKey_groupsIPv6ByPrefix", () => {
    expect(rateLimitKey("2001:db8:1:2::1")).toBe(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(rateLimitKey("2001:db8:1:2::1")).not.toBe(rateLimitKey("2001:db8:1:3::1"));
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitKey("1.2.3.4")).not.toBe(rateLimitKey("1.2.3.5"));
  });

  test("test_clientAddress_trustsOnlyTheProxyHops", () => {
    // no trusted proxy: the socket peer, whatever the client wrote
    expect(clientAddress("1.1.1.1", "10.0.0.9", 0)).toBe("10.0.0.9");
    // one proxy: the entry it appended (rightmost); what the client prepended is ignored
    expect(clientAddress("6.6.6.6, 2.2.2.2", "10.0.0.9", 1)).toBe("2.2.2.2");
    expect(clientAddress("7.7.7.7, 2.2.2.2", "10.0.0.9", 1)).toBe("2.2.2.2");
    // two proxies: the second entry from the right
    expect(clientAddress("6.6.6.6, 3.3.3.3, 4.4.4.4", "10.0.0.9", 2)).toBe("3.3.3.3");
    // fewer entries than hops: the leftmost, which a trusted proxy wrote
    expect(clientAddress("3.3.3.3", "10.0.0.9", 2)).toBe("3.3.3.3");
    // no header, or garbage where the proxy's entry should be: the peer
    expect(clientAddress(undefined, "10.0.0.9", 1)).toBe("10.0.0.9");
    expect(clientAddress("junk", "10.0.0.9", 1)).toBe("10.0.0.9");
  });
});

describe("fetchPublic", () => {
  const PUBLIC: LookupFn = async () => ["93.184.215.14"];
  const opts = (fetch: FetchLike, lookup: LookupFn = PUBLIC) => ({ fetch, lookup, timeoutMs: 1000, maxBytes: 64 });

  function recorder(answer: (url: string) => Response) {
    const urls: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      expect(init?.redirect).toBe("manual");
      urls.push(String(input));
      return answer(String(input));
    };
    return { urls, fetch };
  }

  test("test_fetchPublic_acceptsConfiguredRangesOnly", async () => {
    const r = recorder(() => new Response("{}"));
    const fakeIp: LookupFn = async () => ["198.18.7.51"];
    await expect(fetchPublic("https://gateway.example/x.json", opts(r.fetch, fakeIp))).rejects.toBeInstanceOf(UrlRefusedError);
    allowAddressRanges(["198.18.0.0/15"]);
    try {
      await expect(fetchPublic("https://gateway.example/x.json", opts(r.fetch, fakeIp))).resolves.toBeDefined();
      // the allowance is exactly the range: loopback and other private space stay refused
      await expect(fetchPublic("https://x.example/", opts(r.fetch, async () => ["127.0.0.1"]))).rejects.toBeInstanceOf(UrlRefusedError);
      await expect(fetchPublic("https://x.example/", opts(r.fetch, async () => ["10.0.0.1"]))).rejects.toBeInstanceOf(UrlRefusedError);
    } finally {
      allowAddressRanges([]);
    }
    expect(() => allowAddressRanges(["198.18.0.0/4"])).toThrow();
  });

  test("test_fetchPublic_refusesHostsThatResolvePrivately", async () => {
    const r = recorder(() => new Response("{}"));
    for (const addrs of [["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["93.184.215.14", "192.168.0.1"]]) {
      await expect(fetchPublic("https://internal.example/x.json", opts(r.fetch, async () => addrs))).rejects.toBeInstanceOf(UrlRefusedError);
    }
    await expect(fetchPublic("https://127.0.0.1/x", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(fetchPublic("https://[::1]/x", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(fetchPublic("https://2130706433/x", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    expect(r.urls).toEqual([]);
  });

  test("test_fetchPublic_refusesPlainHttpAndCredentials", async () => {
    const r = recorder(() => new Response("{}"));
    await expect(fetchPublic("http://public.example/x", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(fetchPublic("https://user:pw@public.example/x", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(fetchPublic("file:///etc/passwd", opts(r.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    expect(r.urls).toEqual([]);
  });

  test("test_fetchPublic_checksEveryRedirectHop", async () => {
    // a downgrade to http is refused at the hop, before anything is fetched from it
    const down = recorder((u) =>
      u.includes("start") ? new Response(null, { status: 302, headers: { location: "http://public.example/next" } }) : new Response("{}"),
    );
    await expect(fetchPublic("https://public.example/start", opts(down.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    expect(down.urls).toEqual(["https://public.example/start"]);

    // a redirect to a host that resolves privately is refused too
    const lookup: LookupFn = async (host) => (host === "metadata.internal" ? ["169.254.169.254"] : ["93.184.215.14"]);
    const inner = recorder((u) =>
      u.includes("start") ? new Response(null, { status: 301, headers: { location: "https://metadata.internal/latest" } }) : new Response("{}"),
    );
    await expect(fetchPublic("https://public.example/start", opts(inner.fetch, lookup))).rejects.toBeInstanceOf(UrlRefusedError);
    expect(inner.urls).toEqual(["https://public.example/start"]);

    // an ordinary relative redirect to a public place is followed
    const ok = recorder((u) =>
      u.includes("start") ? new Response(null, { status: 302, headers: { location: "/final.json" } }) : new Response('{"a":1}'),
    );
    const body = await fetchPublic("https://public.example/start", opts(ok.fetch));
    expect(new TextDecoder().decode(body)).toBe('{"a":1}');
    expect(ok.urls).toEqual(["https://public.example/start", "https://public.example/final.json"]);

    // and a loop stops
    const loop = recorder(() => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(fetchPublic("https://public.example/start", opts(loop.fetch))).rejects.toBeInstanceOf(UrlRefusedError);
    expect(loop.urls).toHaveLength(4);
  });

  test("test_fetchPublic_capsSizeAndTime", async () => {
    const big = recorder(() => new Response("x".repeat(65)));
    await expect(fetchPublic("https://public.example/big", opts(big.fetch))).rejects.toBeInstanceOf(FetchFailedError);

    // a body that trickles in forever is cut off at the deadline
    const slow: FetchLike = async () =>
      new Response(
        new ReadableStream({
          async pull(ctrl) {
            await Bun.sleep(50);
            ctrl.enqueue(new Uint8Array([0x20]));
          },
        }),
      );
    const t0 = Date.now();
    await expect(fetchPublic("https://public.example/slow", { fetch: slow, lookup: PUBLIC, timeoutMs: 300, maxBytes: 1_000_000 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);

    const status = recorder(() => new Response("nope", { status: 404 }));
    await expect(fetchPublic("https://public.example/404", opts(status.fetch))).rejects.toThrow("HTTP 404");
  });
});
