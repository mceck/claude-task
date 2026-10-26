import { z } from 'zod';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route parameter that addresses a record by id or by its human key (`API`, `API-42`). */
export const idOrKey = z.string().min(1).max(64);
