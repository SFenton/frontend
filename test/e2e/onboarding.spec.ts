import { expect, test } from "@playwright/test";
import { demoConfig } from "../../src/fake_data/demo_config";
import {
  completeAnalytics,
  completeCoreConfig,
  createOwner,
  expectDefaultDashboard,
  finishIntegrations,
  onboardingData,
  openOnboarding,
  setupOnboardingMocks,
} from "./app/src/onboarding";
import { expectNoPageErrors, PANEL_TIMEOUT, trackPageErrors } from "./helpers";

test.use({ serviceWorkers: "block" });

test("completes onboarding and opens the default dashboard", async ({
  page,
  baseURL,
}) => {
  const errors = trackPageErrors(page);
  const calls = await setupOnboardingMocks(page);

  await test.step("welcome", () => openOnboarding(page, baseURL!));
  await test.step("create account", () => createOwner(page));
  await test.step("configure Home Assistant", () => completeCoreConfig(page));
  await test.step("choose analytics", () => completeAnalytics(page));
  await test.step("finish integrations", () => finishIntegrations(page));
  await test.step("open default dashboard", () => expectDefaultDashboard(page));

  expect(calls.user).toMatchObject(onboardingData.user);
  expect(calls.coreConfig).toMatchObject({
    type: "config/core/update",
    latitude: onboardingData.location.latitude,
    longitude: onboardingData.location.longitude,
    elevation: onboardingData.location.elevation,
    unit_system: onboardingData.location.unitSystem,
    time_zone: onboardingData.location.timeZone,
    currency: onboardingData.location.currency,
    country: onboardingData.location.country,
  });
  expect(calls.coreConfigCompleted).toBe(true);
  expect(calls.analyticsPreferences).toMatchObject({
    type: "analytics/preferences",
    preferences: {},
  });
  expect(calls.analyticsCompleted).toBe(true);
  expect(calls.systemData).toMatchObject({
    type: "frontend/set_system_data",
    key: "core",
    value: {
      onboarded_version: demoConfig.version,
      onboarded_date: expect.any(String),
    },
  });
  expect(calls.integration).toMatchObject({
    client_id: expect.any(String),
    redirect_uri: expect.stringContaining("/dashboard.html?auth_callback=1"),
  });
  expect(calls.tokenRequests).toHaveLength(2);
  expect(calls.tokenRequests[1]).toContain("dashboard-auth-code");
  expectNoPageErrors(errors);
});

