'use server'
import {
  createServerApiClient,
  type EntityListOptions,
} from '@eerp/core-front/server'
import type { RelationRecord } from '@eerp/core-front'

// Entity-generic Server Actions backing the engine's RelationOps: how relation
// widgets (client) query and link OTHER entities — autocomplete search, o2m
// scoping, junction reads/writes. Always through the BFF ApiClient, so Go
// authorizes each call from the session (permission derives from the entity
// route). Mounted once app-wide by the root layout's RelationOpsProvider.

export async function listRecords(
  entity: string,
  options?: EntityListOptions,
): Promise<RelationRecord[]> {
  return createServerApiClient().list<RelationRecord>(entity, options)
}

export async function getRecord(entity: string, id: string): Promise<RelationRecord> {
  return createServerApiClient().get<RelationRecord>(entity, id)
}

export async function createRelationRecord(
  entity: string,
  body: Record<string, unknown>,
): Promise<RelationRecord> {
  return createServerApiClient().create<RelationRecord>(entity, body)
}

export async function removeRelationRecord(entity: string, id: string): Promise<void> {
  await createServerApiClient().remove(entity, id)
}
