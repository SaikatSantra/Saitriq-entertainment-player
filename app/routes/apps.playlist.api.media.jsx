/**
 * App Proxy endpoint — served via Shopify's storefront proxy.
 */

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const DEFAULT_SETTINGS = {
  widget_enabled: true,
  widget_position: "bottom-left",
  widget_title: "Now Playing",
  autoplay: false,
  loop_playlist: true,
};

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const action = async () => {
  return new Response("Method not allowed", { status: 405 });
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const shop = (session?.shop || url.searchParams.get("shop") || "").toLowerCase();

    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      return jsonResp({ success: false, error: "Invalid shop domain" }, 400);
    }

    const [items, settingsRows] = await Promise.all([
      prisma.playlistMedia.findMany({
        where: { shop, isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, title: true, mediaType: true, sourceUrl: true, thumbnailUrl: true, sortOrder: true },
      }),
      prisma.appSettings.findMany({ where: { shop } }),
    ]);

    const settings = { ...DEFAULT_SETTINGS };
    settingsRows.forEach(({ key, value }) => {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return;
      if (typeof DEFAULT_SETTINGS[key] === "boolean") {
        if (value === "true" || value === "false") {
          settings[key] = value === "true";
        }
      } else if (key === "widget_position") {
        if (["bottom-left", "bottom-right", "top-left", "top-right"].includes(value)) {
          settings[key] = value;
        }
      } else if (key === "widget_title" && value.trim() && value.length <= 40) {
        settings[key] = value;
      }
    });

    const mediaItems = settings.widget_enabled ? items : [];
    return jsonResp({ success: true, items: mediaItems, settings });
  } catch (err) {
    console.error("[playlist-api]", err);
    return jsonResp({ success: false, error: "Internal server error" }, 500);
  }
};
