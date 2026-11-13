/**
 * 本机图片 / 截图的通知文字识别。
 *
 * 与公众号配图（article-extract.mjs）共用同一条视觉模型通道，区别有两点：
 * 1. 图片来自用户本机，没有外链可以交给模型，只能转成 data URL 内联；
 * 2. 目的是「把图里的通知抄成文字」，所以要求整段誊抄，而不是只挑时间地点。
 *
 * 设计原则与配图识别一致：单张失败只降级为「这张没读到」，不阻断其余图片。
 */
import { ApiError } from './parse-service.mjs';
import { readImages, visionEnabled } from './vision-service.mjs';
import { OCR_MAX_FILES, OCR_MAX_FILE_BYTES, OCR_MAX_TOTAL_BYTES } from '../shared/ocr-contract.ts';

// 上限来自 shared/ocr-contract.ts，前后端同一份；这里 re-export 供 index.mjs 限制请求体。
export { OCR_MAX_FILES, OCR_MAX_FILE_BYTES, OCR_MAX_TOTAL_BYTES };

const FILES_MB = Math.round(OCR_MAX_FILE_BYTES / 1024 / 1024);
const TOTAL_MB = Math.round(OCR_MAX_TOTAL_BYTES / 1024 / 1024);

/**
 * 单张图保留多少字。公众号配图按 1500 字够用，但用户可能传一张
 * 几十条消息的群聊长截图，截断必须发生在能告知的位置，所以单独放宽。
 */
const OCR_MAX_TEXT_CHARS = 6000;

const PROMPT_HEAD = `你是通知类图片的 OCR 誊抄器。下面是一个编号序列中的若干张图片，每张前面有【图片 N】标记。
逐张判断并输出：
- 图中有可读文字（通知正文、时间、地点、报名方式、名单、表格、群聊记录）→ kind="info"，text 必须完整誊抄，按原文顺序保留换行，不得改写、不得总结、不得补充原文没有的内容；数字、日期、单位名称、标点一律照抄；
- 纯装饰、分割线、纯图案、logo → kind="deco"，text 为空字符串；
- 二维码、小程序码 → kind="qr"，text 誊抄旁边的说明文字（如"扫码报名"），没有就写"二维码"；
- 完全看不清 → kind="other"，text 为空字符串。
只输出一个 JSON 对象，不要 Markdown，不要解释：
{"images":[{"index":1,"kind":"info","text":"..."}]}
index 必须与【图片 N】中的 N 完全一致。`;

/** 允许的图片类型。按文件头判断，不信 multipart 里自报的 MIME。 */
const SIGNATURES = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

export function sniffImageMime(buffer) {
  if (!buffer || !buffer.length) return null;
  const hit = SIGNATURES.find((entry) => entry.test(buffer));
  return hit ? hit.mime : null;
}

/**
 * 认出「是什么」比「不支持」有用得多。这些格式用户手里很常见，
 * 报错时要直接说下一步该怎么做，而不是只说格式不对。
 */
function describeUnsupported(buffer) {
  const head = buffer.toString('latin1', 0, 12);
  if (/^GIF8/.test(head)) return '这是 GIF 动图，不支持。请用截图或另存为 JPG/PNG 后再上传。';
  if (head.startsWith('%PDF')) return '这是 PDF 文件，请改用「添加文件」上传，走文档解析通道。';
  if (/^BM/.test(head)) return '这是 BMP 图片，体积大且不通用。请另存为 PNG 或 JPG 后再上传。';
  if (head.slice(4, 8) === 'ftyp') return '这是 HEIC/HEIF 照片（iPhone 默认格式），模型读不了。请在相册里导出为 JPG 后再上传。';
  if (/^II\*|^MM/.test(head)) return '这是 TIFF 图片，不支持。请另存为 JPG 或 PNG 后再上传。';
  return '只支持 PNG、JPG、WebP 三种图片格式。';
}

