// @jsquash/avif 构建期 stub（T6.2）：其多线程 worker 编码器与 electron-vite 的
// iife worker 不兼容且无法按子路径 alias（包内相对导入）。AVIF 预览整体降级；
// PDF/Office/PNG/JPEG/GIF/WebP 等主力格式不受影响（各自独立解码器）。
const unavailable = () => {
  throw new Error('AVIF_PREVIEW_UNAVAILABLE');
};
export const init = unavailable;
export const decode = unavailable;
export const encode = unavailable;
export default { init, decode, encode };
