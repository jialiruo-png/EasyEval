import type { DatasetRowStore } from '../domain/dataset-rows.ts';
import type { ResourceCatalog, VersionRef } from '../domain/resources.ts';

export interface CatalogRequest {
  owner: string;
  kind: string;
  action: 'detail' | 'references' | 'status' | 'archive' | 'create' | 'copy' | 'import' | 'rows';
  source?: VersionRef;
  target?: { id?: unknown; version?: unknown };
  binding?: unknown;
}

/** Storage commits successful writes before the HTTP handler sends its response. */
export type CatalogAccess = <T extends { ok: boolean }>(
  request: CatalogRequest,
  work: (catalog: ResourceCatalog, rowStore: DatasetRowStore) => T,
) => T | Promise<T>;

export type ResourceAccess = <T extends { ok: boolean }>(
  request: CatalogRequest, work: (catalog: ResourceCatalog) => T,
) => T | Promise<T>;
