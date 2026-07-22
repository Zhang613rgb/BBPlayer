import dayjs from 'dayjs'
import { memo, useCallback, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { Avatar, Text, useTheme } from 'react-native-paper'

import ActivityIndicator from '@/components/common/ActivityIndicator'
import { DataFetchingError } from '@/features/library/shared/DataFetchingError'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import { useLocalBilibiliTracks } from '@/hooks/queries/local/useLocalBilibiliTracks'
import { resolveBilibiliImageUrl } from '@/utils/imageUrl'

const LocalSavedTrackItem = memo(
	({
		item,
	}: {
		item: {
			track: { id: number; title: string; coverUrl: string | null; createdAt: number }
			artist: { name: string; avatarUrl: string | null } | null
			addedAt: number
		}
	}) => {
		return (
			<View style={styles.trackItem}>
				<Avatar.Image
					size={44}
					source={{ uri: resolveBilibiliImageUrl(item.track.coverUrl) }}
				/>
				<View style={styles.trackInfo}>
					<Text
						variant='titleSmall'
						numberOfLines={1}
					>
						{item.track.title}
					</Text>
					<Text
						variant='bodySmall'
						numberOfLines={1}
					>
						{item.artist?.name ?? '未知'}
						{' · '}
						{dayjs(item.addedAt).format('MM-DD HH:mm')}
					</Text>
				</View>
			</View>
		)
	},
)

const LocalSavedTracksListComponent = memo(() => {
	const { colors } = useTheme()
	const haveTrack = useCurrentTrack()
	const [refreshing, setRefreshing] = useState(false)

	const {
		data: savedTracks,
		isPending,
		isError,
		refetch,
	} = useLocalBilibiliTracks()

	const onRefresh = async () => {
		setRefreshing(true)
		await refetch()
		setRefreshing(false)
	}

	const renderItem = useCallback(
		({
			item,
		}: {
			item: {
				track: { id: number; title: string; coverUrl: string | null; createdAt: number }
				artist: { name: string; avatarUrl: string | null } | null
				addedAt: number
			}
		}) => <LocalSavedTrackItem item={item} />,
		[],
	)

	if (isPending) {
		return <ActivityIndicator />
	}

	if (isError) {
		return (
			<DataFetchingError
				text='加载失败'
				onRetry={() => onRefresh()}
			/>
		)
	}

	return (
		<View
			style={[
				styles.container,
				{ paddingBottom: haveTrack ? 56 : 0 },
			]}
		>
			<FlatList
				data={savedTracks}
				renderItem={renderItem}
				keyExtractor={(item) => String(item.track.id)}
				contentContainerStyle={styles.listContent}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={onRefresh}
						colors={[colors.primary]}
					/>
				}
				ListEmptyComponent={
					<View style={styles.emptyContainer}>
						<Text
							variant='titleMedium'
							style={styles.emptyText}
						>
							还没有收藏任何 B 站歌曲
						</Text>
						<Text
							variant='bodyMedium'
							style={{ color: colors.onSurfaceVariant }}
						>
							搜索或浏览 UP 主作品，添加到本地播放列表即可
						</Text>
					</View>
				}
			/>
		</View>
	)
})

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	listContent: {
		paddingHorizontal: 16,
		paddingTop: 8,
	},
	trackItem: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 8,
		gap: 12,
	},
	trackInfo: {
		flex: 1,
		gap: 2,
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

export default LocalSavedTracksListComponent
