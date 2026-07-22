import { desc, eq, and, isNull } from 'drizzle-orm'
import { useQuery } from '@tanstack/react-query'

import db from '@/lib/db/db'
import { playlists, playlistTracks, tracks, artists } from '@/lib/db/schema'

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
			// 获取所有本地 playlist 中的 bilibili track，去重并按添加时间倒序
			const result = await db
				.select({
					track: tracks,
					artist: artists,
					addedAt: playlistTracks.createdAt,
				})
				.from(playlistTracks)
				.innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
				.innerJoin(
					playlists,
					eq(playlistTracks.playlistId, playlists.id),
				)
				.leftJoin(artists, eq(tracks.artistId, artists.id))
				.where(
					and(
						eq(tracks.source, 'bilibili'),
						isNull(playlists.remoteSyncId), // 只显示纯本地 playlist
					),
				)
				.orderBy(desc(playlistTracks.createdAt))

			// 去重 (相同 track.id 只保留最新添加的那个)
			const seen = new Set<number>()
			return result.filter((row) => {
				if (seen.has(row.track.id)) return false
				seen.add(row.track.id)
				return true
			})
		},
		staleTime: 1000 * 30, // 30秒
	})
}
