import { useLoaderData, data } from "react-router";
import {
  Page, Layout, Card, Text, Badge, Button,
  BlockStack, InlineStack, Divider, Box, Banner, Icon,
} from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopPlanStatus, getPlanDetails } from "../billing.server";

// ─── Loader — single round-trip ───────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const pricingReturnPlanHandle = url.searchParams.get("plan_handle");
  const pricingReturn = Boolean(pricingReturnPlanHandle);

  const [mediaSummary, widgetSetting, planStatus, recentItems] = await Promise.all([
    prisma.playlistMedia.groupBy({
      by: ["mediaType", "isActive"],
      where: { shop },
      _count: true,
    }),
    prisma.appSettings.findUnique({
      where: { shop_key: { shop, key: "widget_enabled" } },
      select: { value: true },
    }),
    getShopPlanStatus(shop, prisma, admin, { forceRefresh: pricingReturn }),
    prisma.playlistMedia.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, title: true, mediaType: true, isActive: true },
    }),
  ]);

  let totalMedia = 0, activeMedia = 0, audioCount = 0, videoCount = 0;
  for (const row of mediaSummary) {
    totalMedia  += row._count;
    if (row.isActive)              activeMedia += row._count;
    if (row.mediaType === "audio") audioCount  += row._count;
    if (row.mediaType === "video") videoCount  += row._count;
  }

  const widgetEnabled = widgetSetting ? widgetSetting.value === "true" : true;
  const plan          = getPlanDetails(planStatus.record);

  return data({
    shop,
    stats: { totalMedia, activeMedia, audioCount, videoCount },
    widgetEnabled,
    recentItems,
    billingVerified: planStatus.verified,
    billingStatusReason: planStatus.reason,
    pricingReturnPlanHandle,
    // Infinity → null for JSON serialisation; component handles null as "unlimited"
    plan: { id: plan.id, name: plan.name, price: plan.price, limit: plan.limit === Infinity ? null : plan.limit },
  });
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ value, label, tone }) {
  return (
    <Box background="bg-surface-secondary" borderRadius="300" padding="400" minWidth="120px">
      <BlockStack gap="100" inlineAlign="center">
        <Text variant="heading2xl" as="p" tone={tone}>{value}</Text>
        <Text variant="bodySm" tone="subdued" alignment="center">{label}</Text>
      </BlockStack>
    </Box>
  );
}

