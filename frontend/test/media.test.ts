import { describe, expect, test } from "bun:test";
import { buildMetadata, normalizeLink } from "@/lib/media";
import { imageProblem } from "@/components/ImageDrop";

describe("links", () => {
  test("X accepts @handle, handle, twitter.com and x.com URLs", () => {
    expect(normalizeLink("x", "@perk_fun")).toBe("https://x.com/perk_fun");
    expect(normalizeLink("x", "https://twitter.com/perk_fun/")).toBe("https://x.com/perk_fun");
    expect(normalizeLink("x", "not a handle!")).toBeNull();
  });
  test("Telegram and website", () => {
    expect(normalizeLink("telegram", "t.me/perkchat")).toBe("https://t.me/perkchat");
    expect(normalizeLink("telegram", "@perkchat")).toBe("https://t.me/perkchat");
    expect(normalizeLink("website", "perk.xyz")).toBe("https://perk.xyz");
    expect(normalizeLink("website", "http://perk.xyz/a")).toBe("https://perk.xyz/a");
    expect(normalizeLink("website", "javascript:alert(1)")).toBeNull();
  });
});

describe("metadata", () => {
  test("trims, caps the description, drops invalid links, mirrors flat fields", () => {
    const m = buildMetadata({
      name: " Perk Smoke ",
      symbol: "SMOKE",
      description: "x".repeat(400),
      image: "ipfs://cid",
      links: { x: "@perk", telegram: "bad link!", website: "" },
    });
    expect(m.name).toBe("Perk Smoke");
    expect(m.description).toHaveLength(280);
    expect(m.links).toEqual({ x: "https://x.com/perk" });
    expect(m.twitter).toBe("https://x.com/perk");
    expect(m.telegram).toBeUndefined();
  });
});

describe("image checks", () => {
  test("type and size", () => {
    expect(imageProblem({ type: "image/png", size: 1000 })).toBeNull();
    expect(imageProblem({ type: "image/svg+xml", size: 1000 })).toBe("launch.image.badType");
    expect(imageProblem({ type: "image/jpeg", size: 3 * 1024 * 1024 })).toBe("launch.image.tooBig");
  });
});
