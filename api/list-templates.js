// api/list-templates.js — CRUD for ClickUp list templates
// Routes dispatched by method + query params:
//   GET    /api/list-templates          — list all (ordered by sort_order)
//   POST   /api/list-templates          — create (appends to end; can set default)
//   PUT    /api/list-templates?id={id}  — update one (can set default)
//   DELETE /api/list-templates?id={id}  — delete one

import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { uid, mapListTemplate } from './_utils.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { id } = req.query;

  try {
    // ── GET /api/list-templates ────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, cu_template_id, description, is_default, sort_order
        FROM list_templates
        ORDER BY sort_order ASC
      `;
      return res.status(200).json(rows.map(mapListTemplate));
    }

    // ── POST /api/list-templates ───────────────────────────────────────────
    if (req.method === 'POST') {
      const { name, cuTemplateId, description = '', isDefault = false } = req.body || {};

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!cuTemplateId || typeof cuTemplateId !== 'string' || !cuTemplateId.trim()) {
        return res.status(400).json({ error: 'cuTemplateId is required' });
      }
      if (description !== undefined && typeof description !== 'string') {
        return res.status(400).json({ error: 'description must be a string' });
      }
      // Length bounds — keep oversized payloads out of the DB.
      if (name.trim().length > 120) {
        return res.status(400).json({ error: 'name must be 120 characters or fewer' });
      }
      if (cuTemplateId.trim().length > 64) {
        return res.status(400).json({ error: 'cuTemplateId must be 64 characters or fewer' });
      }
      if ((description || '').length > 2000) {
        return res.status(400).json({ error: 'description must be 2000 characters or fewer' });
      }
      // Enforce ClickUp list-template id format at the source (closes path
      // injection in projects.js by keeping malformed ids out of the DB).
      if (!/^t-\d+$/.test(cuTemplateId.trim())) {
        return res.status(400).json({ error: 'cuTemplateId must look like "t-123..."' });
      }

      const newId = uid();
      const aggRows = await sql`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order,
               COUNT(*) FILTER (WHERE is_default) AS default_count
        FROM list_templates
      `;
      const sortOrder = aggRows[0].next_order;

      // Auto-promote the first-ever template (or any template added while no
      // default exists) to default, so there is always a default once at least
      // one template exists. An explicit isDefault:true also wins.
      const makeDefault = isDefault === true || parseInt(aggRows[0].default_count, 10) === 0;

      // If this template becomes the default, unset any existing default first.
      // NeonDB HTTP driver is stateless — no transactions. Sequential is
      // acceptable for a small team app (see the FOR UPDATE note in projects.js).
      if (makeDefault) {
        await sql`UPDATE list_templates SET is_default = false`;
      }

      const rows = await sql`
        INSERT INTO list_templates
          (id, name, cu_template_id, description, is_default, sort_order)
        VALUES
          (${newId}, ${name.trim()}, ${cuTemplateId.trim()}, ${description}, ${makeDefault}, ${sortOrder})
        RETURNING id, name, cu_template_id, description, is_default, sort_order
      `;

      return res.status(201).json(mapListTemplate(rows[0]));
    }

    // ── PUT /api/list-templates?id={id} ────────────────────────────────────
    if (req.method === 'PUT' && id) {
      const existing = await sql`
        SELECT id, name, cu_template_id, description, is_default, sort_order
        FROM list_templates WHERE id = ${id}
      `;
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      const cur = existing[0];

      const body = req.body || {};

      // Type guards — a non-string field would otherwise throw on .trim() (500).
      if (body.name !== undefined && typeof body.name !== 'string') {
        return res.status(400).json({ error: 'name must be a string' });
      }
      if (body.cuTemplateId !== undefined && typeof body.cuTemplateId !== 'string') {
        return res.status(400).json({ error: 'cuTemplateId must be a string' });
      }
      if (body.description !== undefined && typeof body.description !== 'string') {
        return res.status(400).json({ error: 'description must be a string' });
      }

      const newName         = body.name         !== undefined ? body.name.trim()         : cur.name;
      const newCuTemplateId = body.cuTemplateId !== undefined ? body.cuTemplateId.trim() : cur.cu_template_id;
      const newDescription  = body.description  !== undefined ? body.description          : cur.description;
      const newIsDefault    = body.isDefault    !== undefined ? body.isDefault === true   : cur.is_default;

      // Re-validate only the fields actually being set.
      if (body.name !== undefined && !newName) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (body.name !== undefined && newName.length > 120) {
        return res.status(400).json({ error: 'name must be 120 characters or fewer' });
      }
      if (body.cuTemplateId !== undefined) {
        if (newCuTemplateId.length > 64) {
          return res.status(400).json({ error: 'cuTemplateId must be 64 characters or fewer' });
        }
        if (!/^t-\d+$/.test(newCuTemplateId)) {
          return res.status(400).json({ error: 'cuTemplateId must look like "t-123..."' });
        }
      }
      if (body.description !== undefined && newDescription.length > 2000) {
        return res.status(400).json({ error: 'description must be 2000 characters or fewer' });
      }

      // If this template is being made the default, unset any existing default first.
      if (newIsDefault === true) {
        await sql`UPDATE list_templates SET is_default = false`;
      }

      const rows = await sql`
        UPDATE list_templates
        SET
          name           = ${newName},
          cu_template_id = ${newCuTemplateId},
          description    = ${newDescription},
          is_default     = ${newIsDefault}
        WHERE id = ${id}
        RETURNING id, name, cu_template_id, description, is_default, sort_order
      `;

      return res.status(200).json(mapListTemplate(rows[0]));
    }

    // ── DELETE /api/list-templates?id={id} ─────────────────────────────────
    if (req.method === 'DELETE' && id) {
      const rows = await sql`
        SELECT id, is_default FROM list_templates WHERE id = ${id}
      `;
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      const wasDefault = rows[0].is_default === true;

      await sql`DELETE FROM list_templates WHERE id = ${id}`;

      // If we removed the default, promote the lowest sort_order survivor so the
      // table is never left without a default. Sequential statements (no
      // transaction) — consistent with the rest of this file.
      let newDefaultId = null;
      if (wasDefault) {
        const promoted = await sql`
          UPDATE list_templates
          SET is_default = true
          WHERE id = (SELECT id FROM list_templates ORDER BY sort_order ASC LIMIT 1)
          RETURNING id
        `;
        newDefaultId = promoted.length > 0 ? promoted[0].id : null;
      }

      return res.status(200).json({ ok: true, newDefaultId });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[list-templates] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
