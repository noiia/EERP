'use server'
import { createServerApiClient } from '@eerp/core-front/server'

// Generic entity Server Actions. Writes never go client -> Go; the client form store
// invokes these (server-side), which call Go through the BFF ApiClient and revalidate
// the entity tag. The catch-all binds `entity` to produce per-entity EntityActions.

export async function createRecord(entity: string, body: unknown): Promise<unknown> {
  return createServerApiClient().create(entity, body)
}

export async function updateRecord(entity: string, id: string, body: unknown): Promise<unknown> {
  return createServerApiClient().update(entity, id, body)
}

export async function removeRecord(entity: string, id: string): Promise<void> {
  await createServerApiClient().remove(entity, id)
}
