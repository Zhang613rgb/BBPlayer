import { Orpheus, type Track as OrpheusTrack } from '@bbplayer/orpheus'
import type { Result } from 'neverthrow'
import { err, ok } from 'neverthrow'

import { trackKeys } from '@/hooks/queries/db/track'
import useAppStore from '@/hooks/stores/useAppStore'
import usePlayerStore from '@/hooks/stores/usePlayerStore'
import { bilibiliApi } from '@/lib/api/bilibili/api'
import { queryClient } from '@/lib/config/queryClient'
import type { PlayerError } from '@/lib/errors/player'
import { createPlayerError } from '@/lib/errors/player'
import type { BilibiliApiError } from '@/lib/errors/thirdparty/bilibili'
import { trackService } from '@/lib/services/trackService'
import type { CreateTrackPayload } from '@/types/services/track'
import type { Track } from '@/types/core/media'

import { toastAndLogError } from './error-handling'
import log, { flatErrorMessage } from './log'

const logger = log.extend('Utils.Player')

/** 低于此秒数且不足总时长 10% 的收听视为误触/秒切，不计入历史。 */
const MIN_VALID_PLAYED_SEC = 3
/** 实际播放时长 / 总时长 达到该比例即算有效收听（completed=1）。 */
const COMPLETED_RATIO = 0.5

/**
 * 将内部 Track 类型转换为 Orpheus 的 Track 类型。
 * @param track - 内部 Track 对象。
 * @returns 一个 Result 对象，成功时包含 OrpheusTrack，失败时包含 Error。
 */
function trackToCreatePayload(track: Track): CreateTrackPayload | null {
	if (track.source === 'bilibili') {
		if (!track.bilibiliMetadata?.bvid) return null
		return {
			source: 'bilibili',
			title: track.title,
			coverUrl: track.coverUrl,
			duration: track.duration,
			bilibiliMetadata: {
				bvid: track.bilibiliMetadata.bvid,
				isMultiPage: track.bilibiliMetadata.isMultiPage,
				cid: track.bilibiliMetadata.cid,
				videoIsValid: track.bilibiliMetadata.videoIsValid,
				mainTrackTitle: track.bilibiliMetadata.mainTrackTitle ?? null,
			},
		}
	}
	if (track.source === 'local') {
		if (!track.localMetadata?.localPath) return null
		return {
			source: 'local',
			title: track.title,
			coverUrl: track.coverUrl,
			duration: track.duration,
			localMetadata: { localPath: track.localMetadata.localPath },
		}
	}
	return null
}

function convertToOrpheusTrack(
	track: Track,
): Result<OrpheusTrack, BilibiliApiError | PlayerError> {
	// logger.debug('转换 Track 为 OrpheusTrack', {
	// 	trackId: track.id,
	// 	title: track.title,
	// 	artist: track.artist,
	// })

	const url = getInternalPlayUri(track)

	// 如果没有有效的 URL，返回错误
	if (!url) {
		const errorMsg = '没有找到有效的音频流 URL'
		logger.warning(errorMsg, track)
		return err(
			createPlayerError('AudioUrlNotFound', `${errorMsg}: ${track.id}`),
		)
	}

	const orpheusTrack: OrpheusTrack = {
		id: track.uniqueKey,
		url,
		title: track.title,
		artist: track.artist?.name,
		artwork: track.coverUrl ?? undefined,
		duration: track.duration,
	}

	// logger.debug('OrpheusTrack 转换完成', {
	// 	title: orpheusTrack.title,
	// 	id: orpheusTrack.id,
	// })
	return ok(orpheusTrack)
}

/**
 * 上报播放记录
 * 由于这只是一个非常边缘的功能，我们不关心他是否出错，所以发生报错时只写个 log，返回 void
 */
async function reportPlaybackHistory(
	uniqueKey: string,
	position: number,
): Promise<void> {
	if (!useAppStore.getState().settings.sendPlayHistory) return
	if (!useAppStore.getState().hasBilibiliCookie()) return
	const trackResult = await trackService.getTrackByUniqueKey(uniqueKey)
	if (trackResult.isErr()) {
		toastAndLogError('查询 track 失败：', trackResult.error, 'Utils.Player')
		return
	}
	const track = trackResult.value
	if (track.source !== 'bilibili') {
		return
	}
	let cid = track.bilibiliMetadata.cid
	if (!cid && !track.bilibiliMetadata.isMultiPage) {
		const videoPageResult = await bilibiliApi.getPageList({
			bvid: track.bilibiliMetadata.bvid,
		})
		if (videoPageResult.isErr()) {
			toastAndLogError(
				'查询视频信息失败：',
				videoPageResult.error,
				'Utils.Player',
			)
			return
		}
		if (videoPageResult.value.length === 0) {
			logger.warning('视频无分 p 信息，无法上报播放记录', {
				bvid: track.bilibiliMetadata.bvid,
			})
			return
		}
		cid = videoPageResult.value[0].cid
	} else if (track.bilibiliMetadata.isMultiPage && !cid) {
		logger.warning('多 p 视频无法上报播放记录，不存在 cid', {
			bvid: track.bilibiliMetadata.bvid,
		})
		return
	}
	logger.debug('上报播放记录', {
		bvid: track.bilibiliMetadata.bvid,
		cid,
		position,
	})
	const result = await bilibiliApi.reportPlaybackHistory({
		bvid: track.bilibiliMetadata.bvid,
		cid: cid!,
		progress: position,
	})
	if (result.isErr()) {
		logger.warning('上报播放记录到 bilibili 失败', {
			params: {
				bvid: track.bilibiliMetadata.bvid,
				cid,
			},
			error: result.error,
		})
	}
	return
}

