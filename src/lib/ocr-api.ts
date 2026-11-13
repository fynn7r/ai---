/**
 * @file ocr-api.ts
 * @description 本机图片 / 截图的文字识别。
 *
 * 图片不落盘、不进第三方图床：一次请求内转成 data URL 交给视觉模型，识别完即丢。
 * 前端先按长边压缩，避免手机拍的一张 5 MB 照片白占上传带宽和模型等待时间。
 */

export interface IOcrItem {
  index: number;
  name: string;
  /** text=读到文字；empty=识别了但图里没字；unread=这张没识别成功 */
  kind: 'text' | 'empty' | 'unread';
  text: string;
  truncated: boolean;
}

export interface IOcrResult {
  items: IOcrItem[];
  warnings: string[];
}

/** 服务端单批视觉调用是 60 秒超时，这里要留出上传多张图与排队的余量。 */
const OCR_REQUEST_TIMEOUT_MS = 120_000;
/** 长边超过这个值才缩。通知截图放大到 2000px 已远超识别所需，再大只是浪费。 */
const MAX_EDGE = 2000;
/** 小文件不重编码：PNG 截图转 JPEG 虽然更小，但字边缘会糊，得不偿失。 */
const COMPRESS_ABOVE_BYTES = 900 * 1024;

async function compress(file: File): Promise<File> {
  // 类型不在白名单时原样上传，让服务端给出「这是 HEIC/PDF，该怎么办」的具体提示，
  // 前端在这里猜格式只会得到一句含糊的「读取失败」。
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= COMPRESS_ABOVE_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  // 压完反而更大（原图本就是小尺寸高质量 JPEG）时保留原图。
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

export async function ocrImages(files: File[]): Promise<IOcrResult> {
  const prepared: File[] = [];
  for (const file of files) prepared.push(await compress(file));

  const form = new FormData();
  for (const file of prepared) form.append('file', file);

  let response: Response;
  try {
    response = await fetch('/api/ocr', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('识别服务未连接或请求超时，图片没有上传。请确认本地服务正在运行。');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('识别服务返回内容无效，请重新上传。');
  }
  if (!response.ok) {
    const error = payload as { error?: { message?: string } } | null;
    throw new Error(error?.error?.message || '图片识别失败，请重试。');
  }
  return payload as IOcrResult;
}
