'use server'
import { createServerApiClient, settleAction, type ActionError } from '@eerp/core-front/server'

// Generic entity Server Actions. Writes never go client -> Go; the client form store
// invokes these (server-side), which call Go through the BFF ApiClient and revalidate
// the entity tag. The catch-all binds `entity` to produce per-entity EntityActions.
//
// Failures come back as an ActionError VALUE, never thrown: a thrown error's
// message is stripped in production builds. EntityView unwraps them back into a
// thrown ApiError on the client (unwrapEntityActions).

export async function createRecord(entity: string, body: unknown): Promise<unknown> {
  return settleAction(() => createServerApiClient().create(entity, body))
}

export async function updateRecord(entity: string, id: string, body: unknown): Promise<unknown> {
  return settleAction(() => createServerApiClient().update(entity, id, body))
}

export async function removeRecord(entity: string, id: string): Promise<void | ActionError> {
  return settleAction(() => createServerApiClient().remove(entity, id))
}

export async function restoreRecord(entity: string, id: string): Promise<unknown> {
  return settleAction(() => createServerApiClient().restore(entity, id))
}