/**
 *
 * @param playNow 是否立即播放
 * @param clearQueue 是否清空队列
 * @param startFromKey 从指定的 key 开始播放（并立即开始播放，无视 playNow）
 * @param playNext 是否插入到下一首播放
 * @returns
 */
async function addToQueue({
	tracks,
	playNow,
	clearQueue,
	startFromKey,
	playNext,
}: {
	tracks: Track[]
	playNow: boolean
	clearQueue: boolean
	startFromKey?: string
	playNext: boolean
}) {
	if (!tracks || tracks.length === 0) {
		return
	}
	if (playNext && tracks.length > 1) {
		toastAndLogError(
			'AddToQueueError',
			'只能将单曲插入到下一首播放，已取消本次操作。',
			'Utils.Player',
		)
		return
	}
	logger.debug('添加曲目到播放队列', {
		trackCount: tracks.length,
		playNow,
		clearQueue,
		startFromKey,
		playNext,
	})

	try {
		const orpheusTracks: OrpheusTrack[] = []
		for (const track of tracks) {
			const result = convertToOrpheusTrack(track)
			if (result.isOk()) {
				orpheusTracks.push(result.value)
				// 关键修复：曲目入队即落库。
				// 否则 bilibili 曲目从未写入本地 DB，
				// usePlayerStore.sync() 的 getTrackByUniqueKey 找不到 → internalTrack 为 null
				// → 播放器本地收藏(❤)与播放历史均失效。
				const payload = trackToCreatePayload(track)
				if (payload) {
					await trackService.findOrCreateTrack(payload).mapErr(() => undefined)
				}
			} else {
				logger.error('转换为 OrpheusTrack 失败，跳过该曲目', {
					trackId: track.id,
					error: result.error,
				})
			}
		}
		if (orpheusTracks.length === 0) {
			return
		}
		if (playNext) {
			// 前面已经做过长度检查，这里直接取第一个
			await Orpheus.playNext(orpheusTracks[0])
			if (playNow) {
				await Orpheus.play()
				return
			}
			return
		}
		await Orpheus.addToEnd(orpheusTracks, startFromKey, clearQueue)
		// 原生层已经处理了 startFromKey 的播放逻辑，会在添加后直接播放，这里只需要处理 playNow 即可
		if (playNow && !startFromKey) {
			await Orpheus.play()
			return
		}
	} catch (e) {
		logger.error('添加到队列失败：', { error: e })
	}
}

function getInternalPlayUri(track: Track) {
	if (track.source === 'bilibili') {
		return track.bilibiliMetadata.isMultiPage
			? `orpheus://bilibili?bvid=${track.bilibiliMetadata.bvid}&cid=${track.bilibiliMetadata.cid}&hires=0&dolby=0`
			: `orpheus://bilibili?bvid=${track.bilibiliMetadata.bvid}&hires=0&dolby=0`
	}
	if (track.source === 'local' && track.localMetadata) {
		return track.localMetadata.localPath
	}
	return undefined
}

async function finalizeAndRecordCurrentTrack(
	uniqueKey: string,
	realDuration: number,
	position: number,
) {
	try {
		const playedSeconds = Math.max(0, Math.floor(position))
		const duration = Math.max(1, Math.floor(realDuration))
		const effectivePlayed = Math.min(playedSeconds, duration)

		// 有效收听阈值：纯 0 或极短（不足 3 秒且不足总时长 10%）视为误触/秒切，丢弃不产生垃圾记录。
		const validListening =
			effectivePlayed > MIN_VALID_PLAYED_SEC ||
			effectivePlayed > duration * 0.1
		if (!validListening) {
			logger.debug('播放时长过短，跳过历史记录', {
				uniqueKey,
				effectivePlayed,
			})
			return
		}

		// 完成态：听满半首即算有效收听（自然结束时 effectivePlayed≈duration 自会命中）。
		const completed = effectivePlayed / duration >= COMPLETED_RATIO

		logger.info('完成播放', { uniqueKey })
		logger.debug('完成播放标记', {
			playedSeconds,
			duration,
			effectivePlayed,
			completed,
			uniqueKey,
		})

		// 确保当前 track 已落库：历史记录依赖 tracks 表外键，
		// 而普通播放流程从不为 bilibili 曲目建立本地记录，
		// 会导致下面写历史时找不到 track 而静默失败（历史为空）。
		const currentTrack = usePlayerStore.getState().internalTrack
		if (currentTrack) {
			const payload = trackToCreatePayload(currentTrack)
			if (payload) {
				await trackService.findOrCreateTrack(payload).mapErr(() => undefined)
			}
		}

		// 写入/合并播放历史（同一收听会话只保留一条，completed 具备真实含义）。
		const res = await trackService.recordOrMergePlayHistory(uniqueKey, {
			startTime: (Date.now() - playedSeconds * 1000) / 1000,
			durationPlayed: effectivePlayed,
			completed,
		})

		if (res.isErr()) {
			logger.debug('增加播放记录失败', {
				uniqueKey,
				message: flatErrorMessage(res.error),
			})
			return
		}
		logger.debug('增加播放记录成功', {
			uniqueKey,
		})

		void queryClient.invalidateQueries({
			queryKey: trackKeys.history(),
		})

		void reportPlaybackHistory(uniqueKey, effectivePlayed).catch((error) =>
			logger.error('上报播放历史失败', error),
		)
	} catch (error) {
		logger.debug('增加播放记录异常', error)
	}
}

export {
	addToQueue,
	convertToOrpheusTrack,
	finalizeAndRecordCurrentTrack,
	getInternalPlayUri,
	reportPlaybackHistory,
}
