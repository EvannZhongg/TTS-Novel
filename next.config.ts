import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    // renderPrompt() 用 path.join(process.cwd(), 'src/server/tts/prompts', ...)
    // 读取 prompt 模板(llm.ts:306)。Next 的静态分析其实能识别这个目录并自动
    // 追踪, 实测把范围写成 /api/v1/** 时 /api/app/process-next 也照样带上了
    // 全部 5 个 .md。这里显式写 /api/** 只是把这层依赖写清楚, 不依赖
    // tracer 的自动推断 —— 一旦将来 filename 变成完全动态的变量, 自动推断
    // 就会失效, 而这条声明仍然有效。
    '/api/**': ['./src/server/tts/prompts/**/*'],
  },
};

export default nextConfig;