function Step({ number, title, description, action }) {
  return (
    <InlineStack gap="400" blockAlign="start" wrap={false}>
      <Box
        background="bg-fill-brand"
        borderRadius="full"
        minWidth="28px"
        minHeight="28px"
        padding="100"
      >
        <Text variant="bodySm" fontWeight="bold" tone="text-inverse" alignment="center">
          {number}
        </Text>
      </Box>
      <BlockStack gap="100">
        <Text variant="bodyMd" fontWeight="semibold">{title}</Text>
        <Text variant="bodySm" tone="subdued">{description}</Text>
        {action && (
          <Box paddingBlockStart="100">
            <Button size="slim" url={action.url} variant={action.primary ? "primary" : "secondary"}>
              {action.label}
            </Button>
          </Box>
        )}
      </BlockStack>
    </InlineStack>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    shop,
    stats,
    widgetEnabled,
    recentItems,
    plan,
    billingVerified,
    billingStatusReason,
    pricingReturnPlanHandle,
  } = useLoaderData();
  const hasItems = stats.totalMedia > 0;
  // plan.limit is null for UNLIMITED (serialised from Infinity); null = no cap
  const atLimit  = plan.limit !== null && stats.totalMedia >= plan.limit;

  return (
    <Page
      title="Audio & Video Playlist"
      subtitle="Floating media playlist widget for your Shopify storefront"
      primaryAction={<Button variant="primary" url="/app/playlist">Manage Playlist</Button>}
      secondaryActions={[{ content: "Settings", url: "/app/settings" }]}
    >
      <Layout>

        {/* Widget status — Banner action uses onAction (not url) for Polaris v13 */}
        <Layout.Section>
          <Banner
            title={widgetEnabled ? "Widget is live on your storefront" : "Widget is currently disabled"}
            tone={widgetEnabled ? "success" : "warning"}
            action={
              !widgetEnabled
                ? { content: "Enable widget", onAction: () => { window.top.location.href = "/app/settings"; } }
                : undefined
            }
          >
            <BlockStack gap="200">
              <Text variant="bodySm">
                {widgetEnabled
                  ? "Customers can see and interact with the playlist widget right now."
                  : "Go to Settings or the Theme Customizer → App Embeds to turn it on."}
              </Text>
              {widgetEnabled && (
                <Button size="slim" url="/app/settings">Open settings</Button>
              )}
            </BlockStack>
          </Banner>
        </Layout.Section>

        {!billingVerified && (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Subscription status is not verified"
              action={{ content: "Review billing setup", url: "/app/billing" }}
            >
              <Text variant="bodySm">
                {billingStatusReason} The app applies temporary Free limits until it can verify
                the Shopify subscription.
                {pricingReturnPlanHandle && (
                  <> Shopify returned plan handle <code>{pricingReturnPlanHandle}</code>; this is not yet verified.</>
                )}
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Plan limit warning */}
        {atLimit && (
          <Layout.Section>
            <Banner
              tone="warning"
              title={
                billingVerified
                  ? `You've reached the ${plan.name} plan limit of ${plan.limit} item${plan.limit !== 1 ? "s" : ""}`
                  : `Temporary Free limit reached (${plan.limit} item${plan.limit !== 1 ? "s" : ""})`
              }
              action={{
                content: billingVerified ? "Upgrade plan" : "Retry billing verification",
                url: "/app/billing?pricing=unverified",
              }}
            >
              <Text variant="bodySm">
                Upgrade to Pro ($5/mo, 50 items) or Unlimited ($50/mo) to keep adding media.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Stats */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" fontWeight="semibold">Overview</Text>
              <Divider />
              <InlineStack gap="400" wrap>
                <StatCard value={stats.totalMedia}  label="Total items" />
                <StatCard value={stats.activeMedia} label="Active"       tone="success" />
                <StatCard value={stats.audioCount}  label="Audio"        tone="info" />
                <StatCard value={stats.videoCount}  label="Video"        tone="warning" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Getting started */}
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <InlineStack gap="200" blockAlign="center">
                <Icon source={QuestionCircleIcon} tone="base" />
                <Text variant="headingSm" fontWeight="semibold">Getting started</Text>
              </InlineStack>
              <Divider />
              <Step
                number="1"
                title="Add media items to your playlist"
                description="Paste YouTube, TikTok, Instagram, Facebook, or direct .mp4/.mp3 URLs — or upload files directly to Shopify Files."
                action={{ label: "Add media item", url: "/app/playlist", primary: true }}
              />
              <Step
                number="2"
                title="Enable the widget in your theme"
                description="Online Store → Themes → Customize → App Embeds → Audio & Video Playlist → toggle ON."
              />
              <Step
                number="3"
                title="Configure widget settings"
                description="Choose position, accent colour, and loop behaviour."
                action={{ label: "Open settings", url: "/app/settings" }}
              />
              <Step
                number="4"
                title="Reorder your playlist"
                description="Use ↑↓ on the Manage Playlist page to set the play order."
                action={{ label: "Manage playlist", url: "/app/playlist" }}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Recent additions */}
        {hasItems && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" fontWeight="semibold">Recent additions</Text>
                  <Button variant="plain" url="/app/playlist">View all</Button>
                </InlineStack>
                <Divider />
                <BlockStack gap="200">
                  {recentItems.map((item) => (
                    <Box key={item.id} background="bg-surface-secondary" borderRadius="200" padding="300">
                      <InlineStack align="space-between" blockAlign="center" gap="300">
                        <InlineStack gap="300" blockAlign="center">
                          <Badge tone={item.mediaType === "audio" ? "info" : "warning"}>
                            {item.mediaType === "audio" ? "Audio" : "Video"}
                          </Badge>
                          <Text variant="bodyMd" fontWeight="medium">{item.title}</Text>
                        </InlineStack>
                        <Badge tone={item.isActive ? "success" : "critical"}>
                          {item.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">

            {/* Current plan */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" fontWeight="semibold">Current plan</Text>
                  <Badge tone={!billingVerified ? "attention" : plan.id === "FREE" ? "info" : plan.id === "PRO" ? "warning" : "success"}>
                    {billingVerified ? plan.name : "Unverified"}
                  </Badge>
                </InlineStack>
                <Divider />
                <BlockStack gap="150">
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Media items used</Text>
                    <Text variant="bodySm" fontWeight="medium">
                      {stats.totalMedia} / {plan.limit === null ? "∞" : plan.limit}
                      {!billingVerified && " (temporary Free limit)"}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">Price</Text>
                    <Text variant="bodySm" fontWeight="medium">
                      {!billingVerified ? "Not verified" : plan.price === 0 ? "Free" : `$${plan.price}/mo`}
                    </Text>
                  </InlineStack>
                </BlockStack>
                {atLimit ? (
                  <Button variant="primary" url="/app/billing" fullWidth>Upgrade plan</Button>
                ) : (
                  <Button url="/app/billing" fullWidth>View plans</Button>
                )}
              </BlockStack>
            </Card>

            {/* Quick actions */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">Quick actions</Text>
                <Divider />
                <BlockStack gap="200">
                  <Button variant="primary" url="/app/playlist" fullWidth>+ Add media item</Button>
                  <Button url="/app/settings" fullWidth>Widget settings</Button>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Supported sources */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">Supported sources</Text>
                <Divider />
                <BlockStack gap="200">
                  <Text variant="bodySm" fontWeight="medium">Paste a URL:</Text>
                  <InlineStack gap="150" wrap>
                    {["YouTube", "TikTok", "Instagram", "Facebook", ".mp4", ".mp3"].map((s) => (
                      <Box key={s} background="bg-fill-secondary" borderRadius="200" paddingInline="200" paddingBlock="100">
                        <Text variant="bodySm" fontWeight="medium">{s}</Text>
                      </Box>
                    ))}
                  </InlineStack>
                  <Text variant="bodySm" fontWeight="medium">Upload a file:</Text>
                  <InlineStack gap="150" wrap>
                    {[".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg"].map((s) => (
                      <Box key={s} background="bg-fill-secondary" borderRadius="200" paddingInline="200" paddingBlock="100">
                        <Text variant="bodySm" fontWeight="medium">{s}</Text>
                      </Box>
                    ))}
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* How it works */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">How it works</Text>
                <Divider />
                <BlockStack gap="150">
                  {[
                    ["Floating widget", "Fixed button on every page — click to open."],
                    ["Auto-opens", "Opens on first visit; stays closed same session if dismissed."],
                    ["Plays unmuted", "Falls back to muted if browser policy blocks it."],
                    ["Card shuffle UI", "Stacked cards — swipe or use prev/next to browse."],
                  ].map(([title, desc]) => (
                    <Text key={title} variant="bodySm" tone="subdued">
                      <strong>{title}</strong> — {desc}
                    </Text>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Theme tip */}
            <Banner tone="info" title="Theme Customizer">
              Go to <strong>Online Store → Themes → Customize → App Embeds</strong>{" "}
              and toggle <strong>Audio &amp; Video Playlist</strong> on.
            </Banner>

            {/* Store */}
            <Card>
              <BlockStack gap="100">
                <Text variant="headingSm" fontWeight="semibold">Connected store</Text>
                <Text variant="bodySm" tone="subdued">{shop}</Text>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
