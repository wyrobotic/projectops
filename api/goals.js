// api/goals.js — CRUD for goals
// Routes dispatched by method + query params:
//   GET    /api/goals                  — list all (optionally ?verticalId=)
//   POST   /api/goals                  — create (generates code, triggers ClickUp folder)
//   PUT    /api/goals?id={id}          — update one (code is immutable)
//   PUT    /api/goals?action=reorder   — batch sort_order update
//   DELETE /api/goals?id={id}          — delete one (projects cascade via DB)

import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { uid, mapGoal } from './_utils.js';

const VALID_TYPES = ['deliverable', 'timebox'];

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { id, action, verticalId: filterVerticalId } = req.query;

  try {
    // ── GET /api/goals ─────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let rows;
      if (filterVerticalId) {
        rows = await sql`
          SELECT id, vertical_id, name, code, type, date, end_date,
                 description, boundaries, cu_folder_id, sort_order
          FROM goals
          WHERE vertical_id = ${filterVerticalId}
          ORDER BY sort_order ASC
        `;
      } else {
        rows = await sql`
          SELECT id, vertical_id, name, code, type, date, end_date,
                 description, boundaries, cu_folder_id, sort_order
          FROM goals
          ORDER BY sort_order ASC
        `;
      }
      return res.status(200).json(rows.map(mapGoal));
    }

    // ── POST /api/goals ────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        name,
        type,
        verticalId,
        date,
        endDate,
        description = '',
        boundaries  = '',
      } = req.body || {};

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: 'type must be "deliverable" or "timebox"' });
      }

      const newId = uid();
      let goalCode = null;
      let cuFolderId = null;

      if (verticalId) {
        // Transactional code generation:
        // 1. Lock the vertical row to serialise concurrent inserts.
        // 2. Count existing goals for this vertical to derive the goal number.
        // 3. Insert the new goal within the same transaction.
        const txRows = await sql.transaction([
          sql`SELECT id, code, space_id FROM verticals WHERE id = ${verticalId} FOR UPDATE`,
          sql`SELECT COUNT(*) AS cnt FROM goals WHERE vertical_id = ${verticalId}`,
        ]);

        const vertRow = txRows[0][0];
        if (!vertRow) {
          return res.status(400).json({ error: 'verticalId does not exist' });
        }

        const goalNumber = 100 + parseInt(txRows[1][0].cnt, 10);
        goalCode = `${vertRow.code}-${goalNumber}`;

        // Attempt ClickUp folder creation (non-fatal)
        if (vertRow.space_id && process.env.CLICKUP_API_TOKEN) {
          try {
            const cuRes = await fetch(
              `https://api.clickup.com/api/v2/space/${vertRow.space_id}/folder`,
              {
                method: 'POST',
                headers: {
                  Authorization: process.env.CLICKUP_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: `${goalCode} ${name.trim()}` }),
              }
            );
            if (cuRes.ok) {
              const cuData = await cuRes.json();
              cuFolderId = cuData.id || null;
            } else {
              console.warn('[goals] ClickUp folder creation failed:', cuRes.status);
            }
          } catch (cuErr) {
            console.warn('[goals] ClickUp folder creation error:', cuErr.message);
          }
        }

        const sortRows = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM goals`;
        const sortOrder = sortRows[0].next_order;

        const inserted = await sql`
          INSERT INTO goals
            (id, vertical_id, name, code, type, date, end_date, description, boundaries, cu_folder_id, sort_order)
          VALUES
            (${newId}, ${verticalId}, ${name.trim()}, ${goalCode}, ${type},
             ${date || null}, ${endDate || null}, ${description}, ${boundaries},
             ${cuFolderId}, ${sortOrder})
          RETURNING id, vertical_id, name, code, type, date, end_date,
                    description, boundaries, cu_folder_id, sort_order
        `;

        return res.status(201).json(mapGoal(inserted[0]));

      } else {
        // No vertical — no code, no ClickUp folder
        const sortRows = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM goals`;
        const sortOrder = sortRows[0].next_order;

        const inserted = await sql`
          INSERT INTO goals
            (id, vertical_id, name, code, type, date, end_date, description, boundaries, cu_folder_id, sort_order)
          VALUES
            (${newId}, NULL, ${name.trim()}, NULL, ${type},
             ${date || null}, ${endDate || null}, ${description}, ${boundaries},
             NULL, ${sortOrder})
          RETURNING id, vertical_id, name, code, type, date, end_date,
                    description, boundaries, cu_folder_id, sort_order
        `;

        return res.status(201).json(mapGoal(inserted[0]));
      }
    }

    // ── PUT /api/goals?action=reorder ──────────────────────────────────────
    if (req.method === 'PUT' && action === 'reorder') {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array is required' });
      }

      await sql`
        UPDATE goals
        SET sort_order = v.ord
        FROM (
          SELECT unnest(${ids}::text[]) AS id,
                 generate_series(0, ${ids.length - 1}) AS ord
        ) AS v
        WHERE goals.id = v.id
      `;

      return res.status(200).json({ ok: true });
    }

    // ── PUT /api/goals?id={id} ─────────────────────────────────────────────
    if (req.method === 'PUT' && id) {
      const existing = await sql`
        SELECT id, vertical_id, name, code, type, date, end_date,
               description, boundaries, cu_folder_id, sort_order
        FROM goals WHERE id = ${id}
      `;
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      const cur = existing[0];

      const body = req.body || {};

      // code is read-only via PUT — ignore if present
      const newVerticalId  = body.verticalId  !== undefined ? (body.verticalId || null) : cur.vertical_id;
      const newName        = body.name        !== undefined ? body.name.trim()          : cur.name;
      const newType        = body.type        !== undefined ? body.type                 : cur.type;
      const newDate        = body.date        !== undefined ? (body.date || null)       : cur.date;
      const newEndDate     = body.endDate     !== undefined ? (body.endDate || null)    : cur.end_date;
      const newDescription = body.description !== undefined ? body.description          : cur.description;
      const newBoundaries  = body.boundaries  !== undefined ? body.boundaries           : cur.boundaries;

      if (newType && !VALID_TYPES.includes(newType)) {
        return res.status(400).json({ error: 'type must be "deliverable" or "timebox"' });
      }

      const rows = await sql`
        UPDATE goals
        SET
          vertical_id = ${newVerticalId},
          name        = ${newName},
          type        = ${newType},
          date        = ${newDate},
          end_date    = ${newEndDate},
          description = ${newDescription},
          boundaries  = ${newBoundaries},
          updated_at  = NOW()
        WHERE id = ${id}
        RETURNING id, vertical_id, name, code, type, date, end_date,
                  description, boundaries, cu_folder_id, sort_order
      `;

      return res.status(200).json(mapGoal(rows[0]));
    }

    // ── DELETE /api/goals?id={id} ──────────────────────────────────────────
    if (req.method === 'DELETE' && id) {
      const result = await sql`
        DELETE FROM goals WHERE id = ${id} RETURNING id
      `;
      if (result.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[goals] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
