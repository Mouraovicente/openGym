// log_body: the PUT changes only the day given.
import { test, expect, beforeEach } from 'vitest'
import { logBody, applyBody, _resetBodyWindow } from '../src/body-tools.js'

const ENV = { OPENGYM_URL: 'http://127.0.0.1:9', OPENGYM_TOKEN: 'u1:1:1.abc' }
const base = () => ({
  unit: 'kg', _wid: 'w1',
  bodyweight: [{ d: '2026-11-09', w: 79.7, t: 1, ins: [{ id: 'a', at: '17:28', w: 79.7, t: 1 }] }],
  measurements: [{ d: '2026-10-01', t: 5, chest: 100, waist: 86, other: [] }],
  customMeasurements: [],
  workouts: [{ id: 'x', d: '2026-11-01' }],
})

function fakeServer(state) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    const json = b => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => b, text: async () => JSON.stringify(b) })
    if (path === '/api/me') return json({ user: { id: 'u1' } })
    if (path === '/api/data' && (init.method || 'GET') === 'GET') return json({ state, rev: 7 })
    return json({ rev: 8 })
  }
  return { calls, fetchImpl }
}

beforeEach(() => _resetBodyWindow())

test('saves one day; other days, workouts and settings untouched', async () => {
  const S = base()
  const { calls, fetchImpl } = fakeServer(S)
  const r = await logBody.handler({ date: '2026-11-10', weight: 80.6, time: '09:11', measurements: { chest: 99, waist: 85, hips: 102 } }, { env: ENV, fetchImpl })
  expect(r.logged).toBe(true)
  const put = calls.find(c => c.method === 'PUT').body
  expect(put.baseRev).toBe(7)
  const out = put.state
  expect(out.measurements.find(m => m.d === '2026-10-01')).toEqual(S.measurements[0])
  const day = out.measurements.find(m => m.d === '2026-11-10')
  expect([day.chest, day.waist, day.hips]).toEqual([99, 85, 102])
  expect(out.bodyweight.find(b => b.d === '2026-11-09')).toEqual(S.bodyweight[0])
  expect(out.bodyweight.find(b => b.d === '2026-11-10').w).toBe(80.6)
  expect(out.workouts).toEqual(S.workouts)
  expect(out.measurementEnabled).toBeUndefined()
})

test('optional field off and unknown custom field come back as problems, nothing saved', async () => {
  const { calls, fetchImpl } = fakeServer(base())
  const r = await logBody.handler({ date: '2026-11-10', measurements: { bodyFat: 17.37 }, custom: [{ name: 'Massa gorda', value: 14, unit: 'kg' }] }, { env: ENV, fetchImpl })
  expect(r.logged).toBe(false)
  expect(r.problems).toHaveLength(2)
  expect(calls.some(c => c.method === 'PUT')).toBe(false)
})

test('with consent: creates custom fields, switches bodyFat on, keeps existing values of the day', () => {
  const S = base()
  S.measurements.push({ d: '2026-11-10', t: 3, neck: 38, other: [] })
  const r = applyBody(S, { date: '2026-11-10', measurements: { bodyFat: 17.37 }, custom: [{ name: 'Dobra tríceps (mm)', value: 11, unit: 'none' }], create_custom: true, enable_fields: true }, 100)
  expect(r.view.fields_switched_on).toEqual(['bodyFat'])
  const day = S.measurements.find(m => m.d === '2026-11-10')
  expect(day.neck).toBe(38)
  expect(day.bodyFat).toBe(17.4)
  expect(day.other[0]).toMatchObject({ name: 'Dobra tríceps (mm)', value: 11, unit: 'none' })
  expect(S.customMeasurements).toHaveLength(1)
  expect(S.measurementEnabled).toContain('bodyFat')
})

test('dry run never PUTs', async () => {
  const { calls, fetchImpl } = fakeServer(base())
  const r = await logBody.handler({ date: '2026-11-10', measurements: { chest: 99 }, dry_run: true }, { env: ENV, fetchImpl })
  expect(r.dry_run).toBe(true)
  expect(calls.some(c => c.method === 'PUT')).toBe(false)
})
