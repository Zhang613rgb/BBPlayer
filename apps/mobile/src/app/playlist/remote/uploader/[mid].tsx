import { useImage } from 'expo-image'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { RefreshControl, StyleSheet, View } from 'react-native'
import { Appbar, useTheme } from 'react-native-paper'
import { Searchbar as SearchBar } from 'react-native-paper'
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from 'react-native-reanimated'

import NowPlayingBar from '@/components/NowPlayingBar'
import { PlaylistError } from '@/features/playlist/remote/components/PlaylistError'
import { PlaylistHeader } from '@/features/playlist/remote/components/PlaylistHeader'
import { TrackList } from '@/features/playlist/remote/components/RemoteTrackList'
import { usePlaylistMenu } from '@/features/playlist/remote/hooks/usePlaylistMenu'
import { useRemotePlaylist } from '@/features/playlist/remote/hooks/useRemotePlaylist'
import { useTrackSelection } from '@/features/playlist/remote/hooks/useTrackSelection'
import { PlaylistPageSkeleton } from '@/features/playlist/skeletons/PlaylistSkeleton'
import {
	useInfiniteGetUserUploadedVideos,
	useOtherUserInfo,
} from '@/hooks/queries/bilibili/user'
import {
	useIsSubscribed,
	useToggleSubscription,
} from '@/hooks/queries/local/useSubscriptions'
import usePreventRemove from '@/hooks/router/usePreventRemove'
import { useModalStore } from '@/hooks/stores/useModalStore'
import { useDoubleTapScrollToTop } from '@/hooks/ui/useDoubleTapScrollToTop'
import { usePlaylistBackgroundColor } from '@/hooks/ui/usePlaylistBackgroundColor'
import { useDebouncedValue } from '@/hooks/utils/useDebouncedValue'
import { bv2av } from '@/lib/api/bilibili/utils'
import type {
	BilibiliUserInfo,
	BilibiliUserUploadedVideosResponse,
} from '@/types/apis/bilibili'
import type { BilibiliTrack, Track } from '@/types/core/media'
import { resolveBilibiliImageUrl } from '@/utils/imageUrl'
import { formatMMSSToSeconds } from '@/utils/time'

const SEARCHBAR_HEIGHT = 72

const mapApiItemToTrack = (
	apiItem: BilibiliUserUploadedVideosResponse['list']['vlist'][0],
	uploaderData: BilibiliUserInfo,
): BilibiliTrack => {
	return {
		id: bv2av(apiItem.bvid),
		uniqueKey: `bilibili::${apiItem.bvid}`,
		source: 'bilibili',
		title: apiItem.title,
		artist: {
			id: uploaderData.mid,
			name: uploaderData.name,
			avatarUrl: uploaderData.face,
			source: 'bilibili',
			remoteId: uploaderData.mid.toString(),
			createdAt: new Date(apiItem.created),
			updatedAt: new Date(apiItem.created),
		},
		coverUrl: apiItem.pic,
		duration: formatMMSSToSeconds(apiItem.length),
		bilibiliMetadata: {
			bvid: apiItem.bvid,
			cid: null,
			isMultiPage: false,
			videoIsValid: true,
		},
		createdAt: new Date(apiItem.created),
		updatedAt: new Date(apiItem.created),
	}
}

