import { deepEqual } from "../../../common/util/deep-equal";
import { isStrategySection } from "../../../data/lovelace/config/section";
import type { LovelaceRawConfig } from "../../../data/lovelace/config/types";
import { isStrategyDashboard } from "../../../data/lovelace/config/types";
import { isStrategyView } from "../../../data/lovelace/config/view";
import type { Lovelace } from "../types";

type ComparableLovelaceConfig = Pick<
  Lovelace,
  "config" | "locale" | "mode" | "rawConfig" | "urlPath"
>;

const hasStrategy = (config: LovelaceRawConfig): boolean =>
  isStrategyDashboard(config) ||
  (config.views?.some(
    (view) =>
      isStrategyView(view) ||
      Boolean(view.sections?.some((section) => isStrategySection(section)))
  ) ??
    false);

export const shouldPreserveLovelaceConfig = (
  current: ComparableLovelaceConfig | undefined,
  next: ComparableLovelaceConfig
): boolean =>
  Boolean(
    current &&
    current.urlPath === next.urlPath &&
    current.mode === next.mode &&
    current.locale === next.locale &&
    !hasStrategy(next.rawConfig) &&
    deepEqual(current.rawConfig, next.rawConfig) &&
    deepEqual(current.config, next.config)
  );
