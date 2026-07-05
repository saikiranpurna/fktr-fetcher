import type { NextConfig } from "next";

// The frontend is UI-only now; all /api/* calls are proxied to the Python (Scrapling) backend.
// In Docker Compose this resolves to the `backend` service; locally it defaults to :8000.
const backend = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