export default function UploaderPage() {
	const { mid } = useLocalSearchParams<{ mid: string }>()
	const theme = useTheme()
	const { colors } = theme
	const router = useRouter()
	const [refreshing, setRefreshing] = useState(false)

	const {
		selected,
		selectMode,
		toggle,
		enterSelectMode,
		exitSelectMode,
		setSelected,
	} = useTrackSelection()

	const selection = useMemo(
		() => ({
			active: selectMode,
			selected,
			toggle,
			enter: enterSelectMode,
		}),
		[selectMode, selected, toggle, enterSelectMode],
	)

	const [searchQuery, setSearchQuery] = useState('')
	const [startSearch, setStartSearch] = useState(false)
	const searchbarHeight = useSharedValue(0)
	const debouncedQuery = useDebouncedValue(searchQuery, 200)
	const openModal = useModalStore((state) => state.open)

	const { listRef, handleDoubleTap } = useDoubleTapScrollToTop()

	const searchbarAnimatedStyle = useAnimatedStyle(() => ({
		height: searchbarHeight.value,
	}))

	useEffect(() => {
		searchbarHeight.set(
			withTiming(startSearch ? SEARCHBAR_HEIGHT : 0, { duration: 180 }),
		)
	}, [searchbarHeight, startSearch])

	const {
		data: uploadedVideos,
		isPending: isUploadedVideosPending,
		isError: isUploadedVideosError,
		fetchNextPage,
		refetch,
		hasNextPage,
	} = useInfiniteGetUserUploadedVideos(Number(mid), debouncedQuery)

	const {
		data: uploaderUserInfo,
		isPending: isUserInfoPending,
		isError: isUserInfoError,
	} = useOtherUserInfo(Number(mid))

	const tracks = useMemo(() => {
		if (!uploadedVideos || !uploaderUserInfo) return []
		return uploadedVideos.pages
			.flatMap((page) => page.list.vlist)
			.map((item) => mapApiItemToTrack(item, uploaderUserInfo))
	}, [uploadedVideos, uploaderUserInfo])

	const coverRef = useImage(
		resolveBilibiliImageUrl(uploaderUserInfo?.face) ?? '',
		{
			onError: () => void 0,
		},
	)
	const {
		backgroundColor,
		nowPlayingBarColor,
		primaryButtonColor,
		primaryButtonTextColor,
		secondaryButtonContainerColor,
		secondaryButtonIconColor,
	} = usePlaylistBackgroundColor(coverRef, theme.dark, colors.background)

	const { playTrack } = useRemotePlaylist()

	const trackMenuItems = usePlaylistMenu(playTrack)

	const { data: subscribedInfo } = useIsSubscribed(mid ?? '')
	const toggleSubscription = useToggleSubscription()
	const isSubscribed = !!subscribedInfo
	const subCount = subscribedInfo?.subscriberCount ?? 0

	useEffect(() => {
		if (typeof mid !== 'string') {
			router.replace('/+not-found')
		}
	}, [mid, router])

	usePreventRemove(startSearch || selectMode, () => {
		if (startSearch) setStartSearch(false)
		if (selectMode) exitSelectMode()
	})

	if (typeof mid !== 'string') {
		return null
	}

	if (isUserInfoPending) {
		return <PlaylistPageSkeleton />
	}

	if (isUploadedVideosPending && !startSearch) {
		return <PlaylistPageSkeleton />
	}

	if (isUploadedVideosError || isUserInfoError) {
		return <PlaylistError text='加载失败' />
	}

	return (
		<View style={[styles.container, { backgroundColor }]}>
			<Appbar.Header
				elevated
				style={{ backgroundColor: 'transparent' }}
			>
				<Appbar.Content
					title={
						selectMode
							? `已选择\u2009${selected.size}\u2009首`
							: uploaderUserInfo.name
					}
					onPress={handleDoubleTap}
				/>
				<Appbar.BackAction onPress={() => router.back()} />
				{selectMode ? (
					<>
						<Appbar.Action
							icon='select-all'
							onPress={() => setSelected(new Set(tracks.map((t) => t.id)))}
						/>
						<Appbar.Action
							icon='select-compare'
							onPress={() =>
								setSelected(
									new Set(
										tracks.filter((t) => !selected.has(t.id)).map((t) => t.id),
									),
								)
							}
						/>
						<Appbar.Action
							icon='playlist-plus'
							onPress={() => {
								const payloads = []
								for (const id of selected) {
									const track = tracks.find((t) => t.id === id)
									if (track) {
										payloads.push({
											track: track as Track,
											artist: track.artist!,
										})
									}
								}
								openModal('BatchAddTracksToLocalPlaylist', {
									payloads,
								})
							}}
						/>
					</>
				) : (
					<Appbar.Action
						icon={startSearch ? 'close' : 'magnify'}
						onPress={() => setStartSearch((prev) => !prev)}
					/>
				)}
			</Appbar.Header>

			{/* 搜索框 */}
			<Animated.View
				style={[styles.searchbarContainer, searchbarAnimatedStyle]}
			>
				<SearchBar
					placeholder='搜索歌曲'
					onChangeText={setSearchQuery}
					value={searchQuery}
				/>
			</Animated.View>

			<View style={styles.listContainer}>
				<TrackList
					listRef={listRef}
					tracks={tracks ?? []}
					playTrack={playTrack}
					trackMenuItems={trackMenuItems}
					selection={selection}
					ListHeaderComponent={
						<PlaylistHeader
							cover={coverRef ?? undefined}
							title={uploaderUserInfo.name}
							subtitles={`${uploadedVideos?.pages[0].page.count ?? 0}\u2009首歌曲`}
							description={uploaderUserInfo.sign}
							onClickMainButton={
								uploaderUserInfo && !toggleSubscription.isPending
									? () => {
											toggleSubscription.mutate({
												remoteId: mid,
												name: uploaderUserInfo.name,
												avatarUrl: uploaderUserInfo.face,
												signature: uploaderUserInfo.sign,
												subscribe: !isSubscribed,
											})
										}
									: undefined
							}
							mainButtonIcon={isSubscribed ? 'check' : 'plus'}
							mainButtonText={isSubscribed ? '已订阅' : '订阅'}
							id={Number(mid)}
							primaryButtonColor={primaryButtonColor}
							primaryButtonTextColor={primaryButtonTextColor}
							secondaryButtonContainerColor={secondaryButtonContainerColor}
							secondaryButtonIconColor={secondaryButtonIconColor}
						/>
					}
					refreshControl={
						<RefreshControl
							refreshing={refreshing}
							onRefresh={async () => {
								setRefreshing(true)
								await refetch()
								setRefreshing(false)
							}}
							colors={[colors.primary]}
							progressViewOffset={50}
						/>
					}
					onEndReached={hasNextPage ? () => fetchNextPage() : undefined}
					hasNextPage={hasNextPage}
				/>
			</View>
			<View style={styles.nowPlayingBarContainer}>
				<NowPlayingBar backgroundColor={nowPlayingBarColor} />
			</View>
		</View>
	)
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	searchbarContainer: {
		overflow: 'hidden',
	},
	listContainer: {
		flex: 1,
	},
	nowPlayingBarContainer: {
		position: 'absolute',
		bottom: 0,
		left: 0,
		right: 0,
	},
})
