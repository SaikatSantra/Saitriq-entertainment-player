import { Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Frame } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  try {
    await authenticate.admin(request);
    return { apiKey: process.env.SHOPIFY_API_KEY || "" };
  } catch (error) {
    if (error instanceof Response) {
      throw error; // Allow redirects to pass through
    }
    console.error("APP LOADER ERROR:", error);
    throw new Response(
      JSON.stringify({
        message: error?.message || "Unknown error",
        name: error?.name,
        stack: error?.stack,
        code: error?.code,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <PolarisAppProvider i18n={enTranslations}>
      <Frame>
        <ShopifyAppProvider embedded apiKey={apiKey}>
          <NavMenu>
            <a href="/app" rel="home">Dashboard</a>
            <a href="/app/playlist">Playlist</a>
            <a href="/app/settings">Settings</a>
          </NavMenu>
          <Outlet />
        </ShopifyAppProvider>
      </Frame>
    </PolarisAppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("APP ROOT ERROR:", error);
  let errorDetails = "";
  if (isRouteErrorResponse(error)) {
    try {
      const parsed = typeof error.data === "string" ? JSON.parse(error.data) : error.data;
      errorDetails = JSON.stringify(parsed, null, 2);
    } catch {
      errorDetails = String(error.data);
    }
  } else {
    errorDetails = error?.stack || error?.message || (typeof error === "object" ? JSON.stringify(error, Object.getOwnPropertyNames(error), 2) : String(error));
  }

  return (
    <div style={{ padding: "40px", fontFamily: "sans-serif" }}>
      <h2 style={{ color: "#d72c0d" }}>⚠️ Application Error</h2>
      <pre style={{ background: "#f1f2f3", padding: "16px", borderRadius: "8px", overflow: "auto", whiteSpace: "pre-wrap" }}>
        {errorDetails}
      </pre>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};