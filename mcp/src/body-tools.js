/* log_body: files a body check-in (weigh-in and/or measurements) the user describes — an
   assessment sheet from a trainer, a tape measure in the morning — through the openGym server,
   the same way log_workout files a session (write-tools.js): GET /api/data, change one day,
   PUT over the revision read, retry on 409.

   Only the day given is touched: its measurements entry (values given overwrite, the rest of
   the day stays), one weigh-in reading, and — only when asked — new custom fields or a built-in
   optional field switched on so the value shows in the app. The server stamps what an API
   client changed (api/sync-stamps.js), so nothing else may differ in the PUT.

   Local addition to this checkout (not upstream). */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'
import {
  MEASUREMENT_FIELDS, MEASUREMENT_KEYS, DEFAULT_MEASUREMENT_KEYS, CUSTOM_MEASUREMENT_UNITS,
  emptyMeasurement, normalizeMeasurementEntry, fromMeasurementDisplay,
} from '../../frontend/src/lib/measurements.js'
import { addWeighIn } from '../../frontend/src/lib/weigh-ins.js'

const MAX_ATTEMPTS = 3
const WRITE_LIMIT = 20
const WINDOW_MS = 60 * 60000
let saves = []
export const _resetBodyWindow = () => { saves = [] }

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

const norm = s => String(s || '').trim().toLowerCase()
const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const builtinShape = Object.fromEntries(MEASUREMENT_FIELDS.map(f => [f.key,
  z.number().positive().optional().describe(f.kind === 'percent' ? `${f.label}, in %` : `${f.label}, in cm`)]))

/**
 * Applies the check-in to S (mutated). Returns { problems } or { view } — view is what the day
 * now holds, for the preview and the confirmation.
 */
export function applyBody(S, p, now) {
  const problems = []
  const view = { date: p.date }

  if (p.weight != null) {
    const r = addWeighIn(S, { d: p.date, at: p.time || null, w: p.weight, t: now })
    if (!r) problems.push({ field: 'weight', issue: 'not a valid weight' })
    else view.weight = { value: r.w, unit: S.unit === 'lb' ? 'lb' : 'kg', at: r.at }
  }

  const values = p.measurements || {}
  const custom = p.custom || []
  if (Object.keys(values).length || custom.length) {
    S.customMeasurements = Array.isArray(S.customMeasurements) ? S.customMeasurements : []
    const list = Array.isArray(S.measurements) ? S.measurements : []
    const i = list.findIndex(e => e && e.d === p.date)
    const entry = i >= 0 ? normalizeMeasurementEntry(list[i], S.customMeasurements) : emptyMeasurement(p.date, S.customMeasurements)
    const enabled = new Set(Array.isArray(S.measurementEnabled) ? S.measurementEnabled : DEFAULT_MEASUREMENT_KEYS)
    const switchedOn = []
    view.measurements = {}

    for (const [key, v] of Object.entries(values)) {
      if (!MEASUREMENT_KEYS.includes(key)) { problems.push({ field: key, issue: 'unknown built-in field' }); continue }
      const stored = fromMeasurementDisplay(v, 'kg', { key })
      if (stored == null) { problems.push({ field: key, issue: 'out of range' }); continue }
      entry[key] = stored
      view.measurements[key] = stored
      if (!enabled.has(key)) switchedOn.push(key)
    }
    if (switchedOn.length && !p.enable_fields) {
      problems.push({ fields: switchedOn, issue: 'these fields are switched off in the app, so the values would be saved but not shown: ask the user, then call again with enable_fields: true' })
    }

    view.custom = []
    for (const c of custom) {
      let field = S.customMeasurements.find(f => norm(f.name) === norm(c.name))
      if (field && c.unit && field.unit && field.unit !== c.unit) {
        problems.push({ field: c.name, issue: `the existing field is in ${field.unit}, not ${c.unit}` }); continue
      }
      if (!field) {
        if (!p.create_custom) {
          problems.push({ field: c.name, issue: 'no custom field with this name', existing: S.customMeasurements.map(f => `${f.name} (${f.unit || 'cm'})`) })
          continue
        }
        field = { id: newId(), name: String(c.name).trim().slice(0, 60), enabled: true, unit: c.unit || 'none' }
        S.customMeasurements.push(field)
        view.custom_fields_created = [...(view.custom_fields_created || []), `${field.name} (${field.unit})`]
      }
      const stored = fromMeasurementDisplay(c.value, 'kg', field)
      if (stored == null) { problems.push({ field: c.name, issue: 'out of range' }); continue }
      const row = { id: field.id, name: field.name, value: stored, ...(field.unit ? { unit: field.unit } : {}) }
      const j = entry.other.findIndex(o => o.id === field.id)
      if (j >= 0) entry.other[j] = row; else entry.other.push(row)
      view.custom.push({ name: field.name, value: c.value, unit: field.unit || 'cm' })
    }

    if (problems.length) return { problems }
    entry.t = now
    if (i >= 0) list[i] = entry; else list.push(entry)
    list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    S.measurements = list
    if (switchedOn.length) { S.measurementEnabled = [...enabled, ...switchedOn]; view.fields_switched_on = switchedOn }
    view.replaced_existing_day = i >= 0
  }
  return problems.length ? { problems } : { view }
}

