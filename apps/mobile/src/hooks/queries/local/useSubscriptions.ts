import { eq, and, sql } from 'drizzle-orm'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import db from '@/lib/db/db'
import { artists } from '@/lib/db/schema'

export const subscriptionQueryKeys = {
	all: ['local', 'subscriptions'] as const,
	subscribedArtists: () => [...subscriptionQueryKeys.all, 'subscribedArtists'] as const,
	isSubscribed: (remoteId: string) =>
		[...subscriptionQueryKeys.all, 'isSubscribed', remoteId] as const,
}

/**
 * 获取所有已订阅的 UP 主列表
 */
export const useSubscribedArtists = () => {
	return useQuery({
		queryKey: subscriptionQueryKeys.subscribedArtists(),
		queryFn: async () => {
			const result = await db
				.select()
				.from(artists)
				.where(eq(artists.subscribed, true))
				.orderBy(sql`COALESCE(${artists.subscribedAt}, 0) DESC`)
			return result
		},
		staleTime: 1000 * 60, // 1 分钟
	})
}

/**
 * 检查某个 UP 主是否已被订阅
 */
export const useIsSubscribed = (remoteId: string) => {
	return useQuery({
		queryKey: subscriptionQueryKeys.isSubscribed(remoteId),
		queryFn: async () => {
			const result = await db
				.select()
				.from(artists)
				.where(
					and(
						eq(artists.remoteId, remoteId),
						eq(artists.subscribed, true),
					),
				)
				.limit(1)
			return result.length > 0 ? result[0] : null
		},
		enabled: !!remoteId,
	})
}

/**
 * 订阅/取消订阅 UP 主
 */
export const useToggleSubscription = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: async ({
			remoteId,
			name,
			avatarUrl,
			signature,
			subscribe,
		}: {
			remoteId: string
			name: string
			avatarUrl?: string | null
			signature?: string | null
			subscribe: boolean
		}) => {
			if (subscribe) {
				// Upsert: 如果已存在则更新订阅状态，否则插入新记录
				const existing = await db
					.select()
					.from(artists)
					.where(
						and(
							eq(artists.source, 'bilibili'),
							eq(artists.remoteId, remoteId),
						),
					)
					.limit(1)

				if (existing.length > 0) {
					await db
						.update(artists)
						.set({
							subscribed: true,
							subscribedAt: new Date(),
							name,
							avatarUrl: avatarUrl ?? null,
							signature: signature ?? null,
							updatedAt: new Date(),
						})
						.where(eq(artists.id, existing[0].id))
				} else {
					await db.insert(artists).values({
						name,
						avatarUrl: avatarUrl ?? null,
						signature: signature ?? null,
						source: 'bilibili',
						remoteId,
						subscribed: true,
						subscribedAt: new Date(),
					})
				}
			} else {
				// 取消订阅：设为未订阅，但保留记录
				await db
					.update(artists)
					.set({
						subscribed: false,
						subscribedAt: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(artists.source, 'bilibili'),
							eq(artists.remoteId, remoteId),
						),
					)
			}
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({
				queryKey: subscriptionQueryKeys.subscribedArtists(),
			})
			queryClient.invalidateQueries({
				queryKey: subscriptionQueryKeys.isSubscribed(variables.remoteId),
			})
		},
	})
}
