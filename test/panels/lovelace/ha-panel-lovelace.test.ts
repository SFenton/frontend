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

interface SubscriptionRecord {
  callback: (event: {
    data: { url_path: string | null; mode: "storage" | "yaml" };
  }) => void;
  eventType: string;
  reject?: (error: unknown) => void;
  resolve?: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  urlPath: string | null;
}

interface MountedPanel {
  configRequests: MessageBase[];
  deferNextSubscription: () => void;
  getLovelace: () => Lovelace;
  hass: HomeAssistant;
  panel: LovelacePanel;
  setConfig: (config: LovelaceRawConfig) => void;
  deferNextConfig: () => {
    resolve: (config: LovelaceRawConfig) => void;
    reject: (error: unknown) => void;
  };
  subscribeEvents: ReturnType<typeof vi.fn>;
  subscriptions: SubscriptionRecord[];
}

const defaultConfig: LovelaceConfig = {
  views: [
    {
      title: "Home",
      cards: [{ type: "markdown", content: "Ready" }],
    },
  ],
};

const sidebarStrategy = { type: "grid", strategy: { type: "test" } };

let panels: LovelacePanel[] = [];

const cloneConfig = (config: LovelaceRawConfig): LovelaceRawConfig =>
  structuredClone(config);

const mountPanel = async (
  initialConfig: LovelaceRawConfig = defaultConfig,
  mode: "storage" | "yaml" = "storage",
  initialResponse?: Promise<LovelaceRawConfig>,
  options?: {
    deferInitialSubscription?: boolean;
    urlPath?: string | null;
  }
): Promise<MountedPanel> => {
  let config = initialConfig;
  let nextConfig = initialResponse;
  let shouldDeferNextSubscription = options?.deferInitialSubscription ?? false;
  const configRequests: MessageBase[] = [];
  const subscriptions: SubscriptionRecord[] = [];
  const panel = document.createElement("ha-panel-lovelace");
  const connection = {
    sendMessagePromise: vi.fn(async (message: MessageBase) => {
      if (message.type === "lovelace/resources") {
        return [];
      }
      if (message.type === "lovelace/config") {
        configRequests.push(message);
        const response = nextConfig;
        nextConfig = undefined;
        return response ?? cloneConfig(config);
      }
      throw new Error(`Unexpected command: ${message.type}`);
    }),
    subscribeEvents: vi.fn(
      (
        callback: SubscriptionRecord["callback"],
        eventType: string
      ): Promise<() => void> => {
        const unsubscribe = vi.fn();
        let resolve: (() => void) | undefined;
        let reject: ((error: unknown) => void) | undefined;
        const subscription = shouldDeferNextSubscription
          ? new Promise<() => void>((resolvePromise, rejectPromise) => {
              resolve = () => resolvePromise(unsubscribe);
              reject = rejectPromise;
            })
          : Promise.resolve(unsubscribe);

        subscriptions.push({
          callback,
          eventType,
          reject,
          resolve,
          unsubscribe,
          urlPath: panel.urlPath,
        });
        shouldDeferNextSubscription = false;
        return subscription;
      }
    ),
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
  panel.panel = {
    component_name: "lovelace",
    config: { mode },
    title: "Overview",
    url_path: options?.urlPath ?? "lovelace",
  } as PanelInfo<{ mode: "storage" | "yaml" }>;
  panel.hass = hass;
  panel.route = {
    prefix: "",
    path: `/${options?.urlPath ?? "lovelace"}`,
  } as Route;
  document.body.append(panel);
  panels.push(panel);
  expect(panel).toBeInstanceOf(LovelacePanel);

  await vi.waitFor(() => {
    expect(configRequests).toHaveLength(1);
    if (!initialResponse) {
      expect(
        (panel as unknown as LovelacePanelInternals).lovelace
      ).toBeDefined();
    }
  });
  await panel.updateComplete;

  return {
    configRequests,
    deferNextSubscription: () => {
      shouldDeferNextSubscription = true;
    },
    getLovelace: () => (panel as unknown as LovelacePanelInternals).lovelace!,
    hass,
    panel,
    setConfig: (newConfig) => {
      config = newConfig;
    },
    subscribeEvents: connection.subscribeEvents,
    subscriptions,
    deferNextConfig: () => {
      let resolve!: (value: LovelaceRawConfig) => void;
      let reject!: (error: unknown) => void;
      nextConfig = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { resolve, reject };
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
  it.each(["mode", "path"] as const)(
    "starts an authoritative fresh load after a mid-fetch %s change",
    async (kind) => {
      const mounted = await mountPanel();
      const stale = mounted.deferNextConfig();
      broadcastConnectionStatus("connected");
      await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
      mounted.setConfig({ views: [{ title: "Fresh context", cards: [] }] });
      mounted.panel.panel = {
        ...mounted.panel.panel!,
        ...(kind === "mode"
          ? { config: { mode: "yaml" as const } }
          : { url_path: "other-dashboard" }),
      };
      await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(3));
      await vi.waitFor(() =>
        expect(mounted.getLovelace().config.views[0].title).toBe(
          "Fresh context"
        )
      );
      stale.resolve({ views: [{ title: "Stale context", cards: [] }] });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(mounted.getLovelace().config.views[0].title).toBe("Fresh context");
      expect(mounted.getLovelace().mode).toBe(
        kind === "mode" ? "yaml" : "storage"
      );
      expect(mounted.getLovelace().urlPath).toBe(
        kind === "path" ? "other-dashboard" : "lovelace"
      );
      expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
      mounted.panel.panel = { ...mounted.panel.panel! };
      await mounted.panel.updateComplete;
      expect(mounted.configRequests).toHaveLength(3);
    }
  );

  it("reloads the initial request when its mode changes before any config is applied", async () => {
    let finishInitial!: (value: LovelaceRawConfig) => void;
    const initial = new Promise<LovelaceRawConfig>((resolve) => {
      finishInitial = resolve;
    });
    const mounted = await mountPanel(defaultConfig, "storage", initial);
    mounted.setConfig({ views: [{ title: "Initial YAML", cards: [] }] });
    mounted.panel.panel = { ...mounted.panel.panel!, config: { mode: "yaml" } };
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    await vi.waitFor(() => expect(mounted.getLovelace()?.mode).toBe("yaml"));
    finishInitial(cloneConfig(defaultConfig));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mounted.getLovelace().config.views[0].title).toBe("Initial YAML");
    expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
  });

  it("loads a changed mode while the previous context is showing a fetch error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mounted = await mountPanel();
    const failed = mounted.deferNextConfig();
    broadcastConnectionStatus("connected");
    failed.reject(new Error("old context unavailable"));
    await vi.waitFor(() =>
      expect(Reflect.get(mounted.panel, "_panelState")).toBe("error")
    );
    mounted.setConfig({ views: [{ title: "Recovered context", cards: [] }] });
    mounted.panel.panel = { ...mounted.panel.panel!, config: { mode: "yaml" } };
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe(
        "Recovered context"
      )
    );
    expect(Reflect.get(mounted.panel, "_panelState")).toBe("loaded");
    expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
  });

  it("defers a detached mode change until reattachment, then fetches it", async () => {
    const mounted = await mountPanel();
    mounted.panel.remove();
    mounted.panel.panel = { ...mounted.panel.panel!, config: { mode: "yaml" } };
    await mounted.panel.updateComplete;
    expect(mounted.configRequests).toHaveLength(1);
    mounted.setConfig({ views: [{ title: "Detached context", cards: [] }] });
    document.body.append(mounted.panel);
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe(
        "Detached context"
      )
    );
    expect(mounted.getLovelace().mode).toBe("yaml");
    expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
  });

  it("does not latch loading when panel metadata disappears during a fetch", async () => {
    const mounted = await mountPanel();
    const panelInfo = mounted.panel.panel!;
    const stale = mounted.deferNextConfig();
    broadcastConnectionStatus("connected");
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    mounted.panel.panel = undefined;
    await mounted.panel.updateComplete;
    expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
    stale.resolve(cloneConfig(defaultConfig));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    mounted.setConfig({ views: [{ title: "Restored metadata", cards: [] }] });
    mounted.panel.panel = { ...panelInfo, config: { mode: "yaml" } };
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe(
        "Restored metadata"
      )
    );
    expect(mounted.configRequests).toHaveLength(3);
    expect(Reflect.get(mounted.panel, "_loading")).toBe(false);
  });

  it.each(["lovelace", "secondary-dashboard", "future-dashboard"])(
    "preserves an unchanged storage dashboard at %s",
    async (urlPath) => {
      const mounted = await mountPanel(defaultConfig, "storage", undefined, {
        urlPath,
      });
      const lovelace = mounted.getLovelace();

      await reconnect(mounted);

      expect(mounted.getLovelace()).toBe(lovelace);
      expect(mounted.configRequests[1]).toMatchObject({
        type: "lovelace/config",
        force: false,
        url_path: urlPath,
      });
    }
  );

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

  it("preserves an unchanged dashboard with an empty views array", async () => {
    const mounted = await mountPanel({ views: [] });
    const lovelace = mounted.getLovelace();

    await reconnect(mounted);

    expect(mounted.getLovelace()).toBe(lovelace);
  });

  it.each([
    [
      "multiple views",
      {
        views: [
          {
            title: "Home",
            cards: [
              { type: "markdown", content: "First" },
              { type: "button", entity: "light.kitchen" },
            ],
          },
          {
            title: "Second",
            cards: [{ type: "entities", entities: ["sun.sun"] }],
          },
        ],
      },
    ],
    [
      "a panel view",
      {
        views: [
          {
            title: "Panel",
            type: "panel",
            cards: [{ type: "markdown", content: "Panel content" }],
          },
        ],
      },
    ],
    [
      "badges and header and footer cards",
      {
        views: [
          {
            title: "Decorated",
            badges: ["sun.sun"],
            cards: [{ type: "markdown", content: "Body" }],
            header: { card: { type: "markdown", content: "Header" } },
            footer: { card: { type: "markdown", content: "Footer" } },
          },
        ],
      },
    ],
    [
      "sections and sidebar sections",
      {
        views: [
          {
            title: "Sections",
            type: "sections",
            sections: [
              {
                type: "grid",
                cards: [{ type: "markdown", content: "Main section" }],
              },
            ],
            sidebar: {
              sections: [
                {
                  type: "grid",
                  cards: [{ type: "markdown", content: "Sidebar" }],
                },
              ],
            },
          },
        ],
      },
    ],
  ] satisfies [string, LovelaceRawConfig][])(
    "preserves unchanged static config with %s",
    async (_name, config) => {
      const mounted = await mountPanel(config);
      const lovelace = mounted.getLovelace();

      await reconnect(mounted);

      expect(mounted.getLovelace()).toBe(lovelace);
    }
  );

  it("preserves ordinary content regardless of dashboard URL path", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      urlPath: "secondary-dashboard",
    });
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

  it.each(["resolve", "reject"] as const)(
    "retains newer detached work when catch-up A completes with %s",
    async (outcome) => {
      const mounted = await mountPanel();
      const notify = () =>
        (Reflect.get(mounted.panel, "_lovelaceChanged") as () => void).call(
          mounted.panel
        );
      mounted.panel.remove();
      notify();
      const pending = mounted.deferNextConfig();
      document.body.append(mounted.panel);
      await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
      mounted.panel.remove();
      notify();
      if (outcome === "resolve") {
        pending.resolve(cloneConfig(defaultConfig));
      } else {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        pending.reject(new Error("catch-up failed"));
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      mounted.setConfig({ views: [{ title: "Newest", cards: [] }] });
      document.body.append(mounted.panel);
      await vi.waitFor(() =>
        expect(mounted.getLovelace().config.views[0].title).toBe("Newest")
      );
      expect(mounted.configRequests).toHaveLength(3);
      mounted.panel.remove();
      document.body.append(mounted.panel);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(mounted.configRequests).toHaveLength(3);
    }
  );

  it("fetches pending changes even when reattachment also changes locale", async () => {
    const mounted = await mountPanel();
    mounted.panel.remove();
    (Reflect.get(mounted.panel, "_lovelaceChanged") as () => void).call(
      mounted.panel
    );
    mounted.panel.hass = {
      ...mounted.hass,
      locale: { language: "fr" },
    } as HomeAssistant;
    mounted.setConfig({ views: [{ title: "Updated while away", cards: [] }] });
    document.body.append(mounted.panel);
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe(
        "Updated while away"
      )
    );
    expect(mounted.configRequests).toHaveLength(2);
  });

  it("does not apply an older fetch after a newer update has completed", async () => {
    const mounted = await mountPanel();
    const pending = mounted.deferNextConfig();
    broadcastConnectionStatus("connected");
    await vi.waitFor(() => expect(mounted.configRequests).toHaveLength(2));
    mounted.setConfig({ views: [{ title: "Latest", cards: [] }] });
    (Reflect.get(mounted.panel, "_lovelaceChanged") as () => void).call(
      mounted.panel
    );
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe("Latest")
    );
    pending.resolve({ views: [{ title: "Stale", cards: [] }] });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mounted.getLovelace().config.views[0].title).toBe("Latest");
  });

  it("keeps the cached main panel subscribed across reattachment", async () => {
    const mounted = await mountPanel();
    mounted.panel.remove();
    document.body.append(mounted.panel);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mounted.subscribeEvents).toHaveBeenCalledOnce();
    expect(mounted.subscriptions[0].unsubscribe).not.toHaveBeenCalled();
    mounted.setConfig({ views: [{ title: "Live update", cards: [] }] });
    mounted.subscriptions[0].callback({
      data: { url_path: "lovelace", mode: "storage" },
    });
    await vi.waitFor(() =>
      expect(mounted.getLovelace().config.views[0].title).toBe("Live update")
    );
  });

  it("unsubscribes a non-main dashboard once on detach", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      urlPath: "dashboard-one",
    });

    mounted.panel.remove();
    await vi.waitFor(() =>
      expect(mounted.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    );

    expect(mounted.subscriptions).toHaveLength(1);
  });

  it("creates one fresh subscription when a dashboard is reattached", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      urlPath: "dashboard-one",
    });

    mounted.panel.remove();
    await vi.waitFor(() =>
      expect(mounted.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    );
    document.body.append(mounted.panel);
    await vi.waitFor(() => expect(mounted.subscriptions).toHaveLength(2));

    expect(mounted.subscriptions[0].urlPath).toBe("dashboard-one");
    expect(mounted.subscriptions[1].urlPath).toBe("dashboard-one");
    expect(mounted.subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("replaces a URL subscription without cleaning up its replacement", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      urlPath: "dashboard-one",
    });

    mounted.panel.panel = {
      ...mounted.panel.panel!,
      url_path: "dashboard-two",
    };
    await vi.waitFor(() => expect(mounted.subscriptions).toHaveLength(2));

    expect(mounted.subscriptions[0].urlPath).toBe("dashboard-one");
    expect(mounted.subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(mounted.subscriptions[1].urlPath).toBe("dashboard-two");
    expect(mounted.subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("cleans up only an old subscription acknowledged after replacement", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      deferInitialSubscription: true,
      urlPath: "dashboard-one",
    });

    mounted.panel.panel = {
      ...mounted.panel.panel!,
      url_path: "dashboard-two",
    };
    await vi.waitFor(() => expect(mounted.subscriptions).toHaveLength(2));
    mounted.subscriptions[0].resolve?.();
    await vi.waitFor(() =>
      expect(mounted.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    );

    expect(mounted.subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("does not let delayed detach cleanup corrupt a reattached subscription", async () => {
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      deferInitialSubscription: true,
      urlPath: "dashboard-one",
    });

    mounted.panel.remove();
    document.body.append(mounted.panel);
    await vi.waitFor(() => expect(mounted.subscriptions).toHaveLength(2));
    mounted.subscriptions[0].resolve?.();
    await vi.waitFor(() =>
      expect(mounted.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    );

    expect(mounted.subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("logs rejected cleanup without corrupting current subscription ownership", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const mounted = await mountPanel(defaultConfig, "storage", undefined, {
      deferInitialSubscription: true,
      urlPath: "dashboard-one",
    });

    mounted.panel.panel = {
      ...mounted.panel.panel!,
      url_path: "dashboard-two",
    };
    await vi.waitFor(() => expect(mounted.subscriptions).toHaveLength(2));
    mounted.subscriptions[0].reject?.(new Error("subscription failed"));
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to unsubscribe Lovelace updates",
        expect.any(Error)
      )
    );

    expect(mounted.subscriptions[1].unsubscribe).not.toHaveBeenCalled();
  });

  it("does not preserve the configuration for a different URL path", async () => {
    const mounted = await mountPanel();
    const previous = mounted.getLovelace();
    mounted.panel.panel = {
      ...mounted.panel.panel!,
      url_path: "other-dashboard",
    };
    await reconnect(mounted);
    expect(mounted.getLovelace()).not.toBe(previous);
    expect(mounted.getLovelace().urlPath).toBe("other-dashboard");
    expect(mounted.configRequests[1].url_path).toBe("other-dashboard");
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
    [
      "sidebar section",
      {
        views: [
          {
            type: "sections",
            sidebar: { sections: [sidebarStrategy] },
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
