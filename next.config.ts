import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/v1/**': ['./src/server/tts/prompts/**/*'],
  },
};

export default nextConfig;
