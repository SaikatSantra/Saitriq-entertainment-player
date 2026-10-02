import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Divider,
  Box,
  List,
  Banner,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [totalMedia, activeMedia, audioCount, videoCount, widgetEnabled] =
    await Promise.all([
      prisma.playlistMedia.count({ where: { shop } }),
      prisma.playlistMedia.count({ where: { shop, isActive: true } }),
      prisma.playlistMedia.count({ where: { shop, mediaType: "audio" } }),
      prisma.playlistMedia.count({ where: { shop, mediaType: "video" } }),
      prisma.appSettings
        .findUnique({ where: { shop_key: { shop, key: "widget_enabled" } } })
        .then((s) => (s ? s.value === "true" : true)),
    ]);

  const recentItems = await prisma.playlistMedia.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      title: true,
      mediaType: true,
      isActive: true,
      createdAt: true,
    },
  });

  return { shop, stats: { totalMedia, activeMedia, audioCount, videoCount }, widgetEnabled, recentItems };
};

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ value, label, tone }) {
  return (
    <Box
      background="bg-surface-secondary"
      borderRadius="300"
      padding="400"
      minWidth="120px"
    >
      <BlockStack gap="100" align="center" inlineAlign="center">
        <Text variant="heading2xl" as="p" tone={tone}>
          {value}
        </Text>
        <Text variant="bodySm" tone="subdued" alignment="center">
          {label}
        </Text>
      </BlockStack>
    </Box>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { shop, stats, widgetEnabled, recentItems } = useLoaderData();

  return (
    <Page
      title="Audio & Video Playlist"
      subtitle="Manage your storefront media playlist widget"
      primaryAction={
        <Button variant="primary" url="/app/playlist">
          Manage Playlist
        </Button>
      }
      secondaryActions={[
        { content: "Settings", url: "/app/settings" },
      ]}
    >
      <Layout>
        {/* ── Widget status banner ───────────────────────────────────── */}
        <Layout.Section>
          <Banner
            title={widgetEnabled ? "Widget is live on your storefront" : "Widget is currently disabled"}
            tone={widgetEnabled ? "success" : "warning"}
            action={widgetEnabled ? undefined : { content: "Enable widget", url: "/app/settings" }}
            secondaryAction={{ content: "Open settings", url: "/app/settings" }}
          >
            <Text variant="bodySm">
              {widgetEnabled
                ? "Customers can see and interact with your playlist widget right now."
                : "Turn on the widget in Settings or via the Theme Customizer under App Embeds."}
            </Text>
          </Banner>
        </Layout.Section>

        {/* ── Stats row ────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" fontWeight="semibold">
                Overview
              </Text>
              <Divider />
              <InlineStack gap="400" wrap>
                <StatCard value={stats.totalMedia}  label="Total items"   />
                <StatCard value={stats.activeMedia} label="Active"        tone="success" />
                <StatCard value={stats.audioCount}  label="Audio tracks"  tone="info" />
                <StatCard value={stats.videoCount}  label="Video items"   tone="warning" />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Recent additions ─────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingSm" fontWeight="semibold">
                  Recent additions
                </Text>
                <Button variant="plain" url="/app/playlist">
                  View all
                </Button>
              </InlineStack>
              <Divider />

              {recentItems.length === 0 ? (
                <BlockStack gap="300" inlineAlign="center">
                  <Text tone="subdued" alignment="center">
                    No media items yet.
                  </Text>
                  <Button variant="primary" url="/app/playlist">
                    Add your first item
                  </Button>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  {recentItems.map((item) => (
                    <Box
                      key={item.id}
                      background="bg-surface-secondary"
                      borderRadius="200"
                      padding="300"
                    >
                      <InlineStack align="space-between" blockAlign="center" gap="300">
                        <InlineStack gap="300" blockAlign="center">
                          <Badge
                            tone={item.mediaType === "audio" ? "info" : "warning"}
                          >
                            {item.mediaType === "audio" ? "Audio" : "Video"}
                          </Badge>
                          <Text variant="bodyMd" fontWeight="medium">
                            {item.title}
                          </Text>
                        </InlineStack>
                        <Badge tone={item.isActive ? "success" : "critical"}>
                          {item.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">
                  Quick actions
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <Button variant="primary" url="/app/playlist" fullWidth>
                    + Add media item
                  </Button>
                  <Button url="/app/settings" fullWidth>
                    Widget settings
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" fontWeight="semibold">
                  Supported sources
                </Text>
                <Divider />
                <List type="bullet" gap="loose">
                  <List.Item>YouTube videos</List.Item>
                  <List.Item>TikTok videos</List.Item>
                  <List.Item>Direct .mp4 video files</List.Item>
                  <List.Item>Direct .mp3 audio files</List.Item>
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text variant="headingSm" fontWeight="semibold">
                  Connected store
                </Text>
                <Text variant="bodySm" tone="subdued">
                  {shop}
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
