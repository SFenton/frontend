import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageBase } from "home-assistant-js-websocket";
import type * as StrategyModule from "../../../src/panels/lovelace/strategies/get-strategy";
import type {
  LovelaceConfig,
  LovelaceRawConfig,
} from "../../../src/data/lovelace/config/types";
import type { Lovelace } from "../../../src/panels/lovelace/types";
import type { HomeAssistant, PanelInfo, Route } from "../../../src/types";
import { broadcastConnectionStatus } from "../../../src/data/connection-status";
import { LovelacePanel } from "../../../src/panels/lovelace/ha-panel-lovelace";

vi.hoisted(() => {
  Object.assign(globalThis, {
    __STATIC_PATH__: "/",
    __HASS_URL__: "",
    __BUILD__: "modern",
    __VERSION__: "test",
    __BACKWARDS_COMPAT__: false,
    __SUPERVISOR__: false,
    __NAMESPACE__: "frontend",
  });
});

const { generateLovelaceDashboardStrategy } = vi.hoisted(() => ({
  generateLovelaceDashboardStrategy: vi.fn(),
}));

vi.mock(
  "../../../src/panels/lovelace/strategies/get-strategy",
  async (importOriginal) => ({
    ...(await importOriginal<typeof StrategyModule>()),
    generateLovelaceDashboardStrategy,
  })
);

vi.mock("../../../src/panels/lovelace/hui-root", () => {
  if (!customElements.get("hui-root")) {
    customElements.define("hui-root", class extends HTMLElement {});
  }
  return {};
});

vi.mock("../../../src/components/ha-button", () => {
  if (!customElements.get("ha-button")) {
    customElements.define("ha-button", class extends HTMLElement {});
  }
  return {};
});

vi.mock("../../../src/layouts/hass-error-screen", () => {
  if (!customElements.get("hass-error-screen")) {
    customElements.define("hass-error-screen", class extends HTMLElement {});
  }
  return {};
});

vi.mock("../../../src/layouts/hass-loading-screen", () => {
  if (!customElements.get("hass-loading-screen")) {
    customElements.define("hass-loading-screen", class extends HTMLElement {});
  }
  return {};
});

interface LovelacePanelInternals {
  lovelace?: Lovelace;
}

interface MountedPanel {
  configRequests: MessageBase[];
  getLovelace: () => Lovelace;
  hass: HomeAssistant;
  panel: LovelacePanel;
  setConfig: (config: LovelaceRawConfig) => void;
}

const defaultConfig: LovelaceConfig = {
  views: [
    {
      title: "Home",
      cards: [{ type: "markdown", content: "Ready" }],
    },
  ],
};

let panels: LovelacePanel[] = [];

const cloneConfig = (config: LovelaceRawConfig): LovelaceRawConfig =>
  structuredClone(config);

const mountPanel = async (
  initialConfig: LovelaceRawConfig = defaultConfig,
  mode: "storage" | "yaml" = "storage"
): Promise<MountedPanel> => {
  let config = initialConfig;
  const configRequests: MessageBase[] = [];
  const connection = {
    sendMessagePromise: vi.fn(async (message: MessageBase) => {
      if (message.type === "lovelace/resources") {
        return [];
      }
      if (message.type === "lovelace/config") {
        configRequests.push(message);
        return cloneConfig(config);
      }
      throw new Error(`Unexpected command: ${message.type}`);
    }),
    subscribeEvents: vi.fn().mockResolvedValue(() => undefined),
  };
  const hass = {
    areas: {},
    config: { state: "RUNNING" },
    connection,
    devices: {},
    entities: {},
    locale: { language: "en" },
    localize: (key: string) => key,
  } as unknown as HomeAssistant;
  const panel = document.createElement("ha-panel-lovelace");
  panel.panel = {
    component_name: "lovelace",
    config: { mode },
    title: "Overview",
    url_path: "lovelace",
  } as PanelInfo<{ mode: "storage" | "yaml" }>;
  panel.hass = hass;
  panel.route = { prefix: "", path: "/lovelace" } as Route;
  document.body.append(panel);
  panels.push(panel);
  expect(panel).toBeInstanceOf(LovelacePanel);

  await vi.waitFor(() => {
    expect(configRequests).toHaveLength(1);
    expect((panel as unknown as LovelacePanelInternals).lovelace).toBeDefined();
  });
  await panel.updateComplete;

  return {
    configRequests,
    getLovelace: () => (panel as unknown as LovelacePanelInternals).lovelace!,
    hass,
    panel,
    setConfig: (newConfig) => {
      config = newConfig;
    },
  };
};

