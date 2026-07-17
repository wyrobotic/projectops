// api/projects.js — CRUD for projects
// Routes dispatched by method + query params:
//   GET    /api/projects                  — list all (optionally ?goalId=)
//   POST   /api/projects                  — create (generates code, triggers ClickUp list)
//   PUT    /api/projects?id={id}          — update one (codes immutable; handles archive side-effect)
//   PUT    /api/projects?action=reorder   — batch status + sort_order update (kanban drag)
//   DELETE /api/projects?id={id}          — delete one

import { neon } from '@neondatabase/serverless';
import { requireAuth } from './_auth.js';
import { uid, isoWeekNumber, mapProject } from './_utils.js';

const VALID_STATUSES = ['backlog', 'progress', 'blocked', 'done', 'archived'];
const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  const { id, action, goalId: filterGoalId } = req.query;

  try {
    // ── GET /api/projects ──────────────────────────────────────────────────
    if (req.method === 'GET') {
      let rows;
      if (filterGoalId) {
        rows = await sql`
          SELECT id, goal_id, code_base, code_prefix, full_code, descriptor,
                 name, description, type, status, priority, drive_url, cu_list_id, sort_order
          FROM projects
          WHERE goal_id = ${filterGoalId}
          ORDER BY sort_order ASC
        `;
      } else {
        rows = await sql`
          SELECT id, goal_id, code_base, code_prefix, full_code, descriptor,
                 name, description, type, status, priority, drive_url, cu_list_id, sort_order
          FROM projects
          ORDER BY sort_order ASC
        `;
      }
      return res.status(200).json(rows.map(mapProject));
    }

    // ── POST /api/projects ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        goalId,
        descriptor  = '',
        name,
        description = '',
        type        = '',
        status      = 'backlog',
        priority    = 'medium',
        driveUrl    = null,
        templateId,          // optional ClickUp list-template id (cuTemplateId); used only at list-creation time
      } = req.body || {};

      if (!goalId || typeof goalId !== 'string' || !goalId.trim()) {
        return res.status(400).json({ error: 'goalId is required' });
      }
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (priority && !VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
      }

      // Nullable Google Drive folder URL — coerce empty string to null.
      const newDriveUrl = driveUrl && driveUrl.trim() ? driveUrl.trim() : null;

      const newId = uid();
      const now   = new Date();
      const yy    = String(now.getFullYear()).slice(2);
      const ww    = String(isoWeekNumber(now)).padStart(2, '0');

      // Fetch goal + vertical for code generation.
      // NeonDB HTTP driver is stateless — FOR UPDATE is not supported.
      // Race conditions on code generation are acceptable for a small team app.
      const goalRows = await sql`
        SELECT g.id, g.cu_folder_id, v.code AS vert_code, v.space_id
        FROM goals g
        LEFT JOIN verticals v ON v.id = g.vertical_id
        WHERE g.id = ${goalId}
      `;

      const goalRow = goalRows[0];
      if (!goalRow) {
        return res.status(400).json({ error: 'goalId does not exist' });
      }

      // Derive prefix. If no vertical, use a fallback of "NONE" (edge case).
      const vertCode = goalRow.vert_code || 'NONE';
      const prefix   = `${vertCode}-${yy}${ww}`;

      // Count projects with this prefix (may span multiple goals — that's correct per spec)
      const countRows = await sql`SELECT COUNT(*) AS cnt FROM projects WHERE code_prefix = ${prefix}`;
      const letter    = String.fromCharCode(65 + parseInt(countRows[0].cnt, 10));
      const codeBase  = `${prefix}${letter}`;
      const fullCode  = descriptor.trim()
        ? `${codeBase} ${descriptor.trim()}`
        : codeBase;

      // Attempt ClickUp list creation (non-fatal)
      let cuListId = null;
      if (goalRow.cu_folder_id && process.env.CLICKUP_API_TOKEN) {
        // If a template was chosen, try create-from-template first. On any failure
        // fall through to the plain-list creation below (both are non-fatal).
        let templateCreated = false;
        const tpl = (templateId || '').trim();
        // Only attempt create-from-template when templateId matches the ClickUp
        // list-template id format (e.g. "t-901417866531"). A malformed id is NOT
        // fatal — we log and fall through to the plain-list creation below so the
        // project still gets a List. encodeURIComponent is belt-and-suspenders
        // alongside the regex to prevent path traversal / endpoint pivoting.
        if (tpl && !/^t-\d+$/.test(tpl)) {
          console.warn('[projects] ignoring malformed templateId');
        }
        if (/^t-\d+$/.test(tpl)) {
          try {
            const tplRes = await fetch(
              `https://api.clickup.com/api/v2/folder/${encodeURIComponent(goalRow.cu_folder_id)}/list_template/${encodeURIComponent(tpl)}`,
              {
                method: 'POST',
                headers: {
                  Authorization: process.env.CLICKUP_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: fullCode, options: { return_immediately: false } }),
              }
            );
            if (tplRes.ok) {
              const tplData = await tplRes.json();
              cuListId = tplData.id || tplData.list?.id || null;
              templateCreated = true;

              // The list_template endpoint does not reliably accept `content`, so
              // set the List overview via a follow-up Update List call (non-fatal).
              if (cuListId && description.trim()) {
                try {
                  const descRes = await fetch(
                    `https://api.clickup.com/api/v2/list/${encodeURIComponent(cuListId)}`,
                    {
                      method: 'PUT',
                      headers: {
                        Authorization: process.env.CLICKUP_API_TOKEN,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ content: description.trim() }),
                    }
                  );
                  if (!descRes.ok) {
                    console.warn('[projects] ClickUp template list content update failed:', descRes.status);
                  }
                } catch (descErr) {
                  console.warn('[projects] ClickUp template list content update error:', descErr.message);
                }
              }
            } else {
              console.warn('[projects] ClickUp template list creation failed:', tplRes.status);
            }
          } catch (tplErr) {
            console.warn('[projects] ClickUp template list creation failed:', tplErr.message);
          }
        }

        // Fallback: plain list creation (runs when no templateId or the template attempt failed).
        if (!templateCreated) {
          try {
            const cuRes = await fetch(
              `https://api.clickup.com/api/v2/folder/${encodeURIComponent(goalRow.cu_folder_id)}/list`,
              {
                method: 'POST',
                headers: {
                  Authorization: process.env.CLICKUP_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: fullCode, ...(description.trim() ? { content: description.trim() } : {}) }),
              }
            );
            if (cuRes.ok) {
              const cuData = await cuRes.json();
              cuListId = cuData.id || null;
            } else {
              console.warn('[projects] ClickUp list creation failed:', cuRes.status);
            }
          } catch (cuErr) {
            console.warn('[projects] ClickUp list creation error:', cuErr.message);
          }
        }
      }

      const sortRows = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM projects`;
      const sortOrder = sortRows[0].next_order;

      const inserted = await sql`
        INSERT INTO projects
          (id, goal_id, code_base, code_prefix, full_code, descriptor,
           name, description, type, status, priority, drive_url, cu_list_id, sort_order)
        VALUES
          (${newId}, ${goalId}, ${codeBase}, ${prefix}, ${fullCode}, ${descriptor.trim()},
           ${name.trim()}, ${description}, ${type}, ${status}, ${priority}, ${newDriveUrl}, ${cuListId}, ${sortOrder})
        RETURNING id, goal_id, code_base, code_prefix, full_code, descriptor,
                  name, description, type, status, priority, drive_url, cu_list_id, sort_order
      `;

      return res.status(201).json(mapProject(inserted[0]));
    }

    // ── PUT /api/projects?action=reorder ───────────────────────────────────
    // Batch update of status + sort_order for kanban drag-and-drop.
    // Does NOT trigger the ClickUp archive side-effect — that only fires on
    // the single-item PUT path (see spec note).
    if (req.method === 'PUT' && action === 'reorder') {
      const { updates } = req.body || {};
      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'updates array is required' });
      }

      const ids        = updates.map(u => u.id);
      const statuses   = updates.map(u => u.status);
      const sortOrders = updates.map(u => u.sortOrder);

      await sql`
        UPDATE projects
        SET
          status     = v.status,
          sort_order = v.ord,
          updated_at = NOW()
        FROM (
          SELECT
            unnest(${ids}::text[])      AS id,
            unnest(${statuses}::text[]) AS status,
            unnest(${sortOrders}::integer[]) AS ord
        ) AS v
        WHERE projects.id = v.id
      `;

      return res.status(200).json({ ok: true });
    }

    // ── PUT /api/projects?id={id} ──────────────────────────────────────────
    if (req.method === 'PUT' && id) {
      const existing = await sql`
        SELECT id, goal_id, code_base, code_prefix, full_code, descriptor,
               name, description, type, status, priority, drive_url, cu_list_id, sort_order
        FROM projects WHERE id = ${id}
      `;
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      const cur = existing[0];

      const body = req.body || {};

      // code_base, code_prefix, full_code are immutable — ignored if present.
      const newDescriptor  = body.descriptor  !== undefined ? body.descriptor.trim()      : cur.descriptor;
      const newName        = body.name        !== undefined ? body.name.trim()             : cur.name;
      const newDescription = body.description !== undefined ? body.description             : cur.description;
      const newType        = body.type        !== undefined ? body.type                    : cur.type;
      const newStatus      = body.status      !== undefined ? body.status                  : cur.status;
      const newPriority    = body.priority    !== undefined ? body.priority                 : cur.priority;
      const newDriveUrl    = body.driveUrl    !== undefined
        ? (body.driveUrl && body.driveUrl.trim() ? body.driveUrl.trim() : null)
        : cur.drive_url;

      if (newStatus && !VALID_STATUSES.includes(newStatus)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (newPriority && !VALID_PRIORITIES.includes(newPriority)) {
        return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
      }

      // When descriptor changes, recompute full_code from the stored code_base.
      const newFullCode = newDescriptor
        ? `${cur.code_base} ${newDescriptor}`
        : cur.code_base;

      // ClickUp archive side-effect: if transitioning TO archived and a list ID exists.
      if (
        newStatus === 'archived' &&
        cur.status !== 'archived' &&
        cur.cu_list_id &&
        process.env.CLICKUP_API_TOKEN
      ) {
        try {
          const cuRes = await fetch(
            `https://api.clickup.com/api/v2/list/${encodeURIComponent(cur.cu_list_id)}`,
            {
              method: 'PUT',
              headers: {
                Authorization: process.env.CLICKUP_API_TOKEN,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ archived: true }),
            }
          );
          if (!cuRes.ok) {
            console.warn('[projects] ClickUp archive failed:', cuRes.status);
          }
        } catch (cuErr) {
          console.warn('[projects] ClickUp archive error:', cuErr.message);
        }
      }

      const rows = await sql`
        UPDATE projects
        SET
          descriptor  = ${newDescriptor},
          name        = ${newName},
          description = ${newDescription},
          type        = ${newType},
          status      = ${newStatus},
          priority    = ${newPriority},
          drive_url   = ${newDriveUrl},
          full_code   = ${newFullCode},
          updated_at  = NOW()
        WHERE id = ${id}
        RETURNING id, goal_id, code_base, code_prefix, full_code, descriptor,
                  name, description, type, status, priority, drive_url, cu_list_id, sort_order
      `;

      // One-way sync: propagate descriptor/description changes to the ClickUp List (non-fatal).
      // List name tracks full_code (code_base + descriptor), NOT the project name — consistent
      // with create-time naming. Only send fields that actually changed; skip the call entirely
      // if neither changed to avoid an empty PUT.
      if (cur.cu_list_id && process.env.CLICKUP_API_TOKEN) {
        const listPayload = {};
        if (newFullCode !== cur.full_code) listPayload.name = newFullCode;
        if (newDescription !== cur.description) listPayload.content = newDescription.trim();

        if (Object.keys(listPayload).length > 0) {
          try {
            const cuRes = await fetch(
              `https://api.clickup.com/api/v2/list/${encodeURIComponent(cur.cu_list_id)}`,
              {
                method: 'PUT',
                headers: {
                  Authorization: process.env.CLICKUP_API_TOKEN,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(listPayload),
              }
            );
            if (!cuRes.ok) {
              console.warn('[projects] ClickUp list update failed:', cuRes.status);
            }
          } catch (cuErr) {
            console.warn('[projects] ClickUp list update error:', cuErr.message);
          }
        }
      }

      return res.status(200).json(mapProject(rows[0]));
    }

    // ── DELETE /api/projects?id={id} ───────────────────────────────────────
    if (req.method === 'DELETE' && id) {
      const result = await sql`
        DELETE FROM projects WHERE id = ${id} RETURNING id
      `;
      if (result.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[projects] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
