import * as Sentry from '@sentry/react-native'
import type { SQL } from 'drizzle-orm'
import { and, count, desc, eq, inArray, lt, or, sql, sum } from 'drizzle-orm'
import { type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite'
import { Result, ResultAsync, err, errAsync, okAsync } from 'neverthrow'

import db from '@/lib/db/db'
import * as schema from '@/lib/db/schema'
import { ServiceError } from '@/lib/errors'
import {
	DatabaseError,
	createNotImplementedError,
	createTrackNotFound,
	createValidationError,
} from '@/lib/errors/service'
import type {
	BilibiliTrack,
	LocalTrack,
	PlayRecord,
	Track,
} from '@/types/core/media'
import type {
	BilibiliMetadataPayload,
	CreateBilibiliTrackPayload,
	CreateTrackPayload,
	CreateTrackPayloadBase,
	UpdateTrackPayload,
	UpdateTrackPayloadBase,
} from '@/types/services/track'
import log from '@/utils/log'

import generateUniqueTrackKey from './genKey'

const logger = log.extend('Service.Track')

/**
 * 历史记录合并窗口（秒）。
 * 同一首歌在窗口内再次触发收听结束事件（切歌/自动进阶/替换队列项等导致的重复触发），
 * 视为同一次收听会话，只更新已有记录而非新增，避免产生零碎重复历史。
 */
const HISTORY_MERGE_WINDOW_SEC = 60
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DBLike = ExpoSQLiteDatabase<typeof schema> | Tx
type SelectTrackBase = typeof schema.tracks.$inferSelect
type SelectTrackWithMetadata = SelectTrackBase & {
	artist: typeof schema.artists.$inferSelect | null
	bilibiliMetadata: typeof schema.bilibiliMetadata.$inferSelect | null
	localMetadata: typeof schema.localMetadata.$inferSelect | null
}

export class TrackService {
	constructor(private readonly db: DBLike) {}

	/**
	 * 返回一个使用新数据库连接（例如事务）的新实例。
	 * @param conn - 新的数据库连接或事务。
	 * @returns 一个新的实例。
	 */
	withDB(conn: DBLike) {
		return new TrackService(conn)
	}

	/**
	 * 基本上是为了让 Typescript 开心
	 * @param dbTrack
	 * @returns
	 */
	public formatTrack(
		dbTrack: SelectTrackWithMetadata | undefined | null,
	): Track | null {
		if (!dbTrack) {
			return null
		}

		const baseTrack = {
			id: dbTrack.id,
			uniqueKey: dbTrack.uniqueKey,
			title: dbTrack.title,
			artist: dbTrack.artist,
			coverUrl: dbTrack.coverUrl,
			duration: dbTrack.duration,
			createdAt: dbTrack.createdAt,
			source: dbTrack.source,
			updatedAt: dbTrack.updatedAt,
		}

		if (dbTrack.source === 'bilibili' && dbTrack.bilibiliMetadata) {
			return {
				...baseTrack,
				bilibiliMetadata: dbTrack.bilibiliMetadata,
			} as BilibiliTrack
		}

		if (dbTrack.source === 'local' && dbTrack.localMetadata) {
			return {
				...baseTrack,
				localMetadata: dbTrack.localMetadata,
			} as LocalTrack
		}

		logger.warning(`track ${dbTrack.id} 存在不一致的 source 和 metadata。`)
		return null
	}

	/**
	 * 创建一个新的 track
	 * @param payload - 创建 track 所需的数据。
	 * @returns ResultAsync 包含成功创建的 Track 或一个错误。
	 */
	private _createTrack(
		payload: CreateTrackPayload,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		// validate
		if (payload.source === 'bilibili' && !payload.bilibiliMetadata) {
			return errAsync(
				createValidationError(
					'当 source 为 bilibili 时，bilibiliMetadata 不能为空。',
				),
			)
		}
		if (payload.source === 'local' && !payload.localMetadata) {
			return errAsync(
				createValidationError(
					'当 source 为 local 时，localMetadata 不能为空。',
				),
			)
		}

		const uniqueKey = generateUniqueTrackKey(payload)
		if (uniqueKey.isErr()) {
			return errAsync(uniqueKey.error)
		}

		const transactionResult = ResultAsync.fromPromise(
			(async () => {
				// 创建 track
				const [newTrack] = await Sentry.startSpan(
					{ name: 'db:insert:track', op: 'db' },
					() =>
						this.db
							.insert(schema.tracks)
							.values({
								title: payload.title,
								source: payload.source,
								artistId: payload.artistId,
								coverUrl: payload.coverUrl,
								duration: payload.duration,
								uniqueKey: uniqueKey.value,
							})
							.returning({ id: schema.tracks.id }),
				)

				const trackId = newTrack.id

				// 创建元数据
				if (payload.source === 'bilibili') {
					await Sentry.startSpan(
						{ name: 'db:insert:bilibiliMetadata', op: 'db' },
						() =>
							this.db.insert(schema.bilibiliMetadata).values({
								trackId,
								bvid: payload.bilibiliMetadata.bvid,
								cid: payload.bilibiliMetadata.cid,
								isMultiPage: payload.bilibiliMetadata.isMultiPage,
								mainTrackTitle: payload.bilibiliMetadata.mainTrackTitle,
								videoIsValid: payload.bilibiliMetadata.videoIsValid,
							} satisfies BilibiliMetadataPayload & {
								trackId: number
							}),
					)
				} else if (payload.source === 'local') {
					await Sentry.startSpan(
						{ name: 'db:insert:localMetadata', op: 'db' },
						() =>
							this.db.insert(schema.localMetadata).values({
								trackId,
								localPath: payload.localMetadata.localPath,
							}),
					)
				}

				return trackId
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('创建 track 事务失败', { cause: e }),
		)

		return transactionResult.andThen((newTrackId) =>
			this.getTrackById(newTrackId),
		)
	}

	/**
	 * 更新一个现有的 track 。
	 * @param payload - 更新 track 所需的数据。
	 * @returns ResultAsync 包含更新后的 Track 或一个错误。
	 */
	public updateTrack(
		payload: UpdateTrackPayload,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		const { id, ...dataToUpdate } = payload

		const updateResult = ResultAsync.fromPromise(
			(async () => {
				return await Sentry.startSpan(
					{ name: 'db:update:track', op: 'db' },
					() =>
						this.db
							.update(schema.tracks)
							.set({
								title: dataToUpdate.title ?? undefined,
								artistId: dataToUpdate.artistId,
								coverUrl: dataToUpdate.coverUrl,
								duration: dataToUpdate.duration,
							} satisfies Omit<UpdateTrackPayloadBase, 'id'>)
							.where(eq(schema.tracks.id, id)),
				)
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`更新 track 失败：${id}`, { cause: e }),
		)

		return updateResult.andThen(() => this.getTrackById(id))
	}

	/**
	 * 通过 ID 获取单个 track 的完整信息。
	 * @param id -  track 的数据库 ID。
	 * @returns ResultAsync
	 */
	public getTrackById(
		id: number,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:query:track', op: 'db' }, () =>
				this.db.query.tracks.findFirst({
					where: eq(schema.tracks.id, id),
					with: {
						artist: true,
						bilibiliMetadata: true,
						localMetadata: true,
					},
				}),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`查找 track 失败：${id}`, { cause: e }),
		).andThen((dbTrack) => {
			const result = this.formatTrack(dbTrack)
			if (!result) {
				return errAsync(createTrackNotFound(id))
			}
			return okAsync(result)
		})
	}

	/**
	 * 删除一个 track。
	 * @param id - 要删除的 track 的 ID。
	 * @returns ResultAsync
	 */
	public deleteTrack(
		id: number,
	): ResultAsync<{ deletedId: number }, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:delete:track', op: 'db' }, () =>
				this.db
					.delete(schema.tracks)
					.where(eq(schema.tracks.id, id))
					.returning({ deletedId: schema.tracks.id }),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`删除 track 失败：${id}`, { cause: e }),
		).andThen((results) => {
			const result = results[0]
			if (!result) {
				return errAsync(createTrackNotFound(id))
			}
			return okAsync(result)
		})
	}

	/**
	 * 为 track 增加一次播放记录。
	 * @param trackId -  track 的 ID。
	 * @param record - 播放记录。
	 * @returns ResultAsync 包含 true 或一个错误。
	 */
	public addPlayRecordFromTrackId(
		trackId: number,
		record: PlayRecord,
	): ResultAsync<true, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			(async () => {
				await Sentry.startSpan(
					{ name: 'db:insert:play_history', op: 'db' },
					() =>
						this.db.insert(schema.playHistory).values({
							trackId,
							startTime: record.startTime,
							durationPlayed: record.durationPlayed,
							completed: record.completed,
						}),
				)

				return true as const
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`增加播放记录失败：${trackId}`, {
							cause: e,
						}),
		)
	}

	public addPlayRecordFromUniqueKey(
		uniqueKey: string,
		record: PlayRecord,
	): ResultAsync<true, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			(async () => {
				const track = await this.findTrackIdsByUniqueKeys([uniqueKey])
				if (track.isErr()) {
					throw track.error
				}
				const trackId = track.value.get(uniqueKey)
				if (!trackId) {
					throw createTrackNotFound(uniqueKey)
				}

				await this.addPlayRecordFromTrackId(trackId, record)

				return true as const
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`增加播放记录失败：${uniqueKey}`, {
							cause: e,
						}),
		)
	}

	/**
	 * 获取某 track 最近的一条播放记录（按自增 id 降序，即最后写入的那条）。
	 * @param trackId - track 的数据库 ID。
	 * @returns ResultAsync 包含最近记录或 null（尚无记录）。
	 */
	public getLatestPlayRecordByTrackId(
		trackId: number,
	): ResultAsync<typeof schema.playHistory.$inferSelect | null, DatabaseError> {
		return ResultAsync.fromPromise(
			Sentry.startSpan(
				{ name: 'db:query:latestPlayRecord', op: 'db' },
				() =>
					this.db.query.playHistory.findFirst({
						where: eq(schema.playHistory.trackId, trackId),
						orderBy: [desc(schema.playHistory.id)],
					}),
			),
			(e) => new DatabaseError('获取最近播放记录失败', { cause: e }),
		)
	}

	/**
	 * 更新某条播放记录的部分字段。
	 * @param id - 播放记录 ID。
	 * @param patch - 需要更新的字段。
	 * @returns ResultAsync 包含 true 或一个错误。
	 */
	public updatePlayRecord(
		id: number,
		patch: Partial<{
			startTime: number
			durationPlayed: number
			completed: boolean
		}>,
	): ResultAsync<true, DatabaseError> {
		if (Object.keys(patch).length === 0) {
			return okAsync(true as const)
		}
		const setValues = {
			...(patch.startTime !== undefined ? { startTime: patch.startTime } : {}),
			...(patch.durationPlayed !== undefined
				? { durationPlayed: patch.durationPlayed }
				: {}),
			...(patch.completed !== undefined ? { completed: patch.completed } : {}),
		}

		return ResultAsync.fromPromise(
			Sentry.startSpan(
				{ name: 'db:update:playHistory', op: 'db' },
				() =>
					this.db
						.update(schema.playHistory)
						.set(setValues)
						.where(eq(schema.playHistory.id, id)),
			),
			(e) => new DatabaseError('更新播放记录失败', { cause: e }),
		).andThen(() => okAsync(true as const))
	}

	/**
	 * 写入播放记录，并在窗口内合并同一次收听会话，避免重复/零碎记录。
	 *
	 * 逻辑：
	 * 1. 解析 uniqueKey 得到 trackId（找不到则报错）。
	 * 2. 查该 track 最近一条记录，若其近似结束时间（startTime + durationPlayed）
	 *    距现在不超过 {@link HISTORY_MERGE_WINDOW_SEC}，视为同一次收听会话 → 更新该条
	 *    （startTime 取更早者、durationPlayed 取较大者、completed 取二者并集）。
	 * 3. 否则插入一条新记录。
	 *
	 * @param uniqueKey - track 的唯一键。
	 * @param record - 本次收听的播放记录（调用方已做好有效收听/完成态判定）。
	 * @returns ResultAsync 包含 true 或一个错误。
	 */
	public recordOrMergePlayHistory(
		uniqueKey: string,
		record: PlayRecord,
	): ResultAsync<true, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			(async () => {
				const trackIds = await this.findTrackIdsByUniqueKeys([uniqueKey])
				if (trackIds.isErr()) throw trackIds.error
				const trackId = trackIds.value.get(uniqueKey)
				if (!trackId) throw createTrackNotFound(uniqueKey)

				const latestResult = await this.getLatestPlayRecordByTrackId(trackId)
				if (latestResult.isErr()) throw latestResult.error
				const latest = latestResult.value

				const nowSec = Math.floor(Date.now() / 1000)
				const latestEndApprox = latest
					? latest.startTime + latest.durationPlayed
					: Number.NEGATIVE_INFINITY

				// 满足任一条件即视为同一次收听会话：
				// (a) 距上次记录的近似结束时间在窗口内（吸收「切歌/秒切」产生的连续触发，也兼容旧数据里 0 时长误记）；
				// (b) 本次会话起点与上次记录的起点在窗口内（吸收同一长曲目内被反复触发、且间隔超过窗口的「完成」事件）。
			const withinEndWindow = nowSec - latestEndApprox <= HISTORY_MERGE_WINDOW_SEC
			// latest 可能为 null（该 track 尚无播放记录），必须做空值守卫，
			// 否则首次播放时解引用 latest.startTime 会抛 TypeError 导致永远写不进历史。
			const withinStartWindow = latest
				? Math.abs(record.startTime - latest.startTime) <=
					HISTORY_MERGE_WINDOW_SEC
				: false

			if (latest && (withinEndWindow || withinStartWindow)) {
					// 同一次收听会话：合并而非新增
					const updateResult = await this.updatePlayRecord(latest.id, {
						startTime: Math.min(latest.startTime, record.startTime),
						durationPlayed: Math.max(
							latest.durationPlayed,
							record.durationPlayed,
						),
						completed: latest.completed || record.completed,
					})
					if (updateResult.isErr()) throw updateResult.error
				} else {
					const insertResult = await this.addPlayRecordFromTrackId(
						trackId,
						record,
					)
					if (insertResult.isErr()) throw insertResult.error
				}

				return true as const
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError(`记录或合并播放历史失败：${uniqueKey}`, {
							cause: e,
						}),
		)
	}

	/**
	 * 根据 Bilibili 的元数据获取 track 。
	 * @param bilibiliMeatadata
	 * @returns
	 */
	public getTrackByBilibiliMetadata(
		bilibiliMetadata: BilibiliMetadataPayload,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		const identifier = generateUniqueTrackKey({
			source: 'bilibili',
			bilibiliMetadata: bilibiliMetadata,
		})
		if (identifier.isErr()) {
			return errAsync(identifier.error)
		}
		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:query:track', op: 'db' }, () =>
				this.db.query.tracks.findFirst({
					where: (track, { eq }) => eq(track.uniqueKey, identifier.value),
					with: {
						artist: true,
						bilibiliMetadata: true,
						localMetadata: true,
					},
				}),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('根据 Bilibili 元数据查找 track 失败', {
							cause: e,
						}),
		).andThen((track) => {
			if (!track) {
				return errAsync(createTrackNotFound(`uniqueKey=${identifier.value}`))
			}

			const formattedTrack = this.formatTrack(track)
			if (!formattedTrack) {
				return errAsync(
					createValidationError(
						`根据 Bilibili 元数据查找 track 失败：元数据不匹配。`,
					),
				)
			}

			return okAsync(formattedTrack)
		})
	}

	/**
	 * 查找 track ，如果不存在则根据提供的 payload 创建一个新的。
	 * 唯一性检查基于 generateUniqueTrackKey 生成的唯一标识符。
	 * @param payload - 创建 track 所需的数据。
	 * @returns ResultAsync
	 */
	public findOrCreateTrack(
		payload: CreateTrackPayload,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		const uniqueKeyResult = generateUniqueTrackKey(payload)
		if (uniqueKeyResult.isErr()) {
			return errAsync(uniqueKeyResult.error)
		}
		const uniqueKey = uniqueKeyResult.value

		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:query:track', op: 'db' }, () =>
				this.db.query.tracks.findFirst({
					where: (track, { eq }) => eq(track.uniqueKey, uniqueKey),
					with: {
						artist: true,
						bilibiliMetadata: true,
						localMetadata: true,
					},
				}),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('根据 uniqueKey 查找 track 失败', {
							cause: e,
						}),
		)
			.andThen((dbTrack) => {
				if (dbTrack) {
					const formattedTrack = this.formatTrack(dbTrack)
					if (formattedTrack) {
						return okAsync(formattedTrack)
					}
					return errAsync(
						createValidationError(
							`已存在的 track ${dbTrack.id} source 与 metadata 不匹配`,
						),
					)
				}
				return errAsync(createTrackNotFound(uniqueKey))
			})
			.orElse((error) => {
				if (error instanceof ServiceError && error.type === 'TrackNotFound') {
					return this._createTrack(payload)
				}
				return errAsync(error)
			})
	}

	/**
	 * 批量查找或创建 tracks，并处理其关联的元数据。
	 *
	 * @param payloads - 要创建或查找的 track 数据。
	 * @param source - 所有 track 必须来自的同一个来源。
	 * @returns 如果操作成功，其中包含一个从 uniqueKey -> track ID 的映射。
	 */
	public findOrCreateManyTracks(
		payloads: CreateTrackPayload[],
		source: Track['source'],
	): ResultAsync<Map<string, number>, ServiceError | DatabaseError> {
		if (payloads.length === 0) {
			return okAsync(new Map<string, number>())
		}

		const processedPayloadsResult = Result.combine(
			payloads.map((p) => {
				if (p.source !== source)
					return err(createValidationError('source 不一致'))
				return generateUniqueTrackKey(p).map((uniqueKey) => ({
					uniqueKey,
					payload: p,
				}))
			}),
		)

		if (processedPayloadsResult.isErr()) {
			return errAsync(processedPayloadsResult.error)
		}

		// Deduplicate payloads based on uniqueKey
		const uniquePayloadsMap = new Map<
			string,
			{ uniqueKey: string; payload: CreateTrackPayload }
		>()
		for (const p of processedPayloadsResult.value) {
			if (!uniquePayloadsMap.has(p.uniqueKey)) {
				uniquePayloadsMap.set(p.uniqueKey, p)
			}
		}
		const processedPayloads = Array.from(uniquePayloadsMap.values())
		const uniqueKeys = processedPayloads.map((p) => p.uniqueKey)

		return ResultAsync.fromPromise(
			(async () => {
				const trackValuesToInsert = processedPayloads.map(
					({ uniqueKey, payload }) =>
						({
							title: payload.title,
							artistId: payload.artistId,
							coverUrl: payload.coverUrl,
							duration: payload.duration,
							uniqueKey: uniqueKey,
							source: payload.source,
						}) satisfies CreateTrackPayloadBase & {
							uniqueKey: string
							source: string
						},
				)

				if (trackValuesToInsert.length > 0) {
					await Sentry.startSpan(
						{ name: 'db:insert:many:tracks', op: 'db' },
						() =>
							this.db
								.insert(schema.tracks)
								.values(trackValuesToInsert)
								.onConflictDoNothing(),
					)
				}

				const allTracks = await Sentry.startSpan(
					{ name: 'db:query:many:tracks', op: 'db' },
					() =>
						this.db.query.tracks.findMany({
							where: and(inArray(schema.tracks.uniqueKey, uniqueKeys)),
							columns: {
								id: true,
								uniqueKey: true,
							},
						}),
				)

				const finalUniqueKeyToIdMap = new Map(
					allTracks.map((t) => [t.uniqueKey, t.id]),
				)

				if (finalUniqueKeyToIdMap.size !== uniqueKeys.length) {
					throw new DatabaseError(
						'创建或查找 tracks 后数据不一致，部分 track 未能成功写入或查询。',
					)
				}

				switch (source) {
					case 'bilibili': {
						const bilibiliMetadataValues = processedPayloads.map(
							({ uniqueKey, payload }) => {
								const trackId = finalUniqueKeyToIdMap.get(uniqueKey)
								if (!trackId) {
									throw new ServiceError(
										`该错误不应该出现，无法为 ${uniqueKey} 找到 trackId`,
									)
								}
								return {
									trackId,
									...(payload as CreateBilibiliTrackPayload).bilibiliMetadata,
								}
							},
						)

						if (bilibiliMetadataValues.length > 0) {
							await Sentry.startSpan(
								{
									name: 'db:insert:many:bilibiliMetadata',
									op: 'db',
								},
								() =>
									this.db
										.insert(schema.bilibiliMetadata)
										.values(bilibiliMetadataValues)
										.onConflictDoNothing(),
							)
						}
						break
					}
					case 'local': {
						throw createNotImplementedError('处理 local source 的逻辑尚未实现')
					}
				}

				const orderedMap = new Map<string, number>()

				for (const uniqueKey of uniqueKeys) {
					// 前面做过一致性检查了，这里不可能不存在
					orderedMap.set(uniqueKey, finalUniqueKeyToIdMap.get(uniqueKey)!)
				}

				return orderedMap
			})(),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('批量查找或创建 tracks 失败', {
							cause: e,
						}),
		)
	}

	/**
	 * 根据 uniqueKey 批量查找 track 的 ID。
	 * @param uniqueKeys
	 * @returns 如果成功，即为找到的 track 的 uniqueKey -> id 映射
	 */
	public findTrackIdsByUniqueKeys(
		uniqueKeys: string[],
	): ResultAsync<Map<string, number>, DatabaseError> {
		if (uniqueKeys.length === 0) {
			return okAsync(new Map<string, number>())
		}
		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:query:many:tracks', op: 'db' }, () =>
				this.db.query.tracks.findMany({
					where: and(inArray(schema.tracks.uniqueKey, uniqueKeys)),
					columns: {
						id: true,
						uniqueKey: true,
					},
				}),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('批量查找 tracks 失败', { cause: e }),
		).andThen((existingTracks) => {
			const uniqueKeyToIdMap = new Map<string, number>()
			for (const track of existingTracks) {
				uniqueKeyToIdMap.set(track.uniqueKey, track.id)
			}
			return okAsync(uniqueKeyToIdMap)
		})
	}

	/**
	 * 获取播放次数排行榜（游标分页）。
	 *
	 * @param {object} [options] 配置项
	 * @param {number} [options.limit] 每页返回的数量。
	 * @param {boolean} [options.onlyCompleted=true] 是否只统计完整播放。
	 * @param {number} [options.initialLimit] 如果是第一页，使用的数量限制（如无则为 limit）
	 * @param {object} [options.cursor] 上一页的游标（来自上一页的 `nextCursor`）。
	 * @param {number} [options.cursor.lastPlayCount] 上一页最后一个项目的播放量。
	 * @param {number} [options.cursor.lastUpdatedAt] 上一页最后一个项目的更新时间戳。
	 * @param {number} [options.cursor.lastId] 上一页最后一个项目的 ID。
	 * @returns 播放次数排行榜及下一页游标的异步结果。
	 */
	public getPlayCountHistoryPaginated(options: {
		limit: number
		initialLimit?: number
		onlyCompleted?: boolean
		cursor?: { lastPlayCount: number; lastUpdatedAt: number; lastId: number }
	}): ResultAsync<
		{
			items: { track: Track; playCount: number }[]
			nextCursor?: {
				lastPlayCount: number
				lastUpdatedAt: number
				lastId: number
			}
		},
		DatabaseError | ServiceError
	> {
		const { limit, onlyCompleted = true, cursor, initialLimit } = options

		const effectiveLimit = cursor ? limit : (initialLimit ?? limit)

		const playCountSql = this.db
			.select({
				trackId: schema.playHistory.trackId,
				count: count().as('count'),
			})
			.from(schema.playHistory)
			.where(onlyCompleted ? eq(schema.playHistory.completed, true) : undefined)
			.groupBy(schema.playHistory.trackId)
			.as('play_counts')

		const whereConditions: (SQL | undefined)[] = []

		if (cursor) {
			const cursorUpdatedAt = new Date(cursor.lastUpdatedAt)
			whereConditions.push(
				or(
					lt(playCountSql.count, cursor.lastPlayCount),
					and(
						eq(playCountSql.count, cursor.lastPlayCount),
						or(
							lt(schema.tracks.updatedAt, cursorUpdatedAt),
							and(
								eq(schema.tracks.updatedAt, cursorUpdatedAt),
								lt(schema.tracks.id, cursor.lastId),
							),
						),
					),
				),
			)
		}

		const historyQuery = Sentry.startSpan(
			{ name: 'db:query:playHistory', op: 'db' },
			() =>
				this.db
					.select({
						track: schema.tracks,
						artist: schema.artists,
						bilibiliMetadata: schema.bilibiliMetadata,
						localMetadata: schema.localMetadata,
						playCount: playCountSql.count,
					})
					.from(schema.tracks)
					.innerJoin(playCountSql, eq(schema.tracks.id, playCountSql.trackId))
					.leftJoin(
						schema.artists,
						eq(schema.tracks.artistId, schema.artists.id),
					)
					.leftJoin(
						schema.bilibiliMetadata,
						eq(schema.tracks.id, schema.bilibiliMetadata.trackId),
					)
					.leftJoin(
						schema.localMetadata,
						eq(schema.tracks.id, schema.localMetadata.trackId),
					)
					.where(and(...whereConditions))
					.orderBy(
						desc(playCountSql.count),
						desc(schema.tracks.updatedAt),
						desc(schema.tracks.id),
					)
					.limit(effectiveLimit + 1),
		)

		return ResultAsync.fromPromise(
			historyQuery,
			(e) => new DatabaseError('获取播放次数排行失败', { cause: e }),
		).andThen((rows) => {
			const hasNextPage = rows.length > effectiveLimit
			const resultItems = hasNextPage ? rows.slice(0, effectiveLimit) : rows

			const items: { track: Track; playCount: number }[] = []
			for (const row of resultItems) {
				const track = this.formatTrack({
					...row.track,
					artist: row.artist,
					bilibiliMetadata: row.bilibiliMetadata,
					localMetadata: row.localMetadata,
				})
				if (!track) continue
				items.push({ track, playCount: row.playCount ?? 0 })
			}

			let nextCursor
			if (hasNextPage) {
				const lastRow = resultItems[resultItems.length - 1]
				if (lastRow) {
					nextCursor = {
						lastPlayCount: lastRow.playCount ?? 0,
						lastUpdatedAt: lastRow.track.updatedAt.getTime(),
						lastId: lastRow.track.id,
					}
				}
			}

			return okAsync({
				items: items,
				nextCursor,
			})
		})
	}

	/**
	 * 获取所有歌曲的总播放时长。
	 * - 当 `onlyCompleted` 为 `true` (默认) 时, 计算方法为 `duration * playCount` (仅统计完整播放)。
	 * - 当 `onlyCompleted` 为 `false` 时, 计算方法为每条播放记录中 `durationPlayed` 的总和。
	 * @param options.onlyCompleted 是否仅统计完整播放（completed=true），默认 true
	 * @returns ResultAsync 包含总播放时长（秒）或一个错误。
	 */
	public getTotalPlaybackDuration(options?: {
		onlyCompleted?: boolean
	}): ResultAsync<number, DatabaseError> {
		const onlyCompleted = options?.onlyCompleted ?? true

		if (onlyCompleted) {
			const playCountSql = this.db
				.select({
					trackId: schema.playHistory.trackId,
					count: count().as('count'),
				})
				.from(schema.playHistory)
				.where(eq(schema.playHistory.completed, true))
				.groupBy(schema.playHistory.trackId)
				.as('play_counts')

			return ResultAsync.fromPromise(
				Sentry.startSpan(
					{ name: 'db:query:totalPlaybackDuration:completed', op: 'db' },
					() =>
						this.db
							.select({
								totalDuration:
									sql<number>`sum(${schema.tracks.duration} * ${playCountSql.count})`.mapWith(
										Number,
									),
							})
							.from(schema.tracks)
							.innerJoin(
								playCountSql,
								eq(schema.tracks.id, playCountSql.trackId),
							),
				),
				(e) => new DatabaseError('获取总播放时长失败', { cause: e }),
			).andThen((rows) => {
				const totalDuration = rows[0]?.totalDuration
				return okAsync(totalDuration ?? 0)
			})
		} else {
			return ResultAsync.fromPromise(
				Sentry.startSpan(
					{ name: 'db:query:totalPlaybackDuration:all', op: 'db' },
					() =>
						this.db
							.select({
								totalDuration: sum(schema.playHistory.durationPlayed).mapWith(
									Number,
								),
							})
							.from(schema.playHistory),
				),
				(e) => new DatabaseError('获取总播放时长失败', { cause: e }),
			).andThen((rows) => {
				const totalDuration = rows[0]?.totalDuration
				return okAsync(totalDuration ?? 0)
			})
		}
	}

	public getTrackByUniqueKey(
		uniqueKey: string,
	): ResultAsync<Track, ServiceError | DatabaseError> {
		return ResultAsync.fromPromise(
			Sentry.startSpan({ name: 'db:query:track', op: 'db' }, () =>
				this.db.query.tracks.findFirst({
					where: eq(schema.tracks.uniqueKey, uniqueKey),
					with: {
						artist: true,
						bilibiliMetadata: true,
						localMetadata: true,
					},
				}),
			),
			(e) =>
				e instanceof ServiceError
					? e
					: new DatabaseError('查找 track 失败', { cause: e }),
		).andThen((dbTrack) => {
			const formattedTrack = this.formatTrack(dbTrack)
			if (!formattedTrack) {
				return errAsync(createTrackNotFound(uniqueKey))
			}
			return okAsync(formattedTrack)
		})
	}

	/**
	 * 获取最近 N 天内播放时长最多的歌曲。
	 *
	 * @param {object} options 配置项
	 * @param {number} options.days 最近的天数
	 * @param {number} options.limit 返回的最大数量
	 * @returns 播放时长排行及总播放时长的异步结果。
	 */
	public getMostPlayedTracksInLastDays(options: {
		days: number
		limit: number
	}): ResultAsync<
		Array<{ track: Track; totalDuration: number }>,
		DatabaseError
	> {
		const { days, limit } = options

		// Calculate cutoff timestamp in seconds
		const cutoffTimeS = Math.floor(
			(Date.now() - days * 24 * 60 * 60 * 1000) / 1000,
		)

		const normalizedStartTime = schema.playHistory.startTime

		// Subquery: aggregate total duration played per track
		const durationSumSql = this.db
			.select({
				trackId: schema.playHistory.trackId,
				totalDuration: sum(schema.playHistory.durationPlayed).as(
					'total_duration',
				),
			})
			.from(schema.playHistory)
			.where(sql`${normalizedStartTime} >= ${cutoffTimeS}`)
			.groupBy(schema.playHistory.trackId)
			.as('duration_sums')

		const historyQuery = Sentry.startSpan(
			{ name: 'db:query:mostPlayedTracksByDuration', op: 'db' },
			() =>
				this.db
					.select({
						track: schema.tracks,
						artist: schema.artists,
						bilibiliMetadata: schema.bilibiliMetadata,
						localMetadata: schema.localMetadata,
						totalDuration: durationSumSql.totalDuration,
					})
					.from(schema.tracks)
					.innerJoin(
						durationSumSql,
						eq(schema.tracks.id, durationSumSql.trackId),
					)
					.leftJoin(
						schema.artists,
						eq(schema.tracks.artistId, schema.artists.id),
					)
					.leftJoin(
						schema.bilibiliMetadata,
						eq(schema.tracks.id, schema.bilibiliMetadata.trackId),
					)
					.leftJoin(
						schema.localMetadata,
						eq(schema.tracks.id, schema.localMetadata.trackId),
					)
					.orderBy(desc(durationSumSql.totalDuration))
					.limit(limit),
		)

		return ResultAsync.fromPromise(
			historyQuery,
			(e) => new DatabaseError('获取最近播放时长排行失败', { cause: e }),
		).andThen((rows) => {
			const results: Array<{ track: Track; totalDuration: number }> = []
			for (const row of rows) {
				const track = this.formatTrack({
					...row.track,
					artist: row.artist,
					bilibiliMetadata: row.bilibiliMetadata,
					localMetadata: row.localMetadata,
				})
				if (!track) continue
				results.push({
					track,
					totalDuration: Number(row.totalDuration ?? 0),
				})
			}
			return okAsync(results)
		})
	}
}

export const trackService = new TrackService(db)
