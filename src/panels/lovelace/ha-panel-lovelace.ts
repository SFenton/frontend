import deepFreeze from "deep-freeze";
import type { UnsubscribeFunc } from "home-assistant-js-websocket";
import type { PropertyValues, TemplateResult } from "lit";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators";
import memoizeOne from "memoize-one";
import type { HASSDomEvent } from "../../common/dom/fire_event";
import { navigate, replaceCurrentUrl } from "../../common/navigate";
import type { LocalizeFunc } from "../../common/translations/localize";
import { constructUrlCurrentPath } from "../../common/url/construct-url";
import {
  addSearchParam,
  removeSearchParam,
} from "../../common/url/search-params";
import { debounce } from "../../common/util/debounce";
import { deepEqual } from "../../common/util/deep-equal";
import "../../components/ha-button";
import type { ConnectionStatus } from "../../data/connection-status";
import { domainToName } from "../../data/integration";
import { subscribeLovelaceUpdates } from "../../data/lovelace";
import { isStrategySection } from "../../data/lovelace/config/section";
import type {
  LovelaceConfig,
  LovelaceRawConfig,
} from "../../data/lovelace/config/types";
import {
  fetchConfig,
  isStrategyDashboard,
  saveConfig,
} from "../../data/lovelace/config/types";
import { isStrategyView } from "../../data/lovelace/config/view";
import { fetchResources } from "../../data/lovelace/resource";
import type { WindowWithPreloads } from "../../data/preloads";
import "../../layouts/hass-error-screen";
import "../../layouts/hass-loading-screen";
import type { ShowToastParams } from "../../managers/notification-manager";
import type { HomeAssistant, PanelInfo, Route } from "../../types";
import { showToast } from "../../util/toast";
import { checkLovelaceConfig } from "./common/check-lovelace-config";
import { loadLovelaceResources } from "./common/load-resources";
import { showSaveDialog } from "./editor/show-save-config-dialog";
import "./hui-root";
import {
  checkStrategyShouldRegenerate,
  generateLovelaceDashboardStrategy,
} from "./strategies/get-strategy";
import type { Lovelace } from "./types";
import { generateDefaultView } from "./views/default-view";
import { fetchDashboards } from "../../data/lovelace/dashboard";

(window as any).loadCardHelpers = () => import("./custom-card-helpers");

interface LovelacePanelConfig {
  mode: "yaml" | "storage";
}

interface FetchConfigOptions {
  preserveIfUnchanged?: boolean;
}

const EXTERNALLY_UPDATED_TOAST_ID = "lovelace-externally-updated";

let editorLoaded = false;
let resourcesLoaded = false;

const hasStrategy = (config: LovelaceRawConfig): boolean =>
  isStrategyDashboard(config) ||
  (config.views?.some(
    (view) =>
      isStrategyView(view) ||
      Boolean(view.sections?.some((section) => isStrategySection(section))) ||
      Boolean(
        view.sidebar?.sections?.some((section) => isStrategySection(section))
      )
  ) ??
    false);

@customElement("ha-panel-lovelace")
export class LovelacePanel extends LitElement {
  @property({ attribute: false }) public panel?: PanelInfo<
    LovelacePanelConfig | undefined
  >;

  @property({ attribute: false }) public hass?: HomeAssistant;

  @property({ type: Boolean }) public narrow = false;

  @property({ attribute: false }) public route?: Route;

  @state() private _panelState: "loading" | "loaded" | "error" | "yaml-editor" =
    "loading";

  @state() private _errorMsg?: string;

  @state() private lovelace?: Lovelace;

  private _ignoreNextUpdateEvent = false;

  private _fetchConfigOnConnect = false;

  private _pendingUpdateVersion = 0;

  private _fetchGeneration = 0;

  private _fetchContext?: {
    urlPath: string | null;
    mode: LovelacePanelConfig["mode"] | undefined;
  };