const reconnect = async (mounted: MountedPanel) => {
  broadcastConnectionStatus("connected");
  await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await mounted.panel.updateComplete;
};

beforeEach(() => {
  generateLovelaceDashboardStrategy
    .mockReset()
    .mockImplementation(
      async () => cloneConfig(defaultConfig) as LovelaceConfig
    );
});

afterEach(() => {
  panels.forEach((panel) => panel.remove());
  panels = [];
  vi.restoreAllMocks();
});

// Reconnects must still refetch Lovelace so missed updates are applied, but an
// equal static response must not replace the object identity that owns cards.
describe("ha-panel-lovelace reconnect handling", () => {
  it("refetches but preserves an unchanged storage dashboard", async () => {
    const mounted = await mountPanel();
    const lovelace = mounted.getLovelace();

    await reconnect(mounted);

    expect(mounted.getLovelace()).toBe(lovelace);
    expect(mounted.configRequests[1]).toMatchObject({
      type: "lovelace/config",
      force: false,
    });
  });

  it("refetches but preserves an unchanged YAML dashboard", async () => {
    const mounted = await mountPanel(defaultConfig, "yaml");
    const lovelace = mounted.getLovelace();

    await reconnect(mounted);

    expect(mounted.getLovelace()).toBe(lovelace);
  });

  it("preserves an unchanged dashboard without a views key", async () => {
    const mounted = await mountPanel({} as LovelaceRawConfig);
    const lovelace = mounted.getLovelace();

    await reconnect(mounted);

    expect(mounted.getLovelace()).toBe(lovelace);
  });

  it("applies a dashboard change received after reconnect", async () => {
    const mounted = await mountPanel();
    const lovelace = mounted.getLovelace();
    mounted.setConfig({
      views: [
        {
          title: "Changed",
          cards: [{ type: "markdown", content: "Updated" }],
        },
      ],
    });

    await reconnect(mounted);

    expect(mounted.getLovelace()).not.toBe(lovelace);
    expect(mounted.getLovelace().config.views[0].title).toBe("Changed");
  });

  it("keeps forced refresh as an explicit rebuild", async () => {
    const mounted = await mountPanel();
    const lovelace = mounted.getLovelace();

    mounted.panel.shadowRoot!.querySelector("hui-root")!.dispatchEvent(
      new CustomEvent("config-refresh", {
        bubbles: true,
        composed: true,
      })
    );
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    await mounted.panel.updateComplete;

    expect(mounted.getLovelace()).not.toBe(lovelace);
    expect(mounted.configRequests[1]).toMatchObject({
      type: "lovelace/config",
      force: true,
    });
  });

  it("rebuilds when locale or mode metadata changes", async () => {
    const mounted = await mountPanel();
    let lovelace = mounted.getLovelace();
    mounted.panel.remove();
    mounted.panel.hass = {
      ...mounted.hass,
      locale: { language: "fr" },
    } as HomeAssistant;
    document.body.append(mounted.panel);
    await mounted.panel.updateComplete;

    expect(mounted.getLovelace()).not.toBe(lovelace);
    lovelace = mounted.getLovelace();
    mounted.panel.panel = {
      ...mounted.panel.panel!,
      config: { mode: "yaml" },
    };

    broadcastConnectionStatus("connected");
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await mounted.panel.updateComplete;

    expect(mounted.getLovelace()).not.toBe(lovelace);
  });

  it("consumes a pending update after the panel reconnects", async () => {
    const mounted = await mountPanel();
    const lovelace = mounted.getLovelace();
    mounted.panel.remove();
    (Reflect.get(mounted.panel, "_lovelaceChanged") as () => void).call(
      mounted.panel
    );

    document.body.append(mounted.panel);
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mounted.getLovelace()).toBe(lovelace);

    mounted.panel.remove();
    document.body.append(mounted.panel);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mounted.configRequests).toHaveLength(2);
  });

  it.each([
    ["dashboard", { strategy: { type: "test" } } satisfies LovelaceRawConfig],
    [
      "view",
      {
        views: [{ strategy: { type: "test" } }],
      } satisfies LovelaceRawConfig,
    ],
    [
      "section",
      {
        views: [
          {
            type: "sections",
            sections: [{ strategy: { type: "test" } }],
          },
        ],
      } satisfies LovelaceRawConfig,
    ],
  ])(
    "rebuilds a %s strategy dashboard after reconnect",
    async (_name, config) => {
      const mounted = await mountPanel(config);
      const lovelace = mounted.getLovelace();

      await reconnect(mounted);

      expect(mounted.getLovelace()).not.toBe(lovelace);
    }
  );
});
