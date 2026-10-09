import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Frame } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
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
  return (
    <div style={{ padding: "40px", fontFamily: "sans-serif" }}>
      <h2 style={{ color: "#d72c0d" }}>⚠️ Application Error</h2>
      <pre style={{ background: "#f1f2f3", padding: "16px", borderRadius: "8px", overflow: "auto", whiteSpace: "pre-wrap" }}>
        {error?.stack || error?.message || (typeof error === "object" ? JSON.stringify(error, Object.getOwnPropertyNames(error), 2) : String(error))}
      </pre>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};