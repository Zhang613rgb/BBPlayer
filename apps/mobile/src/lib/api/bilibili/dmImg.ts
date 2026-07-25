import CryptoJS from 'crypto-js'

/**
 * 反爬参数生成（对标 PipePipe getDmImgParams / PiliPlus makSign 注入）
 *
 * B 站 WBI 接口（投稿列表、playurl 等）要求随签名携带 4 个 dm_img_* 字段，
 * 缺失会高概率触发 -412 / 风控拦截。这里生成「格式合法但内容随机」的值即可，
 * 关键在于：被 WBI 签名且随请求发送（见 wbi.ts 的全局注入）。
 */

const WEBGL_VENDOR = 'Google Inc. (Apple)'
const WEBGL_RENDERER = 'Apple GPU'

/** 生成指定长度的随机大小写字母+数字串，用于让每次请求的 dm_img 略有差异 */
function randomAlnum(length: number): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	let result = ''
	for (let i = 0; i < length; i++) {
		// oxlint-disable-next-line @typescript-eslint/no-magic-numbers
		result += chars[Math.floor(Math.random() * chars.length)]
	}
	return result
}

/** 将明文转 base64（Hermes 无全局 btoa，用 crypto-js 兜底） */
function toBase64(text: string): string {
	return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(text))
}

/**
 * 生成 4 个反爬参数。调用方须先把这些参数并入请求参数，再走 WBI 签名。
 * @returns 含 dm_img_list / dm_img_str / dm_cover_img_str / dm_img_inter 的对象
 */
export function getDmImgParams(): Record<string, string> {
	const dmImgStr = toBase64(
		`webgl|unmaskedvendor=${WEBGL_VENDOR}|unmaskedrenderer=${WEBGL_RENDERER}|vendor=WebKit|renderer=WebKit WebGL|nonce=${randomAlnum(16)}`,
	)
	const dmCoverImgStr = toBase64(
		`${WEBGL_RENDERER}|WebKit|WebKit WebGL|${randomAlnum(12)}`,
	)
	const dmImgInter = toBase64(
		JSON.stringify({
			w: 1920,
			h: 1080,
			ofs: [0, 0, 0],
			of: [0, 0, 0],
		}),
	)

	return {
		dm_img_list: '[]',
		dm_img_str: dmImgStr,
		dm_cover_img_str: dmCoverImgStr,
		dm_img_inter: dmImgInter,
	}
}
