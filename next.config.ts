import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "Your bands" used to live at /likes.
  redirects() {
    return [{ source: "/likes", destination: "/bands", permanent: false }];
  },
};

export default nextConfig;