test("preserves static Lovelace DOM across a real WebSocket replacement", async ({
  page,
  baseURL,
}) => {
  const errors = trackPageErrors(page);
  const urlPath = "reconnect-test";
  const iframeConfig = (version: number) => ({
    views: [
      {
        title: "Reconnect test",
        cards: [
          {
            type: "iframe",
            url: `/test-stateful-iframe.html?version=${version}`,
            aspect_ratio: "100%",
          },
        ],
      },
    ],
  });
  const controller = await setupOnboardingMocks(page, {
    lovelaceDashboard: {
      config: iframeConfig(1),
      urlPath,
    },
  });

  await openOnboarding(page, baseURL!);
  await createOwner(page);
  await completeCoreConfig(page);
  await completeAnalytics(page);
  await finishIntegrations(page);
  await expectDefaultDashboard(page);
  const dashboardLink = page.locator(`a[href="/${urlPath}"]`);
  await expect(dashboardLink).toBeAttached({ timeout: PANEL_TIMEOUT });
  await dashboardLink.evaluate((element) => (element as HTMLElement).click());
  await expect(page).toHaveURL(new RegExp(`/${urlPath}(?:/0)?$`));

  const iframe = page.locator("hui-iframe-card iframe").first();
  const frameInput = page
    .frameLocator("hui-iframe-card iframe")
    .locator("#preserved-value");
  await expect(iframe).toBeAttached({ timeout: PANEL_TIMEOUT });
  await expect(frameInput).toBeVisible({ timeout: PANEL_TIMEOUT });
  await expect
    .poll(() => controller.getLovelaceConfigRequestCount(urlPath))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__reconnectIframeLoads))
    .toBe(1);

  await frameInput.fill("survives transport reconnect");
  const originalIframe = await iframe.elementHandle();
  const originalWindow = await originalIframe!.evaluateHandle(
    (element) => (element as HTMLIFrameElement).contentWindow
  );
  const originalTimeOrigin = await frameInput.evaluate(
    () => performance.timeOrigin
  );
  const initialSocketCount = controller.getSocketCount();
  const initialAuthenticatedCount = controller.getAuthenticatedSocketCount();
  const initialLovelaceSubscriptionCount =
    controller.getLovelaceSubscriptionCount();
  expect(initialLovelaceSubscriptionCount).toBeGreaterThan(0);

  await controller.closeActiveSocket();
  await expect
    .poll(() => controller.getSocketCount(), { timeout: 30_000 })
    .toBe(initialSocketCount + 1);
  await expect
    .poll(() => controller.getAuthenticatedSocketCount(), { timeout: 30_000 })
    .toBe(initialAuthenticatedCount + 1);
  await expect
    .poll(() => controller.getLovelaceConfigRequestCount(urlPath), {
      timeout: 30_000,
    })
    .toBe(2);
  await page.waitForTimeout(250);
  expect(controller.getLovelaceConfigRequestCount(urlPath)).toBe(2);
  await expect
    .poll(() => controller.getLovelaceSubscriptionCount())
    .toBe(initialLovelaceSubscriptionCount);

  await expect(frameInput).toHaveValue("survives transport reconnect");
  expect(await frameInput.evaluate(() => performance.timeOrigin)).toBe(
    originalTimeOrigin
  );
  expect(await page.evaluate(() => window.__reconnectIframeLoads)).toBe(1);
  expect(
    await iframe.evaluate(
      (element, original) => element === original,
      originalIframe
    )
  ).toBe(true);
  expect(
    await iframe.evaluate(
      (element, original) =>
        (element as HTMLIFrameElement).contentWindow === original,
      originalWindow
    )
  ).toBe(true);

  controller.setLovelaceConfig(urlPath, iframeConfig(2));
  controller.sendLovelaceUpdated(urlPath);
  await expect
    .poll(() => controller.getLovelaceConfigRequestCount(urlPath))
    .toBe(3);
  await expect(frameInput).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => window.__reconnectIframeLoads))
    .toBe(2);
  expect(
    await iframe.evaluate(
      (element, original) => element !== original,
      originalIframe
    )
  ).toBe(true);
  expect(await frameInput.evaluate(() => performance.timeOrigin)).not.toBe(
    originalTimeOrigin
  );
  await originalWindow.dispose();
  await originalIframe?.dispose();
  await originalIframe?.dispose();
  expectNoPageErrors(errors);
});

test("chooses analytics consent using named switches", async ({
  page,
  baseURL,
}) => {
  const errors = trackPageErrors(page);
  const calls = await setupOnboardingMocks(page);

  await openOnboarding(page, baseURL!);
  await createOwner(page);
  await completeCoreConfig(page);

  const analytics = page.locator("onboarding-analytics");
  const basic = analytics.getByRole("switch", {
    name: "Basic analytics",
    exact: true,
  });
  const usage = analytics.getByRole("switch", { name: "Usage", exact: true });
  const statistics = analytics.getByRole("switch", {
    name: "Statistical data",
    exact: true,
  });
  const diagnostics = analytics.getByRole("switch", {
    name: "Diagnostics",
    exact: true,
  });

  await expect(basic).toBeVisible();
  await basic.press("Space");
  await usage.press("Space");
  await statistics.press("Space");
  await diagnostics.press("Space");
  await expect(usage).toBeChecked();
  await expect(statistics).toBeChecked();
  await expect(diagnostics).toBeChecked();

  // Withdrawing basic consent also withdraws its dependent categories,
  // while independently selected crash reporting stays enabled.
  await basic.press("Space");
  await expect(usage).not.toBeChecked();
  await expect(statistics).not.toBeChecked();
  await expect(diagnostics).toBeChecked();
  await completeAnalytics(page);
  await expect.poll(() => calls.analyticsCompleted).toBe(true);

  expect(calls.analyticsPreferences).toMatchObject({
    type: "analytics/preferences",
    preferences: {
      base: false,
      usage: false,
      statistics: false,
      diagnostics: true,
    },
  });
  expectNoPageErrors(errors);
});