  private _unsubUpdates?: Promise<UnsubscribeFunc>;

  private _updatesUrlPath?: string | null;

  private _loading = false;

  public connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated && this.panel && !this._unsubUpdates) {
      this._subscribeUpdates();
    }
    if (
      this.panel &&
      this.lovelace &&
      this.hass &&
      this.lovelace.locale !== this.hass.locale
    ) {
      // language has been changed, rebuild UI
      this._setLovelaceConfig(
        this.lovelace.config,
        this.lovelace.rawConfig,
        this.lovelace.mode
      );
    }
    if (this._fetchConfigOnConnect) {
      // Config was changed when we were not at the lovelace panel
      this._fetchConfig(false, {
        preserveIfUnchanged: true,
      });
    }
    window.addEventListener("connection-status", this._handleConnectionStatus);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    const urlPath = this.panel?.url_path;
    // On the main dashboard we want to stay subscribed as that one is cached.
    if (urlPath !== null && urlPath !== "lovelace" && this._unsubUpdates) {
      this._unsubscribeUpdates();
      this._markPendingUpdate();
    }
    // reload lovelace on reconnect so we are sure we have the latest config
    window.removeEventListener(
      "connection-status",
      this._handleConnectionStatus
    );
  }

  protected render(): TemplateResult | undefined {
    const panelState = this._panelState;

    if (panelState === "loaded") {
      return html`
        <hui-root
          .panel=${this.panel}
          .hass=${this.hass}
          .lovelace=${this.lovelace}
          .route=${this.route}
          .narrow=${this.narrow}
          @config-refresh=${this._forceFetchConfig}
        ></hui-root>
      `;
    }

    if (panelState === "error") {
      return html`
        <hass-error-screen
          .hass=${this.hass}
          title=${domainToName(this.hass!.localize, "lovelace")}
          .error=${this._errorMsg}
        >
          <ha-button @click=${this._forceFetchConfig}>
            ${this.hass!.localize("ui.panel.lovelace.reload_lovelace")}
          </ha-button>
        </hass-error-screen>
      `;
    }

    if (panelState === "yaml-editor") {
      return html`
        <hui-editor
          .narrow=${this.narrow}
          .hass=${this.hass}
          .lovelace=${this.lovelace}
          .closeEditor=${this._closeEditor}
        ></hui-editor>
      `;
    }

    return html`
      <hass-loading-screen
        rootnav
        .hass=${this.hass}
        .narrow=${this.narrow}
      ></hass-loading-screen>
    `;
  }

  protected willUpdate(changedProps: PropertyValues<this>) {
    super.willUpdate(changedProps);
    const previousPanel = changedProps.get("panel");
    if (
      this.hasUpdated &&
      changedProps.has("panel") &&
      (previousPanel?.url_path !== this.panel?.url_path ||
        previousPanel?.config?.mode !== this.panel?.config?.mode)
    ) {
      const alreadyFetchingContext =
        this._loading &&
        this._fetchContext?.urlPath === this.panel?.url_path &&
        this._fetchContext?.mode === this.panel?.config?.mode;
      if (!alreadyFetchingContext) {
        this._markPendingUpdate();
        if (this.isConnected) this._fetchConfig(false);
      }
      return;
    }
    if (!this.lovelace && this._panelState !== "error" && !this._loading) {
      this._fetchConfig(false);
    }
  }

  protected firstUpdated(changedProps: PropertyValues<this>): void {
    super.firstUpdated(changedProps);
    if (this.panel && !this._unsubUpdates) {
      this._subscribeUpdates();
    }
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    if (!changedProperties.has("hass")) {
      return;
    }

    const oldHass = changedProperties.get("hass") as HomeAssistant | undefined;
    if (
      oldHass &&
      this.hass &&
      this.lovelace &&
      isStrategyDashboard(this.lovelace.rawConfig)
    ) {
      if (
        this.hass.config.state === "RUNNING" &&
        (oldHass.config.state !== "RUNNING" ||
          checkStrategyShouldRegenerate(
            "dashboard",
            this.lovelace.rawConfig.strategy,
            oldHass,
            this.hass
          ))
      ) {
        this._debounceRegenerateStrategy();
      }
    }
  }

  private _debounceRegenerateStrategy = debounce(
    () => this._regenerateStrategyConfig(),
    200
  );

  private async _regenerateStrategyConfig() {
    if (!this.hass || !this.lovelace) {
      return;
    }

    const rawConf = this.lovelace.rawConfig;

    if (!isStrategyDashboard(rawConf)) {
      return;
    }

    try {
      const conf = await generateLovelaceDashboardStrategy(rawConf, this.hass!);
      this._setLovelaceConfig(conf, rawConf, "generated");
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  }

  private _handleConnectionStatus = (
    ev: HASSDomEvent<ConnectionStatus>
  ): void => {
    // reload lovelace on reconnect so we are sure we have the latest config
    if (ev.detail === "connected") {
      this._fetchConfig(false, { preserveIfUnchanged: true });
    }
  };

  private async _subscribeUpdates() {
    this._updatesUrlPath = this.urlPath;
    this._unsubUpdates = subscribeLovelaceUpdates(
      this.hass!.connection,
      this.urlPath,
      () => this._lovelaceChanged()
    );
  }

  private _unsubscribeUpdates(): void {
    const subscription = this._unsubUpdates;
    this._unsubUpdates = undefined;
    this._updatesUrlPath = undefined;
    subscription
      ?.then((unsubscribe) => unsubscribe())
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error("Failed to unsubscribe Lovelace updates", error);
      });
  }

  private _markPendingUpdate(): void {
    this._pendingUpdateVersion += 1;
    this._fetchConfigOnConnect = true;
  }

  private _closeEditor = () => {
    this._panelState = "loaded";
  };

  private _lovelaceChanged() {
    if (this._ignoreNextUpdateEvent) {
      this._ignoreNextUpdateEvent = false;
      return;
    }
    if (!this.isConnected) {
      // We can't fire events from an element that is not connected
      // Make sure we fetch the config as soon as the user goes back to Lovelace
      this._markPendingUpdate();
      return;
    }
    if (!this.lovelace?.editMode && this._panelState !== "yaml-editor") {
      this._fetchConfig(false);
      return;
    }
    showToast(this, {
      id: EXTERNALLY_UPDATED_TOAST_ID,
      message: this.hass!.localize(
        "ui.panel.lovelace.externally_updated_toast.message"
      ),
      action: {
        action: () => this._fetchConfig(false),
        text: this.hass!.localize("ui.common.refresh"),
      },
      duration: -1,
      dismissable: false,
    });
  }

  public get urlPath() {
    return this.panel!.url_path;
  }

  private _forceFetchConfig() {
    this._fetchConfig(true);
  }

  private async _fetchConfig(
    forceDiskRefresh: boolean,
    { preserveIfUnchanged = false }: FetchConfigOptions = {}
  ) {
    this._loading = true;
    const generation = ++this._fetchGeneration;
    const pendingVersion = this._pendingUpdateVersion;
    const panel = this.panel;
    if (!panel) {
      this._fetchContext = undefined;
      this._loading = false;
      return;
    }
    const urlPath = panel.url_path;

    let conf: LovelaceConfig;
    let rawConf: LovelaceRawConfig | undefined;
    const confMode = panel.config?.mode;
    this._fetchContext = { urlPath, mode: confMode };
    const isCurrent = () =>
      generation === this._fetchGeneration &&
      urlPath === this.panel?.url_path &&
      confMode === this.panel?.config?.mode;

    // If no mode, redirect to /home as there is no "lovelace" dashboard
    if (!confMode) {
      this._loading = false;
      navigate("/home", { replace: true });
      return;
    }
    if (
      this.hasUpdated &&
      this.isConnected &&
      this._updatesUrlPath !== urlPath
    ) {
      this._unsubscribeUpdates();
      this._subscribeUpdates();
    }

    let confProm: Promise<LovelaceRawConfig> | undefined;
    const preloadWindow = window as WindowWithPreloads;

    // On first load, we speed up loading page by having LL promise ready
    if (preloadWindow.llConfProm) {
      confProm = preloadWindow.llConfProm;
      preloadWindow.llConfProm = undefined;
    }
    if (!resourcesLoaded) {
      resourcesLoaded = true;
      (preloadWindow.llResProm || fetchResources(this.hass!.connection)).then(
        (resources) => loadLovelaceResources(resources, this.hass!)
      );
    }
    if (urlPath !== null || !confProm) {
      // Refreshing a YAML config can trigger an update event. We will ignore
      // all update events while fetching the config and for 2 seconds after the config is back.
      // We ignore because we already have the latest config.
      if (this.lovelace && this.lovelace.mode === "yaml") {
        this._ignoreNextUpdateEvent = true;
      }

      confProm = fetchConfig(this.hass!.connection, urlPath, forceDiskRefresh);
    }

    try {
      rawConf = await confProm;
      if (!isCurrent()) return;

      // If strategy defined, apply it here.
      if (isStrategyDashboard(rawConf)) {
        if (!this.hass?.entities || !this.hass.devices || !this.hass.areas) {
          // We need these to generate a dashboard, wait for them
          return;
        }
        conf = await generateLovelaceDashboardStrategy(rawConf, this.hass!);
      } else {
        conf = rawConf;
      }
    } catch (err: any) {
      if (!isCurrent()) return;
      if (err.code !== "config_not_found") {
        // eslint-disable-next-line
        console.log(err);
        this._panelState = "error";
        this._errorMsg = err.message;
        return;
      }

      // If there is no dashboard called "lovelace", redirect to /home
      if (urlPath === "lovelace") {
        const dashboards = await fetchDashboards(this.hass!);
        if (!isCurrent()) return;
        const dashboard = dashboards.find((d) => d.url_path === "lovelace");
        if (!dashboard) {
          navigate("/home", { replace: true });
          return;
        }
      }
      // Config not found, create a default one
      conf = this._generateDefaultConfig(this.hass!.localize);
      rawConf = conf;
    } finally {
      if (generation === this._fetchGeneration) {
        this._loading = false;
      }
      // Ignore updates for another 2 seconds.
      if (isCurrent() && this.lovelace && this.lovelace.mode === "yaml") {
        setTimeout(() => {
          this._ignoreNextUpdateEvent = false;
        }, 2000);
      }
    }

    if (!isCurrent()) return;
    this._panelState =
      this._panelState === "yaml-editor" ? this._panelState : "loaded";
    this._setLovelaceConfig(
      conf,
      rawConf,
      confMode,
      preserveIfUnchanged && !forceDiskRefresh
    );
    // A response acknowledges only notifications that preceded its request.
    if (pendingVersion === this._pendingUpdateVersion) {
      this._fetchConfigOnConnect = false;
    }
  }

  private _checkLovelaceConfig(config: LovelaceRawConfig) {
    const checkedConfig = checkLovelaceConfig(config);
    return deepFreeze(checkedConfig);
  }

  private _setLovelaceConfig(
    config: LovelaceConfig,
    rawConfig: LovelaceRawConfig,
    mode: Lovelace["mode"],
    preserveIfUnchanged = false
  ) {
    config = this._checkLovelaceConfig(config);
    // A reconnect returns fresh objects even when the dashboard is unchanged.
    // Keep static dashboard trees mounted; strategies must regenerate.
    if (
      preserveIfUnchanged &&
      this.lovelace &&
      this.lovelace.urlPath === this.urlPath &&
      this.lovelace.mode === mode &&
      this.lovelace.locale === this.hass!.locale &&
      !hasStrategy(rawConfig) &&
      deepEqual(this.lovelace.rawConfig, rawConfig) &&
      deepEqual(this.lovelace.config, config)
    ) {
      return;
    }
    const urlPath = this.urlPath;
    this.lovelace = {
      config,
      rawConfig,
      mode,
      urlPath: this.urlPath,
      editMode: this.lovelace ? this.lovelace.editMode : false,
      locale: this.hass!.locale,
      enableFullEditMode: () => {
        if (!editorLoaded) {
          editorLoaded = true;
          import("./hui-editor");
        }
        this._panelState = "yaml-editor";
      },
      setEditMode: (editMode: boolean) => {
        // If the dashboard is generated (default dashboard)
        // Propose to take control of it
        if (
          this.lovelace!.mode === "generated" &&
          editMode &&
          this.panel?.config
        ) {
          showSaveDialog(this, {
            lovelace: this.lovelace!,
            mode: this.panel!.config.mode,
            narrow: this.narrow!,
          });
          return;
        }

        // If we use a strategy for dashboard, we cannot show the edit UI
        // So go straight to the YAML editor
        if (isStrategyDashboard(this.lovelace!.rawConfig) && editMode) {
          this.lovelace!.enableFullEditMode();
          return;
        }

        this._updateLovelace({ editMode });
      },
      saveConfig: async (newConfig: LovelaceRawConfig): Promise<void> => {
        const {
          config: previousConfig,
          rawConfig: previousRawConfig,
          mode: previousMode,
        } = this.lovelace!;
        newConfig = this._checkLovelaceConfig(newConfig);
        let conf: LovelaceConfig;
        // If strategy defined, apply it here.
        if (isStrategyDashboard(newConfig)) {
          conf = await generateLovelaceDashboardStrategy(newConfig, this.hass!);
        } else {
          conf = newConfig;
        }
        try {
          // Optimistic update
          this._updateLovelace({
            config: conf,
            rawConfig: newConfig,
            mode: "storage",
          });
          this._ignoreNextUpdateEvent = true;
          await saveConfig(this.hass!, urlPath, newConfig);
        } catch (err: any) {
          // eslint-disable-next-line
          console.error(err);
          // Rollback the optimistic update
          this._updateLovelace({
            config: previousConfig,
            rawConfig: previousRawConfig,
            mode: previousMode,
          });
          throw err;
        }
      },
      deleteConfig: async (): Promise<void> => {
        const {
          config: previousConfig,
          rawConfig: previousRawConfig,
          mode: previousMode,
        } = this.lovelace!;
        try {
          const defaultConfig = this._generateDefaultConfig(
            this.hass!.localize
          );
          // Optimistic update
          this._updateLovelace({
            config: defaultConfig,
            rawConfig: defaultConfig,
            mode: "storage",
          });
          this._ignoreNextUpdateEvent = true;
          await saveConfig(this.hass!, urlPath, defaultConfig);
        } catch (err: any) {
          // eslint-disable-next-line
          console.error(err);
          // Rollback the optimistic update
          this._updateLovelace({
            config: previousConfig,
            rawConfig: previousRawConfig,
            mode: previousMode,
          });
          throw err;
        }
      },
      showToast: (params: ShowToastParams) => showToast(this, params),
    };
  }

  private _generateDefaultConfig = memoizeOne(
    (localize: LocalizeFunc): LovelaceConfig => ({
      views: [generateDefaultView(localize, true)],
    })
  );

  private _updateLovelace(props: Partial<Lovelace>) {
    this.lovelace = {
      ...this.lovelace!,
      ...props,
    };

    if ("editMode" in props) {
      replaceCurrentUrl(
        constructUrlCurrentPath(
          props.editMode
            ? addSearchParam({ edit: "1" })
            : removeSearchParam("edit")
        )
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-lovelace": LovelacePanel;
  }
}
