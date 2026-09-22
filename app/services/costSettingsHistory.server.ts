// Thin Prisma-backed loader for CostSettings history — the actual
// versioning/resolution logic lives in costSettingsResolver.ts (kept
// framework-free so it's unit testable without a live database). Re-exports
// resolveCostSettingsAt/costRecognitionDate/CostSettingsVersion so callers
// only need to import from this one module.
import prisma from "../db.server";
import type { CostSettingsVersion } from "./costSettingsResolver";

export {
  resolveCostSettingsAt,
  costRecognitionDate,
  computeAdSpendTax,
  type CostSettingsVersion,
} from "./costSettingsResolver";

/**
 * Every CostSettings version saved for a shop, oldest first. A shop that's
 * never saved settings gets one implicit default version, backdated to the
 * epoch so every order resolves to it — the same defaults every order used
 * to get under the old single-row-per-shop model.
 */
export async function getCostSettingsHistory(
  shop: string,
): Promise<CostSettingsVersion[]> {
  const rows = await prisma.costSettings.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "asc" },
  });
  if (rows.length > 0) return rows;
  const defaults = await prisma.costSettings.create({
    data: { shop, effectiveFrom: new Date(0) },
  });
  return [defaults];
}
