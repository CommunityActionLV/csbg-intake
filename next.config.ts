import type { NextConfig } from "next";

/* Security headers ship on every response. CSP notes:
   - script-src needs 'unsafe-inline' for Next.js hydration bootstrapping
     (no nonce plumbing yet) — everything else is same-origin only.
   - style-src needs 'unsafe-inline' because the design system leans on
     inline style={{}} for one-off layout, matching the design prototype.
   - img-src allows data: for the uploadable white-label logo. */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  // HSTS is a no-op over plain HTTP, so it's safe to send unconditionally;
  // the LAN-staging escape hatch (CSBG_ALLOW_HTTP=1) skips it.
  ...(process.env.CSBG_ALLOW_HTTP === "1"
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // standalone output only for container builds (Dockerfile sets BUILD_STANDALONE=1);
  // the Windows local tier runs `next start`, which standalone builds don't support
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  serverExternalPackages: ["pg", "@electric-sql/pglite", "@react-pdf/renderer"],
  experimental: {
    serverActions: {
      // spreadsheet imports arrive base64-encoded through a server action (4 MB file cap)
      bodySizeLimit: "8mb",
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
