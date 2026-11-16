#!/usr/bin/env node
/**
 * OCR 自检：看本机有没有可用引擎，并给出安装指引。
 *
 *   node tools/ocr-doctor.mjs
 */
import * as ocr from '../backend/ocr.mjs';

const st = ocr.status();
console.log(`OCR 模式：${st.mode}`);
console.log(`本地引擎：${st.local.available ? `可用 · ${st.local.cmd}` : '未安装'}`);
console.log(`视觉模型：${st.api.configured ? `已配置 · ${st.api.model} @ ${st.api.base}` : '未配置'}`);

if (!st.local.available && !st.api.configured) {
  console.log(`
两种装法，选一个：

1) 离线（推荐）
   Windows 安装 tesseract：winget install --id UB-Mannheim.TesseractOCR
   装完把中文包 chi_sim.traineddata 放到 <安装目录>\\tessdata\\
   然后把安装目录加进 PATH，或在 .env 写 OCR_CMD=D:\\Program Files\\Tesseract-OCR\\tesseract.exe

2) 联网（更准，按张计费）
   在 .env 配：
   OCR_MODE=auto
   OCR_API_KEY=你的key
   OCR_API_BASE=https://api.openai.com/v1      # 或任意 OpenAI 兼容地址
   OCR_MODEL=gpt-4o-mini                       # 或 qwen-vl-max 等支持图片的模型
`);
} else {
  console.log('\n可以直接用了：上传图片/扫描件会自动识别文字。');
}
