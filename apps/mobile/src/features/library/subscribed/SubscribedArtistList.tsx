import { useRouter } from 'expo-router'
import { memo, useCallback, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { Avatar, Text, TouchableRipple, useTheme } from 'react-native-paper'

import ActivityIndicator from '@/components/common/ActivityIndicator'
import { DataFetchingError } from '@/features/library/shared/DataFetchingError'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import { useSubscribedArtists } from '@/hooks/queries/local/useSubscriptions'
import type { BilibiliUserInfo } from '@/types/apis/bilibili'
import { resolveBilibiliImageUrl } from '@/utils/imageUrl'

const SubscribedArtistListItem = memo(
	({
		item,
		onPress,
	}: {
		item: {
			id: number
			name: string
			avatarUrl: string | null
			signature: string | null
			remoteId: string | null
		}
		onPress: (remoteId: string) => void
	}) => {
		const { colors } = useTheme()
		const handlePress = () => {
			if (item.remoteId) onPress(item.remoteId)
		}
		return (
			<TouchableRipple onPress={handlePress} style={styles.artistItem}>
				<Avatar.Image
					size={48}
					source={{ uri: resolveBilibiliImageUrl(item.avatarUrl) }}
				/>
				<View style={styles.artistInfo}>
					<Text
						variant='titleSmall'
						numberOfLines={1}
					>
						{item.name}
					</Text>
					{item.signature ? (
						<Text
							variant='bodySmall'
							numberOfLines={1}
							style={{ color: colors.onSurfaceVariant }}
						>
							{item.signature}
						</Text>
					) : null}
				</View>
			</TouchableRipple>
		)
	},
)

const SubscribedArtistListComponent = memo(() => {
	const router = useRouter()
	const { colors } = useTheme()
	const haveTrack = useCurrentTrack()
	const [refreshing, setRefreshing] = useState(false)

	const {
		data: subscribedArtists,
		isPending,
		isError,
		refetch,
	} = useSubscribedArtists()

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
				id: number
				name: string
				avatarUrl: string | null
				signature: string | null
				remoteId: string | null
			}
		}) => (
			<SubscribedArtistListItem
				item={item}
				onPress={(remoteId) => {
					router.push(`/playlist/remote/uploader/${remoteId}`)
				}}
			/>
		),
		[router],
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
				data={subscribedArtists}
				renderItem={renderItem}
				keyExtractor={(item) => String(item.id)}
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
							还没有订阅任何 UP 主
						</Text>
						<Text
							variant='bodyMedium'
							style={{ color: colors.onSurfaceVariant }}
						>
							在 UP 主作品页面点击 + 即可订阅
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
	artistItem: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 10,
		gap: 12,
	},
	artistInfo: {
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

export default SubscribedArtistListComponent
