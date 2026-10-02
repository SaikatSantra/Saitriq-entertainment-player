import { useLoaderData, useFetcher, data } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Divider,
  Badge,
  Banner,
  Toast,
  Select,
  TextField,
  SettingToggle,
  Box,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useCallback, useEffect } from "react";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  widget_enabled:  "true",
  widget_position: "bottom-left",
  widget_title:    "Now Playing",
  autoplay:        "false",
  loop_playlist:   "true",
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const rows = await prisma.appSettings.findMany({ where: { shop } });
  const settings = { ...DEFAULTS };
  rows.forEach((r) => { settings[r.key] = r.value; });
  return data({ settings, shop });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "saveSettings") {
    const keys = Object.keys(DEFAULTS);
    await Promise.all(
      keys.map((key) => {
        const value = formData.get(key) ?? DEFAULTS[key];
        return prisma.appSettings.upsert({
          where: { shop_key: { shop, key } },
          update: { value },
          create: { shop, key, value },
        });
      }),
    );
    return data({ success: true });
  }

  return data({ success: false, error: "Unknown intent" }, { status: 400 });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { settings: loaded } = useLoaderData();
  const fetcher = useFetcher();

  const [settings, setSettings] = useState(loaded);
  const [toastActive, setToastActive] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setToastActive(true);
      setDirty(false);
    }
  }, [fetcher.state, fetcher.data]);

  const update = useCallback((key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "saveSettings");
    Object.entries(settings).forEach(([k, v]) => fd.append(k, v));
    fetcher.submit(fd, { method: "POST" });
  }, [settings, fetcher]);

  const isSaving = fetcher.state !== "idle";
  const widgetEnabled = settings.widget_enabled === "true";

  return (
    <Page
      title="Widget settings"
      subtitle="Control how the playlist widget appears on your storefront"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={
        <Button
          variant="primary"
          onClick={handleSave}
          loading={isSaving}
          disabled={!dirty || isSaving}
        >
          Save settings
        </Button>
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">

            {/* ── Widget on/off ────────────────────────────────────────── */}
            <SettingToggle
              action={{
                content: widgetEnabled ? "Disable widget" : "Enable widget",
                onAction: () =>
                  update("widget_enabled", widgetEnabled ? "false" : "true"),
                tone: widgetEnabled ? "critical" : undefined,
              }}
              enabled={widgetEnabled}
            >
              <Text variant="headingSm" fontWeight="semibold" as="h3">
                Storefront widget
              </Text>
              <Box paddingBlockStart="100">
                <Text variant="bodySm" tone="subdued">
                  {widgetEnabled
                    ? "The floating playlist widget is currently visible on your storefront."
                    : "The widget is hidden. Enable it to show the playlist on your storefront."}
                </Text>
              </Box>
            </SettingToggle>

            {/* ── Appearance ───────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" fontWeight="semibold">
                  Appearance
                </Text>
                <Divider />
                <TextField
                  label="Widget title"
                  value={settings.widget_title}
                  onChange={(v) => update("widget_title", v)}
                  autoComplete="off"
                  helpText="Displayed in the widget header on your storefront."
                  maxLength={40}
                  showCharacterCount
                />
                <Select
                  label="Widget position"
                  options={[
                    { label: "Bottom left (default)", value: "bottom-left" },
                    { label: "Bottom right",          value: "bottom-right" },
                    { label: "Top left",              value: "top-left" },
                    { label: "Top right",             value: "top-right" },
                  ]}
                  value={settings.widget_position}
                  onChange={(v) => update("widget_position", v)}
                  helpText="Corner of the screen where the widget will appear."
                />
              </BlockStack>
            </Card>

            {/* ── Playback ─────────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" fontWeight="semibold">
                  Playback behaviour
                </Text>
                <Divider />
                <Select
                  label="Autoplay"
                  options={[
                    { label: "Off — wait for visitor to press play", value: "false" },
                    { label: "On — start playing when the page loads", value: "true" },
                  ]}
                  value={settings.autoplay}
                  onChange={(v) => update("autoplay", v)}
                  helpText="Autoplay is always muted to comply with browser autoplay policies."
                />
                <Select
                  label="Loop playlist"
                  options={[
                    { label: "Yes — go back to the first track after the last", value: "true" },
                    { label: "No — stop after the last track",                  value: "false" },
                  ]}
                  value={settings.loop_playlist}
                  onChange={(v) => update("loop_playlist", v)}
                />
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">

            <Banner tone="info" title="Theme Customizer">
              You can also toggle this widget inside the Shopify Theme
              Customizer under <strong>App Embeds → Audio &amp; Video
              Playlist</strong>. Theme Customizer settings take precedence.
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">
                  Current configuration
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Widget</Text>
                    <Badge tone={widgetEnabled ? "success" : "critical"}>
                      {widgetEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Position</Text>
                    <Text variant="bodySm">{settings.widget_position}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Autoplay</Text>
                    <Text variant="bodySm">
                      {settings.autoplay === "true" ? "On" : "Off"}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Loop</Text>
                    <Text variant="bodySm">
                      {settings.loop_playlist === "true" ? "Yes" : "No"}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>

      {toastActive && (
        <Toast
          content="Settings saved"
          onDismiss={() => setToastActive(false)}
          duration={3000}
        />
      )}
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
