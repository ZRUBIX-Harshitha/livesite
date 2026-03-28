/** @type {import('next').NextConfig} */
const nextConfig = {
    // Allow our deploy API to spawn child processes (server only)
    serverExternalPackages: [],

    async headers() {
        return [
            {
                source: "/(.*)",
                headers: [
                    {
                        key: "Content-Security-Policy",
                        value:
                            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src *;",
                    },
                ],
            },
        ];
    },
};

export default nextConfig;

