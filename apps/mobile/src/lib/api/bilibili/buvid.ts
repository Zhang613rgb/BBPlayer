import CryptoJS from 'crypto-js'

import log from '@/utils/log'
import { storage } from '@/utils/mmkv'
import { bilibiliApiClient } from './client'

const logger = log.extend('3Party.Bilibili.Buvid')

/** 匿名设备指纹在 MMKV 中的存储键（与登录 cookie 隔离，互不冲突） */
const MMKV_ANON_KEY = 'bbplayer_anon_buvid'

const ANON_USER_AGENT =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 BiliApp/6.66.0'

interface AnonymousBuvid {
	buvid3: string
	buvid4?: string
	bili_ticket?: string
	bili_ticket_expires?: number // 秒级时间戳
}

interface BiliTicket {
	ticket: string
	expires: number
}

function loadFromStorage(): AnonymousBuvid | null {
	const raw = storage.getString(MMKV_ANON_KEY)
	if (!raw) return null
	try {
		return JSON.parse(raw) as AnonymousBuvid
	} catch {
		return null
	}
}

function saveToStorage(data: AnonymousBuvid): void {
	storage.set(MMKV_ANON_KEY, JSON.stringify(data))
}

/** 本地生成一个 buvid3（格式形如 XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXXinfoc） */
function generateBuvid3(): string {
	const hex = (length: number): string => {
		const chars = '0123456789abcdef'
		let result = ''
		for (let i = 0; i < length; i++) {
			result += chars[Math.floor(Math.random() * chars.length)]
		}
		return result
	}
	const body = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`
	return `${body}infoc`
}

/**
 * 生成 bili_ticket：用 HMAC-SHA256("ts{ts}", "XgwSnGZ1p") 作为 hexsign，
 * 调 GenWebTicket 接口拿 ticket + ttl。对标 PipePipe getBiliTicket。
 * @returns 成功返回 ticket 与过期时间戳，失败返回 null（不抛错）
 */
async function fetchBiliTicket(buvid3: string): Promise<BiliTicket | null> {
	const ts = Math.floor(Date.now() / 1000)
	const hexsign = CryptoJS.HmacSHA256(`ts${ts}`, 'XgwSnGZ1p').toString()
	const url = `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexsign}&context[ts]=${ts}&csrf=`
	try {
		const resp = await fetch(url, {
			method: 'GET',
			headers: {
				Referer: 'https://www.bilibili.com/',
				'User-Agent': ANON_USER_AGENT,
				Cookie: `buvid3=${buvid3}`,
			},
		})
		if (!resp.ok) return null
		const json = (await resp.json()) as {
			code?: number
			data?: { ticket?: string; ttl?: number; created_at?: number }
		}
		if (json.code !== 0 || !json.data?.ticket) return null
		const ttl = json.data.ttl ?? 3600
		const created = json.data.created_at ?? ts
		return { ticket: json.data.ticket, expires: created + ttl }
	} catch {
		return null
	}
}

/**
 * 匿名 buvid 激活（首次请求前/启动时调用）：
 * 1) GET /x/frontend/finger/spi 取官方 b_3/b_4（无需解析 Set-Cookie，最稳妥）；
 * 2) 本地生成 bili_ticket（HMAC-SHA256）。
 * 任一步失败都不抛错，保证匿名请求始终至少带上 buvid3。
 */
export async function activateAnonymousBuvid(): Promise<AnonymousBuvid> {
	const current = loadFromStorage() ?? { buvid3: generateBuvid3() }

	try {
		const finger = await bilibiliApiClient
			.get<{ b_3: string; b_4: string }>({
				endpoint: '/x/frontend/finger/spi',
				params: { wtf: '1' },
			})
			.match(
				(data) => data,
				(error) => {
					logger.warning('获取匿名 buvid 指纹失败', {
						message: error.message,
					})
					return null
				},
			)

		if (finger?.b_3) {
			current.buvid3 = finger.b_3
			current.buvid4 = finger.b_4 ?? current.buvid4
		}
	} catch (error) {
		logger.warning('激活匿名 buvid 异常', error)
	}

	try {
		const ticket = await fetchBiliTicket(current.buvid3)
		if (ticket) {
			current.bili_ticket = ticket.ticket
			current.bili_ticket_expires = ticket.expires
		}
	} catch (error) {
		logger.warning('生成 bili_ticket 异常', error)
	}

	saveToStorage(current)
	return current
}

let activationStarted = false

/** 触发一次激活（fire-and-forget，不阻塞请求） */
function ensureActivated(): void {
	if (activationStarted) return
	activationStarted = true
	void activateAnonymousBuvid().catch((error) => {
		logger.warning('匿名 buvid 激活失败（不影响基础匿名请求）', error)
	})
}

/**
 * 返回匿名身份 Cookie 字符串（buvid3 / buvid4 / bili_ticket）。
 * 未登录时由 client.ts 的 request 使用，替代空 Cookie，修复 412 命门之一。
 */
export function getAnonymousCookie(): string {
	let data = loadFromStorage()
	if (!data) {
		data = { buvid3: generateBuvid3() }
		saveToStorage(data)
	}
	ensureActivated()

	const parts = [`buvid3=${data.buvid3}`]
	if (data.buvid4) parts.push(`buvid4=${data.buvid4}`)
	if (data.bili_ticket) parts.push(`bili_ticket=${data.bili_ticket}`)
	return parts.join('; ')
}
