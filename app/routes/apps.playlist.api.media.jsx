/**
 * App Proxy endpoint — served via Shopify's storefront proxy.
 *
 * Shopify routes:  /apps/playlist/api/media
 * → forwards to:  {app_url}/apps/playlist/api/media?shop=myshop.myshopify.com
 *
 * Shopify automatically appends ?shop=, ?path_prefix=, and a signature query
 * string when proxying. We trust the shop param because the request comes
 * through Shopify's signed proxy (validated by @shopify/shopify-api).
 *
 * No additional CORS headers are needed — the request is same-origin from the
 * storefront's perspective (Shopify proxies it server-side).
 */

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Cache at edge for 2 min; apps can bust by deploying
      "Cache-Control": "public, max-age=120, s-maxage=120",
      // Keep legacy direct-fetch CORS support
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
    });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);

  try {
    const url  = new URL(request.url);

    // Shopify App Proxy always injects ?shop= into the forwarded URL
    // Fallback: check X-Shopify-Shop-Domain header (set by the proxy)
    const shop =
      url.searchParams.get("shop") ||
      request.headers.get("x-shopify-shop-domain") ||
      "";

    if (!shop) {
      return json({ success: false, error: "Missing shop parameter" }, 400);
    }

    const [mediaItems, settingsRows] = await Promise.all([
      prisma.playlistMedia.findMany({
        where: { shop, isActive: true },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          title: true,
          mediaType: true,
          sourceUrl: true,
          thumbnailUrl: true,
          sortOrder: true,
        },
      }),
      prisma.appSettings.findMany({ where: { shop } }),
    ]);

    const settings = {};
    settingsRows.forEach(({ key, value }) => {
      if (value === "true")       settings[key] = true;
      else if (value === "false") settings[key] = false;
      else                        settings[key] = value;
    });

    return json({ success: true, items: mediaItems, settings });
  } catch (err) {
    console.error("[playlist-api]", err);
    return json({ success: false, error: "Internal server error" }, 500);
  }
};
