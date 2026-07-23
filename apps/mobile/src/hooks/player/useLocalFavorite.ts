import { useCallback, useEffect, useState } from 'react'
import { and, eq } from 'drizzle-orm'

import drizzleDb from '@/lib/db/db'
import { playlistTracks, playlists } from '@/lib/db/schema'
import { playlistService } from '@/lib/services/playlistService'
import { trackService } from '@/lib/services/trackService'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import type { CreateTrackPayload } from '@/types/services/track'
import type { Track } from '@/types/core/media'

const FAV_TITLE = '我的收藏'

async function getOrCreateFavPlaylistId(): Promise<number> {
	const existing = await drizzleDb.query.playlists.findFirst({
		where: and(eq(playlists.title, FAV_TITLE), eq(playlists.type, 'local')),
		columns: { id: true },
	})
	if (existing) return existing.id
	const created = await playlistService.createPlaylist({ title: FAV_TITLE, type: 'local' })
	if (created.isErr()) throw created.error
	return created.value.id
}

function toPayload(track: Track): CreateTrackPayload | null {
	if (track.source === 'bilibili') {
		const m = track.bilibiliMetadata
		if (!m?.bvid) return null
		return {
			source: 'bilibili',
			title: track.title,
			coverUrl: track.coverUrl,
			duration: track.duration,
			bilibiliMetadata: {
				bvid: m.bvid,
				isMultiPage: m.isMultiPage,
				cid: m.cid,
				videoIsValid: m.videoIsValid,
				mainTrackTitle: m.mainTrackTitle ?? null,
			},
		}
	}
	if (track.source === 'local') {
		const lm = track.localMetadata
		if (!lm?.localPath) return null
		return {
			source: 'local',
			title: track.title,
			coverUrl: track.coverUrl,
			duration: track.duration,
			localMetadata: { localPath: lm.localPath },
		}
	}
	return null
}

/**
 * 本地收藏（免登录，pipepipe 式）。
 * 将当前曲目在名为「我的收藏」的本地歌单中增删，无需 B 站账号。
 */
export function useLocalFavorite() {
	const currentTrack = useCurrentTrack()
	const [isFavorited, setIsFavorited] = useState(false)
	const [isPending, setIsPending] = useState(false)

	useEffect(() => {
		let cancelled = false
		const track = currentTrack
		if (!track) {
			setIsFavorited(false)
			return
		}
		void (async () => {
			try {
				const favId = await getOrCreateFavPlaylistId()
				const payload = toPayload(track)
				if (!payload) {
					if (!cancelled) setIsFavorited(false)
					return
				}
				const trackRes = await trackService.findOrCreateTrack(payload)
				if (trackRes.isErr()) {
					if (!cancelled) setIsFavorited(false)
					return
				}
				const trackId = trackRes.value.id
				const link = await drizzleDb.query.playlistTracks.findFirst({
					where: and(
						eq(playlistTracks.playlistId, favId),
						eq(playlistTracks.trackId, trackId),
					),
					columns: { trackId: true },
				})
				if (!cancelled) setIsFavorited(!!link)
			} catch {
				if (!cancelled) setIsFavorited(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [currentTrack?.uniqueKey])

	const toggle = useCallback(async () => {
		const track = currentTrack
		if (!track) return
		setIsPending(true)
		try {
			const favId = await getOrCreateFavPlaylistId()
			const payload = toPayload(track)
			if (!payload) return
			const trackRes = await trackService.findOrCreateTrack(payload)
			if (trackRes.isErr()) return
			const trackId = trackRes.value.id
			const link = await drizzleDb.query.playlistTracks.findFirst({
				where: and(
					eq(playlistTracks.playlistId, favId),
					eq(playlistTracks.trackId, trackId),
				),
				columns: { trackId: true },
			})
			if (link) {
				await playlistService.batchRemoveTracksFromLocalPlaylist(favId, [trackId])
				setIsFavorited(false)
			} else {
				await playlistService.addManyTracksToLocalPlaylist(favId, [trackId])
				setIsFavorited(true)
			}
		} finally {
			setIsPending(false)
		}
	}, [currentTrack])

	return { isFavorited, isPending, toggle }
}
