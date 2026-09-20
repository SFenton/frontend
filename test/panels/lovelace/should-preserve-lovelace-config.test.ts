import { describe, expect, it } from "vitest";
import type {
  LovelaceConfig,
  LovelaceRawConfig,
} from "../../../src/data/lovelace/config/types";
import { shouldPreserveLovelaceConfig } from "../../../src/panels/lovelace/common/should-preserve-lovelace-config";
import { mockLocale } from "../../fixtures/hass";

const config: LovelaceConfig = {
  views: [
    {
      title: "Home",
      cards: [{ type: "markdown", content: "Ready" }],
    },
  ],
};

const current: NonNullable<Parameters<typeof shouldPreserveLovelaceConfig>[0]> =
  {
    config,
    rawConfig: config,
    mode: "storage",
    urlPath: "lovelace",
    locale: mockLocale,
  };

const candidate = (
  overrides: Partial<Parameters<typeof shouldPreserveLovelaceConfig>[1]> = {}
): Parameters<typeof shouldPreserveLovelaceConfig>[1] => ({
  config: structuredClone(config),
  rawConfig: structuredClone(config),
  mode: "storage",
  urlPath: "lovelace",
  locale: mockLocale,
  ...overrides,
});

describe("shouldPreserveLovelaceConfig", () => {
  it("preserves an equivalent static configuration", () => {
    expect(shouldPreserveLovelaceConfig(current, candidate())).toBe(true);
  });

  it.each([
    ["checked config", { config: { views: [] } }],
    ["raw config", { rawConfig: { views: [] } }],
    ["mode", { mode: "yaml" }],
    ["URL path", { urlPath: "another-dashboard" }],
    ["locale", { locale: { ...mockLocale, language: "fr" } }],
  ] satisfies [
    string,
    Partial<Parameters<typeof shouldPreserveLovelaceConfig>[1]>,
  ][])("rebuilds when the %s changes", (_name, overrides) => {
    expect(shouldPreserveLovelaceConfig(current, candidate(overrides))).toBe(
      false
    );
  });

  it.each([
    ["dashboard", { strategy: { type: "original-states" } }],
    ["view", { views: [{ strategy: { type: "original-states" } }] }],
    [
      "section",
      {
        views: [
          {
            type: "sections",
            sections: [{ strategy: { type: "common-controls" } }],
          },
        ],
      },
    ],
  ] satisfies [string, LovelaceRawConfig][])(
    "rebuilds a %s strategy",
    (_name, rawConfig) => {
      expect(
        shouldPreserveLovelaceConfig(
          current,
          candidate({ config: structuredClone(config), rawConfig })
        )
      ).toBe(false);
    }
  );
});