function validate(uploads) {
  const files = uploads.filter((item) => item?.buffer?.length);
  if (!files.length) throw new ApiError(400, 'INVALID_IMAGE_UPLOAD', '请先选择要识别的图片。');
  if (files.length > OCR_MAX_FILES) {
    throw new ApiError(400, 'TOO_MANY_IMAGES', `一次最多识别 ${OCR_MAX_FILES} 张图片，请分次上传。`);
  }
  let total = 0;
  const accepted = [];
  for (const file of files) {
    const name = (file.name || '未命名图片').slice(0, 120);
    if (file.buffer.length > OCR_MAX_FILE_BYTES) {
      throw new ApiError(413, 'IMAGE_TOO_LARGE', `「${name}」超过单张 ${FILES_MB} MB 上限，请压缩或裁掉无关部分后再上传。`);
    }
    const mime = sniffImageMime(file.buffer);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE', `「${name}」${describeUnsupported(file.buffer)}`);
    total += file.buffer.length;
    accepted.push({ name, mime, buffer: file.buffer });
  }
  if (total > OCR_MAX_TOTAL_BYTES) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', `图片总大小超过 ${TOTAL_MB} MB，请分次上传或先压缩。`);
  }
  return accepted;
}

/**
 * 识别用户上传的图片。
 * @param {{name: string, buffer: Buffer}[]} uploads
 * @returns {Promise<{items: {index: number, name: string, kind: 'text'|'empty'|'unread', text: string, truncated: boolean}[], warnings: string[]}>}
 */
export async function ocrImages(uploads, config, fetchImpl = fetch) {
  const files = validate(uploads);
  if (!visionEnabled(config)) {
    throw new ApiError(
      503,
      'VISION_NOT_CONFIGURED',
      '还没配置视觉模型，暂时读不了图片里的文字。请在 .env.local 设置 AI_VISION_MODEL（如 gpt-4o-mini）后重启；这段时间可以先把通知文字粘贴进来。',
    );
  }

  const entries = files.map((file, index) => ({
    index: index + 1,
    url: `data:${file.mime};base64,${file.buffer.toString('base64')}`,
  }));

  const read = await readImages(entries, config, fetchImpl, {
    prompt: PROMPT_HEAD,
    maxTextChars: OCR_MAX_TEXT_CHARS,
    preserveLines: true,
  });
  // readImages 是给「文章正文 + 配图」写的，兜底文案里带「解析仅依据正文文字」，
  // 但这里是独立的图片请求，没有正文可依据，留着只会让人以为系统还读了别的文字。
  const warnings = read.warnings.filter((item) => !item.startsWith('图片文字全部读取失败'));

  const items = entries.map((entry) => {
    const raw = read.results.get(entry.index) ?? { index: entry.index, kind: 'unread', text: '' };
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    // 对外只留三种状态：读到字、图里没字、没识别成功。
    // deco/qr 是模型明确判断「这张不是正文」，归 empty；
    // other（看不清）与 unread（调用失败、模型漏答）都可能是「看漏了」，归 unread 让人可以换张图重试。
    const kind = text ? 'text' : (raw.kind === 'deco' || raw.kind === 'qr' ? 'empty' : 'unread');
    return {
      index: entry.index,
      name: files[entry.index - 1].name,
      kind,
      text: text.slice(0, OCR_MAX_TEXT_CHARS),
      truncated: text.length > OCR_MAX_TEXT_CHARS,
    };
  });

  const truncated = items.filter((item) => item.truncated);
  if (truncated.length) {
    warnings.push(`${truncated.map((item) => `「${item.name}」`).join('、')}内容超过 ${OCR_MAX_TEXT_CHARS} 字，只保留了前半部分。`);
  }
  const blank = items.filter((item) => item.kind !== 'text');
  if (blank.length === items.length) {
    warnings.push('这些图片都没读到文字。可能是纯海报/纯图案，也可能字太小或太糊，建议重新截图或直接粘贴文字。');
  } else if (blank.length) {
    warnings.push(`${blank.map((item) => `「${item.name}」`).join('、')}没读到文字，其余图片已识别。`);
  } else {
    warnings.push('图片文字由模型识别，关键时间、地点、金额请对照原图核对。');
  }
  return { items, warnings };
}
