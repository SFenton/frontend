import { assert, describe, it } from "vitest";
import {
  getSelectableCustomPanels,
  isCustomPanelDefaultCandidate,
} from "../../src/data/panel";
import type { HomeAssistant, PanelInfo } from "../../src/types";
import { createMockHass } from "../fixtures/hass";

const makePanel = (
  urlPath: string,
  overrides: Partial<PanelInfo> = {}
): PanelInfo => ({
  component_name: "custom",
  config: null,
  icon: "mdi:bookmark",
  title: urlPath,
  url_path: urlPath,
  default_visible: true,
  require_admin: false,
  show_in_sidebar: true,
  ...overrides,
});

const makeHass = (panels: PanelInfo[], isAdmin = false): HomeAssistant => {
  const hass = createMockHass();
  hass.panels = Object.fromEntries(
    panels.map((panel) => [panel.url_path, panel])
  );
  hass.user = {
    is_admin: isAdmin,
  } as HomeAssistant["user"];
  return hass;
};

describe("isCustomPanelDefaultCandidate", () => {
  it("accepts titled, sidebar-visible custom panels", () => {
    assert.isTrue(isCustomPanelDefaultCandidate(makePanel("custom")));
    assert.isTrue(
      isCustomPanelDefaultCandidate(
        makePanel("default-hidden", { default_visible: false })
      )
    );
    assert.isTrue(
      isCustomPanelDefaultCandidate(
        makePanel("implicit-sidebar", { show_in_sidebar: undefined })
      )
    );
  });

  it("rejects panels that are not user-facing custom destinations", () => {
    assert.isFalse(
      isCustomPanelDefaultCandidate(
        makePanel("lovelace", { component_name: "lovelace" })
      )
    );
    assert.isFalse(
      isCustomPanelDefaultCandidate(makePanel("untitled", { title: null }))
    );
    assert.isFalse(
      isCustomPanelDefaultCandidate(makePanel("blank-title", { title: "   " }))
    );
    assert.isFalse(
      isCustomPanelDefaultCandidate(
        makePanel("sidebar-hidden", { show_in_sidebar: false })
      )
    );
    assert.isFalse(
      isCustomPanelDefaultCandidate(
        makePanel("configuration", { config_panel_domain: "demo" })
      )
    );
  });
});

describe("getSelectableCustomPanels", () => {
  it("filters admin-only panels by scope and sorts by localized title", () => {
    const panels = [
      makePanel("zebra", { title: "Zebra" }),
      makePanel("admin", { require_admin: true, title: "Admin" }),
      makePanel("apple", { title: "Apple" }),
    ];

    assert.deepEqual(
      getSelectableCustomPanels(makeHass(panels)).map(
        (panel) => panel.url_path
      ),
      ["apple", "zebra"]
    );
    assert.deepEqual(
      getSelectableCustomPanels(makeHass(panels, true)).map(
        (panel) => panel.url_path
      ),
      ["admin", "apple", "zebra"]
    );
    assert.deepEqual(
      getSelectableCustomPanels(makeHass(panels, true), false).map(
        (panel) => panel.url_path
      ),
      ["apple", "zebra"]
    );
  });
});
