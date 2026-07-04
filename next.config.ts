import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // puppeteer bundles Chromium and native bits; keep it (and stealth) out of the bundle.
  serverExternalPackages: ["puppeteer", "puppeteer-extra", "puppeteer-extra-plugin-stealth"],
};

export default nextConfig;
