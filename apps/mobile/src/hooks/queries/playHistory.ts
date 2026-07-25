import { useQuery } from '@tanstack/react-query'
import { count, desc, sql } from 'drizzle-orm'

import drizzleDb from '@/lib/db/db'
import * as schema from '@/lib/db/schema'
import { trackService } from '@/lib/services/trackService'
import type { Track } from '@/types/core/media'

export const playHistoryKeys = {
	all: ['playHistory'] as const,
	heatmap: () => [...playHistoryKeys.all, 'heatmap'] as const,
	allHistory: () => [...playHistoryKeys.all, 'allHistory'] as const,
	byDayOfMonth: (day: number) =>
		[...playHistoryKeys.all, 'byDayOfMonth', day] as const,
	topPlayed: (days: number, limit: number) =>
		[...playHistoryKeys.all, 'topPlayed', days, limit] as const,
}

export const usePlayHistoryHeatmap = () => {
	return useQuery({
		queryKey: playHistoryKeys.heatmap(),
		queryFn: async () => {
			const result = await drizzleDb
				.select({
					date: sql<string>`date(
                        CASE
                            WHEN ${schema.playHistory.startTime} > 10000000000 THEN ${schema.playHistory.startTime} / 1000
                            ELSE ${schema.playHistory.startTime}
                        END,
                        'unixepoch',
                        'localtime'
                    )`,
					count: count(),
				})
				.from(schema.playHistory)
				.groupBy(
					sql`date(
                        CASE
                            WHEN ${schema.playHistory.startTime} > 10000000000 THEN ${schema.playHistory.startTime} / 1000
                            ELSE ${schema.playHistory.startTime}
                        END,
                        'unixepoch',
                        'localtime'
                    )`,
				)

			const data: Record<string, number> = {}
			result.forEach((row) => {
				if (row.date) {
					data[row.date] = row.count
				}
			})
			return data
		},
		networkMode: 'always',
		staleTime: 0,
	})
}

/**
 * 返回「全部历史」（跨日）去重后的播放列表。
 *
 * - 查询范围：play_history 全表（无日期过滤）
 * - 排序：desc(playHistory.startTime)，最新播放置顶
 * - 去重：按 track.uniqueKey 归约，保留首次命中（即 max(startTime)）那条
 *
 * 注意：startTime 单位为「秒」（player.ts 写入时已 /1000），此处直接按秒使用。
 */
export type HistoryTrack = Track & {
	historyId?: number
	playedAt?: number
}

export const useAllPlayHistory = () => {
	return useQuery({
		queryKey: playHistoryKeys.allHistory(),
		queryFn: async (): Promise<HistoryTrack[]> => {
			const historyRows = await drizzleDb.query.playHistory.findMany({
				// 无 where 过滤 → 全量历史（跨日），最新播放置顶
				with: {
					track: {
						with: {
							artist: true,
							bilibiliMetadata: true,
							localMetadata: true,
						},
					},
				},
				orderBy: [desc(schema.playHistory.startTime)],
			})

			// 因已 desc(startTime)，Map 首次命中即保留该 uniqueKey 的 max(startTime) 记录。
			// 先过滤孤儿数据（track 缺失 / 级联删除后），再按 uniqueKey 去重。
			const deduped = new Map<string, HistoryTrack>()
			for (const row of historyRows) {
				if (!row.track) {
					continue
				}
				const track = row.track as unknown as Track
				const key = track.uniqueKey
				if (!deduped.has(key)) {
					deduped.set(key, {
						...track,
						historyId: row.id,
						playedAt: row.startTime,
					})
				}
			}
			return Array.from(deduped.values())
		},
		enabled: true,
		networkMode: 'always',
		staleTime: 0,
	})
}

export const usePlayHistoryByDayOfMonth = (dayOfMonth: number) => {
	return useQuery({
		queryKey: playHistoryKeys.byDayOfMonth(dayOfMonth),
		queryFn: async () => {
			const historyRows = await drizzleDb.query.playHistory.findMany({
				where: (ph, { sql }) => {
					const dayOfMonthSql = sql`strftime('%d', ${ph.startTime} / 1000, 'unixepoch', 'localtime')`
					return sql`${dayOfMonthSql} = ${String(dayOfMonth).padStart(2, '0')}`
				},
				with: {
					track: {
						with: {
							artist: true,
							bilibiliMetadata: true,
							localMetadata: true,
						},
					},
				},
				orderBy: [desc(schema.playHistory.startTime)],
			})

			// 过滤掉没有 track 的异常数据，并转换类型
			return historyRows
				.filter((row) => row.track !== null && row.track !== undefined)
				.map((row) => {
					const track = row.track as unknown as Track
					return {
						...track,
						historyId: row.id,
						playedAt: row.startTime,
					}
				})
		},
		enabled: !!dayOfMonth && dayOfMonth >= 1 && dayOfMonth <= 31,
		networkMode: 'always',
		staleTime: 0,
	})
}

export const useMostPlayedTracks = (days: number, limit: number) => {
	return useQuery({
		queryKey: playHistoryKeys.topPlayed(days, limit),
		queryFn: async () => {
			const result = await trackService.getMostPlayedTracksInLastDays({
				days,
				limit,
			})
			if (result.isErr()) {
				throw result.error
			}
			return result.value
		},
		enabled: true,
		networkMode: 'always',
		staleTime: 60 * 1000,
	})
}
