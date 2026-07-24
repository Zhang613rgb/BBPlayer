import { desc } from 'drizzle-orm'
import { useQuery } from '@tanstack/react-query'

import db from '@/lib/db/db'
import { playlistTracks } from '@/lib/db/schema'
import type { Track } from '@/types/core/media'

export const localTrackQueryKeys = {
	all: ['local', 'bilibiliTracks'] as const,
	localSavedTracks: () => [...localTrackQueryKeys.all, 'saved'] as const,
}

/**
 * 获取本地保存的 B 站音轨（在本地 playlists 中的 bilibili 来源 track）
 */
export const useLocalBilibiliTracks = () => {
	return useQuery({
		queryKey: localTrackQueryKeys.localSavedTracks(),
		queryFn: async () => {
			// 关联查询：取出 playlistTracks 及其嵌套的 track（含 artist / bilibiliMetadata / localMetadata）
			const rows = await db.query.playlistTracks.findMany({
				with: {
					track: {
						with: {
							artist: true,
							bilibiliMetadata: true,
							localMetadata: true,
						},
					},
					playlist: true,
				},
				orderBy: [desc(playlistTracks.createdAt)],
			})

			// 只保留本地 playlist（remoteSyncId 为 null）中的 bilibili 曲目
			const filtered = rows.filter(
				(row) =>
					row.track?.source === 'bilibili' &&
					row.playlist?.remoteSyncId === null,
			)

			// 去重（相同 track.id 只保留最新添加的那个）
			const seen = new Set<number>()
			return filtered
				.filter((row) => {
					if (!row.track || seen.has(row.track.id)) return false
					seen.add(row.track.id)
					return {
						track: row.track as unknown as Track,
						artist: row.track.artist ?? null,
						addedAt: row.createdAt,
					}
				})
		},
		staleTime: 1000 * 30, // 30秒
	})
}
