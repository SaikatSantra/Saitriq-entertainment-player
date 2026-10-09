import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (
    isRouteErrorResponse(error) &&
    typeof error.data === "string" &&
    error.data.includes("app-bridge.js")
  ) {
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
        </head>
        <body>
          <div dangerouslySetInnerHTML={{ __html: error.data }} />
          <Scripts />
        </body>
      </html>
    );
  }

  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
    ? error.message
    : "Unknown error";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{status} — ire audio video player</title>
        <Meta />
        <Links />
      </head>
      <body
        style={{
          fontFamily: "sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          margin: 0,
          backgroundColor: "#f6f6f7",
        }}
      >
        <div
          style={{
            background: "#fff",
            borderRadius: "8px",
            padding: "32px 40px",
            maxWidth: "480px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}
        >
          <p style={{ fontSize: "48px", margin: "0 0 8px" }}>⚠️</p>
          <h1 style={{ fontSize: "20px", margin: "0 0 8px", color: "#202223" }}>
            {status === 404 ? "Page not found" : "Something went wrong"}
          </h1>
          <p style={{ color: "#6d7175", fontSize: "14px", margin: "0 0 24px" }}>
            {status === 404
              ? "The page you're looking for doesn't exist."
              : "The app encountered an unexpected error. Please try refreshing."}
          </p>
          {message && (
            <pre
              style={{
                background: "#f6f6f7",
                borderRadius: "4px",
                padding: "12px",
                fontSize: "12px",
                textAlign: "left",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                color: "#d72c0d",
              }}
            >
              {error?.stack || message}
            </pre>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
