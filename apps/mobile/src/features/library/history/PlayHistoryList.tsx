import dayjs from 'dayjs'
import { memo, useCallback, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { Avatar, Text, useTheme } from 'react-native-paper'

import ActivityIndicator from '@/components/common/ActivityIndicator'
import { DataFetchingError } from '@/features/library/shared/DataFetchingError'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import { useAllPlayHistory, type HistoryTrack } from '@/hooks/queries/playHistory'
import { resolveBilibiliImageUrl } from '@/utils/imageUrl'

const HistoryTrackItem = memo(
	({ item }: { item: HistoryTrack }) => {
		const coverUrl =
			item.coverUrl ?? item.artist?.avatarUrl ?? null
		const artistName = item.artist?.name ?? '未知'
		return (
			<View style={styles.trackItem}>
				<Avatar.Image
					size={44}
					source={{ uri: resolveBilibiliImageUrl(coverUrl) }}
				/>
				<View style={styles.trackInfo}>
					<Text
						variant='titleSmall'
						numberOfLines={1}
					>
						{item.title}
					</Text>
					<Text
						variant='bodySmall'
						numberOfLines={1}
					>
						{artistName}
						{item.playedAt
							? ` · ${dayjs(item.playedAt).format('MM-DD HH:mm')}`
							: ''}
					</Text>
				</View>
			</View>
		)
	},
)

const PlayHistoryListComponent = memo(() => {
	const { colors } = useTheme()
	const haveTrack = useCurrentTrack()
	const [refreshing, setRefreshing] = useState(false)

	const {
		data: historyTracks,
		isPending,
		isError,
		refetch,
	} = useAllPlayHistory()

	const onRefresh = async () => {
		setRefreshing(true)
		await refetch()
		setRefreshing(false)
	}

	const renderItem = useCallback(
		({ item }: { item: HistoryTrack }) => (
			<HistoryTrackItem item={item} />
		),
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
			<View style={styles.headerContainer}>
				<Text
					variant='titleMedium'
					style={styles.headerTitle}
				>
					全部历史
				</Text>
			</View>
			<FlatList
				data={historyTracks}
				renderItem={renderItem}
				keyExtractor={(item) => item.uniqueKey}
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
							还没有播放记录
						</Text>
						<Text
							variant='bodyMedium'
							style={{ color: colors.onSurfaceVariant }}
						>
							播放 B 站歌曲后自动记录
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
	headerContainer: {
		paddingHorizontal: 16,
		paddingTop: 12,
		paddingBottom: 4,
	},
	headerTitle: {
		fontWeight: 'bold',
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

export default PlayHistoryListComponent
