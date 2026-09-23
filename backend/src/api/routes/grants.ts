import { Hono } from "hono";
import { addressParam, HttpError, type AppEnv } from "../server";
import type { GrantAllocationProof, GrantCampaign, GrantDetail, GrantPosition } from "../types";
import { mapGrantAllocation, mapGrantCampaign, mapGrantPosition } from "../mappers";
import {
  parseStatusList,
  selectGrantAllocations,
  selectGrantCampaign,
  selectGrantCampaigns,
  selectGrantPositions,
  selectReferralCreditsTotal,
} from "../queries";
import { selectGrantDataset, selectGrantLeaf } from "../../grants/datasets";

/**
 * GET /v1/grants?status=1,2,3[&include=hidden] → { campaigns: GrantCampaign[] } newest initialized first — max-age 5.
 *   Campaigns of launches that moderation hid are left out unless `include=hidden` (the admin page's view).
 * GET /v1/grants/:meme → GrantDetail (positions newest first, allocations by base desc, 404 if no campaign) — max-age 3.
 * GET /v1/grants/:meme/proof/:account → GrantAllocationProof for the current root — max-age 60.
 * GET /v1/grants/:meme/positions?beneficiary=0x.. → { positions: GrantPosition[] } — max-age 3.
 */
export function grantRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const { db, config } = c.get("deps");
    const statuses = parseStatusList(c.req.query("status"), 0, 5);
    const includeHidden = c.req.query("include") === "hidden";
    const rows = await selectGrantCampaigns(db, config.chainId, statuses, { includeHidden });
    c.header("Cache-Control", "public, max-age=5");
    return c.json<{ campaigns: GrantCampaign[] }>({ campaigns: rows.map(mapGrantCampaign) });
  });
  r.get("/:meme", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const campaign = await selectGrantCampaign(db, config.chainId, meme);
    if (!campaign) throw new HttpError(404, "not_found", "campaign not found");
    const [positions, allocations, credits, dataset] = await Promise.all([
      selectGrantPositions(db, config.chainId, meme),
      selectGrantAllocations(db, config.chainId, meme),
      selectReferralCreditsTotal(db, config.chainId, meme),
      selectGrantDataset(db, config.chainId, meme, campaign.root, campaign.root_uri),
    ]);
    c.header("Cache-Control", "public, max-age=3");
    return c.json<GrantDetail>({
      campaign: mapGrantCampaign(campaign),
      positions: positions.map(mapGrantPosition),
      allocations: allocations.map(mapGrantAllocation),
      referralCreditsTotal: credits,
      dataset,
    });
  });
  r.get("/:meme/proof/:account", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const account = addressParam(c.req.param("account"), "account");
    c.header("Cache-Control", "public, max-age=60");
    const campaign = await selectGrantCampaign(db, config.chainId, meme);
    if (!campaign) throw new HttpError(404, "not_found", "campaign not found");
    const dataset = await selectGrantDataset(db, config.chainId, meme, campaign.root, campaign.root_uri);
    if (dataset.status !== "verified" || !dataset.root) {
      throw new HttpError(409, "dataset_unverified", dataset.status);
    }
    const leaf = await selectGrantLeaf(db, config.chainId, meme, dataset.root, account);
    if (!leaf) throw new HttpError(404, "not_listed", "account is not in the allocation list");
    return c.json<GrantAllocationProof>({
      meme,
      root: dataset.root,
      leaf: { account: leaf.account, baseAllocation: leaf.baseAllocation, inviteeBoost: leaf.inviteeBoost },
      proof: leaf.proof,
    });
  });
  r.get("/:meme/positions", async (c) => {
    const { db, config } = c.get("deps");
    const meme = addressParam(c.req.param("meme"), "meme");
    const campaign = await selectGrantCampaign(db, config.chainId, meme);
    if (!campaign) throw new HttpError(404, "not_found", "campaign not found");
    const beneficiaryRaw = c.req.query("beneficiary");
    const beneficiary = beneficiaryRaw ? addressParam(beneficiaryRaw, "beneficiary") : undefined;
    const rows = await selectGrantPositions(db, config.chainId, meme, beneficiary);
    c.header("Cache-Control", "public, max-age=3");
    return c.json<{ positions: GrantPosition[] }>({ positions: rows.map(mapGrantPosition) });
  });
  return r;
}

export type { GrantCampaign, GrantDetail, GrantPosition };
