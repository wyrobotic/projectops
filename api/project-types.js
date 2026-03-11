// api/project-types.js — CRUD for project types
// Routes dispatched by method + query params:
//   GET    /api/project-types          — list all
//   POST   /api/project-types          — create (appends to end)
//   DELETE /api/project-types?id={id}  — delete one (no cascade to projects)

import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { uid, mapProjectType } from './_utils.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { id } = req.query;

  try {
    // ── GET /api/project-types ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, sort_order
        FROM project_types
        ORDER BY sort_order ASC
      `;
      return res.status(200).json(rows.map(mapProjectType));
    }

    // ── POST /api/project-types ────────────────────────────────────────────
    if (req.method === 'POST') {
      const { name } = req.body || {};

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }

      const newId = uid();
      const sortRows = await sql`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_types
      `;
      const sortOrder = sortRows[0].next_order;

      let rows;
      try {
        rows = await sql`
          INSERT INTO project_types (id, name, sort_order)
          VALUES (${newId}, ${name.trim()}, ${sortOrder})
          RETURNING id, name, sort_order
        `;
      } catch (err) {
        if (err.code === '23505') {
          return res.status(400).json({ error: 'Type already exists' });
        }
        throw err;
      }

      return res.status(201).json(mapProjectType(rows[0]));
    }

    // ── DELETE /api/project-types?id={id} ─────────────────────────────────
    if (req.method === 'DELETE' && id) {
      const result = await sql`
        DELETE FROM project_types WHERE id = ${id} RETURNING id
      `;
      if (result.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[project-types] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
