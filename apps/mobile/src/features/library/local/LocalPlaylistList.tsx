import { Icon } from '@expo/ui'
import { LegendList } from '@legendapp/list/react-native'
import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { RefreshControl, StyleSheet, View } from 'react-native'
import { Icon as PaperIcon, Searchbar, Text, useTheme } from 'react-native-paper'

import FunctionalMenu from '@/components/common/FunctionalMenu'
import IconButton from '@/components/common/IconButton'
import { DataFetchingError } from '@/features/library/shared/DataFetchingError'
import { LocalPlaylistListSkeleton } from '@/features/library/skeletons/LibraryTabSkeleton'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import {
	usePlaylistLists,
	useSearchPlaylists,
} from '@/hooks/queries/db/playlist'
import useAppStore from '@/hooks/stores/useAppStore'
import { useModalStore } from '@/hooks/stores/useModalStore'
import { FAVORITE_PLAYLIST_TITLE } from '@/hooks/player/useLocalFavorite'
import type { Playlist } from '@/types/core/media'

import LocalPlaylistItem from './LocalPlaylistItem'

const CREATE_PLAYLIST_ICON = Icon.select({
	ios: 'plus.rectangle.on.rectangle',
	android: import('@expo/material-symbols/playlist_add.xml'),
})

const IMPORT_PLAYLIST_ICON = Icon.select({
	ios: 'link',
	android: import('@expo/material-symbols/link.xml'),
})

const SUBSCRIBE_PLAYLIST_ICON = Icon.select({
	ios: 'person.2',
	android: import('@expo/material-symbols/group.xml'),
})

const MERGE_PLAYLIST_ICON = Icon.select({
	ios: 'arrow.merge',
	android: import('@expo/material-symbols/merge.xml'),
})

const renderPlaylistItem = ({
	item,
}: {
	item: Playlist & { isToView?: boolean }
}) => <LocalPlaylistItem item={item} />

/**
 * 判断一个歌单是否为系统托管的「我的收藏」歌单。
 * 它在 DB 中是一张 `type:'local'` 的普通歌单（标题见 FAVORITE_PLAYLIST_TITLE），
 * 不应出现在「播放列表」列表中（收藏有独立的展示入口）。
 */
function isFavoritePlaylist(
	playlist: Playlist | (Playlist & { isToView?: boolean }),
): boolean {
	return playlist.type === 'local' && playlist.title === FAVORITE_PLAYLIST_TITLE
}

/** 从歌单列表中剔除「我的收藏」歌单。 */
function excludeFavoritePlaylist<T extends Playlist | (Playlist & { isToView?: boolean })>(
	playlists: T[] | undefined,
): T[] {
	if (!playlists) return []
	return playlists.filter((playlist) => !isFavoritePlaylist(playlist))
}

