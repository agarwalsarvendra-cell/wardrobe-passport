/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg", "@circle-fin/developer-controlled-wallets", "nodemailer"],
  async rewrites() {
    // The screens are a static client in /public; the API lives in app/api.
    return [{ source: "/", destination: "/index.html" }];
  },
};
export default nextConfig;
