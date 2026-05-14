// api/verticals.js — CRUD for verticals
// Routes dispatched by method + query params:
//   GET    /api/verticals            — list all
//   POST   /api/verticals            — create
//   PUT    /api/verticals?id={id}    — update one
//   PUT    /api/verticals?action=reorder — batch sort_order update
//   DELETE /api/verticals?id={id}    — delete one

import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { uid, mapVertical } from './_utils.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { id, action } = req.query;

  try {
    // ── GET /api/verticals ─────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, code, color, space_id, sort_order
        FROM verticals
        ORDER BY sort_order ASC
      `;
      return res.status(200).json(rows.map(mapVertical));
    }

    // ── POST /api/verticals ────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, code, color, spaceId } = req.body || {};

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code is required' });
      }
      if (!color || typeof color !== 'string' || !color.trim()) {
        return res.status(400).json({ error: 'color is required' });
      }

      const normalizedCode = code.trim().toUpperCase();
      const newId = uid();
      const sortRows = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM verticals`;
      const sortOrder = sortRows[0].next_order;

      let rows;
      try {
        rows = await sql`
          INSERT INTO verticals (id, name, code, color, space_id, sort_order)
          VALUES (${newId}, ${name.trim()}, ${normalizedCode}, ${color.trim()}, ${spaceId || null}, ${sortOrder})
          RETURNING id, name, code, color, space_id, sort_order
        `;
      } catch (err) {
        if (err.code === '23505') {
          return res.status(400).json({ error: 'code already in use' });
        }
        throw err;
      }

      return res.status(201).json(mapVertical(rows[0]));
    }

    // ── PUT /api/verticals?action=reorder ──────────────────────────────────
    if (req.method === 'PUT' && action === 'reorder') {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array is required' });
      }

      await sql`
        UPDATE verticals
        SET sort_order = v.ord
        FROM (
          SELECT unnest(${ids}::text[]) AS id,
                 generate_series(0, ${ids.length - 1}) AS ord
        ) AS v
        WHERE verticals.id = v.id
      `;

      return res.status(200).json({ ok: true });
    }

    // ── PUT /api/verticals?id={id} ─────────────────────────────────────────
    if (req.method === 'PUT' && id) {
      const existing = await sql`
        SELECT id FROM verticals WHERE id = ${id}
      `;
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { name, code, color, spaceId } = req.body || {};

      // Fetch current row then merge — cleanest approach for partial updates
      // with optional nullable fields (space_id can be explicitly set to null).
      const currentFull = await sql`
        SELECT id, name, code, color, space_id, sort_order
        FROM verticals WHERE id = ${id}
      `;
      const cur = currentFull[0];

      const newName      = name      !== undefined ? name.trim()               : cur.name;
      const newCode      = code      !== undefined ? code.trim().toUpperCase() : cur.code;
      const newColor     = color     !== undefined ? color.trim()              : cur.color;
      const newSpaceId   = spaceId   !== undefined ? (spaceId || null)         : cur.space_id;

      let rows;
      try {
        rows = await sql`
          UPDATE verticals
          SET
            name       = ${newName},
            code       = ${newCode},
            color      = ${newColor},
            space_id   = ${newSpaceId},
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING id, name, code, color, space_id, sort_order
        `;
      } catch (err) {
        if (err.code === '23505') {
          return res.status(400).json({ error: 'code already in use' });
        }
        throw err;
      }

      return res.status(200).json(mapVertical(rows[0]));
    }

    // ── DELETE /api/verticals?id={id} ──────────────────────────────────────
    if (req.method === 'DELETE' && id) {
      // Fetch vertical first to get ClickUp space_id and verify existence
      const vertRows = await sql`
        SELECT id, space_id FROM verticals WHERE id = ${id}
      `;
      if (vertRows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Delete associated ClickUp Space (non-fatal)
      const spaceId = vertRows[0].space_id;
      if (spaceId && process.env.CLICKUP_API_TOKEN) {
        try {
          const cuRes = await fetch(
            `https://api.clickup.com/api/v2/space/${spaceId}`,
            {
              method: 'DELETE',
              headers: {
                Authorization: process.env.CLICKUP_API_TOKEN,
              },
            }
          );
          if (!cuRes.ok) {
            console.warn('[verticals] ClickUp space deletion failed:', cuRes.status);
          }
        } catch (cuErr) {
          console.warn('[verticals] ClickUp space deletion error:', cuErr.message);
        }
      }

      // Delete associated goals first (projects cascade-delete via FK)
      await sql`DELETE FROM goals WHERE vertical_id = ${id}`;

      // Delete the vertical
      await sql`DELETE FROM verticals WHERE id = ${id}`;

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[verticals] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

