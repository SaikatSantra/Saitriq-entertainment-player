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
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};