// api/_utils.js — shared utilities for ProjectOPS serverless functions
// Prefixed with _ so Vercel does not expose this as a function endpoint.

/**
 * Generates a unique ID in the same format as the frontend uid().
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Returns the ISO week number for a given Date.
 * Must remain identical to the frontend isoWeek() implementation to prevent code drift.
 */
export function isoWeekNumber(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const w1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
}

// ── Data shape mappers (DB snake_case → API camelCase) ───────────────────────

export function mapVertical(row) {
  return {
    id:        row.id,
    name:      row.name,
    code:      row.code,
    color:     row.color,
    spaceId:   row.space_id,
    sortOrder: row.sort_order,
  };
}

export function mapGoal(row) {
  return {
    id:          row.id,
    verticalId:  row.vertical_id,
    name:        row.name,
    code:        row.code,
    type:        row.type,
    date:        row.date,
    endDate:     row.end_date,
    description: row.description,
    boundaries:  row.boundaries,
    cuFolderId:  row.cu_folder_id,
    sortOrder:   row.sort_order,
  };
}

export function mapProject(row) {
  return {
    id:          row.id,
    goalId:      row.goal_id,
    codeBase:    row.code_base,
    codePrefix:  row.code_prefix,
    fullCode:    row.full_code,
    descriptor:  row.descriptor,
    name:        row.name,
    description: row.description,
    type:        row.type,
    status:      row.status,
    cuListId:    row.cu_list_id,
    sortOrder:   row.sort_order,
  };
}

export function mapProjectType(row) {
  return {
    id:        row.id,
    name:      row.name,
    sortOrder: row.sort_order,
  };
}