export const logBody = {
  name: 'log_body',
  description: [
    'Log a body check-in into openGym (syncs to all devices): a weigh-in and/or body measurements for one day, e.g. a trainer\'s assessment.',
    'Built-in measurements go in `measurements` (cm; bodyFat in %): neck, shoulders, chest, waist, hips, abdomen, upperArm/forearm/wrist/thigh/calf/ankle Left|Right, bodyFat.',
    'Anything else (fat mass kg, lean mass kg, skinfolds, sum of skinfolds) goes in `custom` by name; a field that does not exist yet needs create_custom: true, only after the user agrees.',
    'Skinfolds are in mm, which openGym has no unit for: use unit "none" and put "(mm)" in the name.',
    'Ask the user for the date of the assessment instead of assuming today.',
    'Call with dry_run: true first, show the user the preview, save once they agree. Values given replace that day\'s; values not given stay.',
  ].join(' '),
  schema: {
    date: isoDate().describe('YYYY-MM-DD of the check-in. Not in the future.'),
    weight: z.number().positive().max(700).optional().describe('Body weight in the profile\'s unit (see the preview).'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 h').optional().describe('Time of the weigh-in, if known. A weigh-in at the same time that day is corrected, not duplicated.'),
    measurements: z.object(builtinShape).strict().optional(),
    custom: z.array(z.object({
      name: z.string().min(1).max(60),
      value: z.number().min(0),
      unit: z.enum(CUSTOM_MEASUREMENT_UNITS).optional().describe('For a new field; an existing field keeps its unit.'),
    })).max(30).optional(),
    create_custom: z.boolean().optional().describe('Create the custom fields that do not exist yet. Only after the user confirms.'),
    enable_fields: z.boolean().optional().describe('Switch on built-in fields that are off in the app (abdomen, bodyFat, wrists, ankles) so the values show. Only after the user confirms.'),
    dry_run: z.boolean().optional().describe('Build and return the preview without saving anything.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    if (params.weight == null && !params.measurements && !params.custom?.length) {
      throw fail('EINPUT', 'nothing to log: give a weight, measurements or custom values')
    }
    const cfg = apiConfig(env)
    const opts = fetchImpl ? { fetchImpl } : {}
    const now = Date.now()
    saves = saves.filter(t => now - t < WINDOW_MS)
    if (!params.dry_run && saves.length >= WRITE_LIMIT) throw fail('ERATE', `log_body already saved ${WRITE_LIMIT} times in the last hour; nothing was saved`)

    const me = await apiFetch(cfg, '/api/me', opts)
    const uid = me.body?.user?.id
    if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'the openGym server did not say which profile OPENGYM_TOKEN belongs to (GET /api/me); nothing was saved')
    const local = localUid()
    if (local && local !== uid) {
      console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
      throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads')
    }

    let got = await apiFetch(cfg, '/api/data', opts)
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const doc = got.body?.state
      if (!doc || typeof doc !== 'object') throw fail('ENOSTATE', 'this profile has no synced data on the server yet')
      const S = structuredClone(doc)
      const r = applyBody(S, params, now)
      if (r.problems) return { logged: false, problems: r.problems, next: 'Nothing was saved. Settle these with the user and call again.' }
      if (params.dry_run) return { logged: false, dry_run: true, would_log: r.view }
      const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
      if (put.status !== 409) {
        invalidate()
        saves.push(now)
        console.error(`[opengym-mcp] log_body saved ${params.date}, rev ${put.body?.rev ?? '?'}`)
        return { logged: true, ...r.view, revision: put.body?.rev ?? null }
      }
      if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
        throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
      }
      got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
    }
    throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was saved`)
  },
}
