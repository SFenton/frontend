import { computeDomain } from "../../../../common/entity/compute_domain";
import type { LovelaceCardConfig } from "../../../../data/lovelace/config/card";
import type { TileCardConfig } from "../../cards/types";
import { computeCameraCardConfig } from "../areas/helpers/areas-strategy-helper";

export const computeFavoriteCardConfig = (
  entityId: string
): LovelaceCardConfig => {
  if (computeDomain(entityId) === "camera") {
    return computeCameraCardConfig(entityId);
  }

  return {
    type: "tile",
    entity: entityId,
    state_content: ["state", "area_name"],
    show_entity_picture: true,
  } satisfies TileCardConfig;
};
