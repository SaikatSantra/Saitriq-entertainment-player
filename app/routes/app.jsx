import { Outlet, useLoaderData, useRouteError, useLocation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Frame, Navigation } from "@shopify/polaris";
import { HomeIcon, SettingsIcon, VideoIcon } from "@shopify/polaris-icons";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const location = useLocation();
  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <Frame
          navigation={
            <Navigation location={location.pathname}>
              <Navigation.Section
                items={[
                  {
                    url: "/app",
                    label: "Dashboard",
                    icon: HomeIcon,
                  },
                  {
                    url: "/app/playlist",
                    label: "Manage Playlist",
                    icon: VideoIcon,
                  },
                  {
                    url: "/app/settings",
                    label: "Settings",
                    icon: SettingsIcon,
                  },
                ]}
              />
            </Navigation>
          }
        >
          <Outlet />
        </Frame>
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