const LocalPlaylistListComponent = memo(() => {
	const { colors } = useTheme()
	const haveTrack = useCurrentTrack()
	const [refreshing, setRefreshing] = useState(false)
	const [searchQuery, setSearchQuery] = useState('')
	const [menuVisible, setMenuVisible] = useState(false)
	const deferredSearchQuery = useDeferredValue(searchQuery)
	const openModal = useModalStore((state) => state.open)
	const hasBilibiliCookie = useAppStore((state) => state.hasBilibiliCookie)

	const {
		data: playlists,
		isPending: playlistsIsPending,
		isRefetching: playlistsIsRefetching,
		refetch,
		isError: playlistsIsError,
	} = usePlaylistLists()

	const { data: searchResults } = useSearchPlaylists(deferredSearchQuery, true)

	const finalPlaylists = useMemo(() => {
		if (deferredSearchQuery.trim()) {
			// 搜索结果同样剔除「我的收藏」歌单
			return excludeFavoritePlaylist(searchResults)
		}

		if (!playlists) return []

		if (!hasBilibiliCookie()) return excludeFavoritePlaylist(playlists)
		return [
			{
				id: 1145141919810,
				title: '稍后再看',
				author: null,
				description: null,
				coverUrl: null,
				itemCount: 0,
				type: 'favorite',
				remoteSyncId: null,
				lastSyncedAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
				isToView: true,
			},
			...excludeFavoritePlaylist(playlists),
		] as (Playlist & { isToView?: boolean })[]
	}, [hasBilibiliCookie, playlists, deferredSearchQuery, searchResults])

	const keyExtractor = useCallback((item: Playlist) => item.id.toString(), [])

	const onRefresh = async () => {
		setRefreshing(true)
		await refetch()
		setRefreshing(false)
	}

	if (playlistsIsPending) {
		return <LocalPlaylistListSkeleton />
	}

	if (playlistsIsError) {
		return (
			<DataFetchingError
				text='加载失败'
				onRetry={() => onRefresh()}
			/>
		)
	}

	return (
		<View style={styles.container}>
			<View style={styles.headerContainer}>
				<Text
					variant='titleMedium'
					style={styles.headerTitle}
				>
					播放列表
				</Text>
				<View style={styles.headerActionsContainer}>
					<Text variant='bodyMedium'>
						{excludeFavoritePlaylist(playlists).length ?? 0}&thinsp;个播放列表
					</Text>
					<FunctionalMenu
						visible={menuVisible}
						onDismiss={() => setMenuVisible(false)}
						anchor={
							<IconButton
								icon='plus'
								size={20}
								onPress={() => setMenuVisible(true)}
							/>
						}
					>
						<FunctionalMenu.Item
							leadingIcon={CREATE_PLAYLIST_ICON}
							onPress={() => {
								setMenuVisible(false)
								openModal('CreatePlaylist', { redirectToNewPlaylist: true })
							}}
							title='新建播放列表'
						/>
						<FunctionalMenu.Item
							leadingIcon={IMPORT_PLAYLIST_ICON}
							onPress={() => {
								setMenuVisible(false)
								openModal('InputExternalPlaylistInfo', undefined)
							}}
							title='导入外部歌单'
						/>
						<FunctionalMenu.Item
							leadingIcon={SUBSCRIBE_PLAYLIST_ICON}
							onPress={() => {
								setMenuVisible(false)
								openModal('SubscribeToSharedPlaylist', undefined)
							}}
							title='订阅共享歌单'
						/>
						<FunctionalMenu.Item
							leadingIcon={MERGE_PLAYLIST_ICON}
							onPress={() => {
								setMenuVisible(false)
								openModal('MergePlaylists', undefined)
							}}
							title='动态合并歌单'
						/>
					</FunctionalMenu>
				</View>
			</View>
			<Searchbar
				placeholder='搜索播放列表'
				onChangeText={setSearchQuery}
				value={searchQuery}
				mode='bar'
				style={styles.searchbar}
				inputStyle={styles.searchInput}
			/>
			<View
				style={{
					flex: 1,
					opacity: searchQuery !== deferredSearchQuery ? 0.5 : 1,
				}}
			>
				<LegendList
					contentContainerStyle={{ paddingBottom: haveTrack ? 90 : 10 }}
					showsVerticalScrollIndicator={false}
					data={finalPlaylists ?? []}
					renderItem={renderPlaylistItem}
					recycleItems
					refreshControl={
						<RefreshControl
							refreshing={refreshing || playlistsIsRefetching}
							onRefresh={onRefresh}
							colors={[colors.primary]}
							progressViewOffset={50}
						/>
					}
					keyExtractor={keyExtractor}
					ListFooterComponent={
						<Text
							variant='titleMedium'
							style={styles.listFooter}
						>
							•
						</Text>
					}
				ListEmptyComponent={
					<View style={styles.emptyContainer}>
						<PaperIcon
							source='inbox'
							size={48}
							color={colors.onSurfaceVariant}
						/>
						<Text
							variant='titleMedium'
							style={styles.emptyText}
						>
							还没有播放列表
						</Text>
						<Text
							variant='bodyMedium'
							style={{ color: colors.onSurfaceVariant }}
						>
							新建一个，把喜欢的音频收进来
						</Text>
					</View>
				}
				/>
			</View>
		</View>
	)
})

const styles = StyleSheet.create({
	container: {
		flex: 1,
		marginHorizontal: 16,
	},
	headerContainer: {
		height: 48,
		marginBottom: 8,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	headerTitle: {
		fontWeight: 'bold',
	},
	headerActionsContainer: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	searchInput: {
		alignSelf: 'center',
	},
	searchbar: {
		borderRadius: 9999,
		textAlign: 'center',
		height: 45,
		marginBottom: 20,
		marginTop: 10,
	},
	listFooter: {
		textAlign: 'center',
		paddingTop: 10,
	},
	emptyContainer: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		paddingTop: 80,
		gap: 8,
	},
	emptyText: {
		textAlign: 'center',
	},
})

LocalPlaylistListComponent.displayName = 'LocalPlaylistListComponent'

export default LocalPlaylistListComponent
