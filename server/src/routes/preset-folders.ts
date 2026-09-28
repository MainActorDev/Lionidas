import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { registerFolderRoutes } from './folder-routes-factory.ts';

/** Preset folders (plan 20260928T105500Z) — manual operator organization
 *  (e.g. by app), cPanel semantics via the shared factory. Folders are PURE
 *  organization: matcher/serving behavior is unchanged. */

export function registerPresetFolderRoutes(app: FastifyInstance, db: Database.Database): void {
  registerFolderRoutes(app, db, {
    routeBase: 'preset-folders',
    folderTable: 'preset_folders',
    itemTable: 'presets',
    itemNoun: 'preset',
    idPrefix: 'pfld_',
    itemColumns: 'id, method, path_pattern, status',
    itemOrder: 'path_pattern, created_at',
  });
}
