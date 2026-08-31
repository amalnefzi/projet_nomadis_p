const test = require('node:test')
const assert = require('node:assert/strict')

const {
  __testables: serverTestables
} = require('../server')

test.after(async () => {
  await serverTestables.closeOpenHandles()
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createMockReq(body) {
  return {
    body,
    app: {
      locals: {}
    }
  }
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

function createCoverageValidationHarness() {
  const tournees = []

  const queryAsync = async (sql, params = []) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()

    if (normalizedSql.includes('FROM clients c') && normalizedSql.includes('WHERE c.deleted_at IS NULL')) {
      const requestedCodes = new Set(params.map(value => String(value || '').trim()))
      const rows = []

      if (requestedCodes.has('00152')) {
        rows.push({ client_id: '101', client_code: '00152' })
      }
      if (requestedCodes.has('152')) {
        rows.push({ client_id: '102', client_code: '152' })
      }

      return rows
    }

    if (normalizedSql.startsWith('DELETE FROM tournees')) {
      const [frequence, commercialCode, dateDebut, dateFin] = params
      for (let index = tournees.length - 1; index >= 0; index -= 1) {
        const row = tournees[index]
        if (
          row.frequence === frequence &&
          row.code_layer === commercialCode &&
          row.date_debut === dateDebut &&
          row.date_fin === dateFin
        ) {
          tournees.splice(index, 1)
        }
      }
      return { affectedRows: 1 }
    }

    if (normalizedSql.startsWith('INSERT INTO tournees')) {
      const [
        code,
        libelle,
        coordinates,
        code_jour,
        client_id,
        client_code,
        routing_code,
        depot_code,
        frequence,
        dates,
        date_debut,
        date_fin,
        rang,
        categorie_code,
        code_layer,
        type_client,
        rs_client_code,
        latitude,
        longitude,
        adresse,
        client
      ] = params

      tournees.push({
        code,
        libelle,
        coordinates,
        code_jour,
        client_id,
        client_code,
        routing_code,
        depot_code,
        frequence,
        dates,
        date_debut,
        date_fin,
        rang,
        categorie_code,
        code_layer,
        type_client,
        rs_client_code,
        latitude,
        longitude,
        adresse,
        client
      })

      return { insertId: tournees.length }
    }

    throw new Error(`Unexpected SQL in coverage validation harness: ${normalizedSql}`)
  }

  const withTransaction = async handler => {
    const snapshot = clone(tournees)

    try {
      return await handler({ tx: true })
    } catch (error) {
      tournees.splice(0, tournees.length, ...snapshot)
      throw error
    }
  }

  return {
    tournees,
    dependencies: {
      queryAsync,
      withTransaction,
      ensureMovementSupportTables: async () => {},
      ensureValidatedTourneeIdentityColumns: async () => {}
    }
  }
}

test('coverage validation handler saves a valid block without queryAsyncImpl ReferenceError', async () => {
  const harness = createCoverageValidationHarness()
  const req = createMockReq({
    date: '2026-08-31',
    day_label: 'Lundi',
    commercial_code: 'C01',
    commercial_label: 'Commercial 1',
    route_code: 'R01',
    depot_code: 'D01',
    depot_name: 'Depot Central',
    stops: [
      {
        client_id: 'frontend-will-be-overridden',
        client_code: '00152',
        client_name: 'Client 00152',
        adresse: 'Adresse 1',
        latitude: 36.8,
        longitude: 10.1,
        rang: 1
      },
      {
        client_id: 'frontend-will-also-be-overridden',
        client_code: '152',
        client_name: 'Client 152',
        adresse: 'Adresse 2',
        latitude: 36.81,
        longitude: 10.11,
        rang: 2
      }
    ]
  })
  const res = createMockRes()

  await serverTestables.handleCoveragePlanValidationRoute(req, res, harness.dependencies)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'success')
  assert.equal(res.body.saved_rows, 2)
  assert.equal(harness.tournees.length, 2)
  assert.deepEqual(
    harness.tournees.map(row => ({
      client_id: row.client_id,
      client_code: row.client_code,
      frequence: row.frequence,
      code_layer: row.code_layer
    })),
    [
      {
        client_id: '101',
        client_code: '00152',
        frequence: 'couverture_ia',
        code_layer: 'C01'
      },
      {
        client_id: '102',
        client_code: '152',
        frequence: 'couverture_ia',
        code_layer: 'C01'
      }
    ]
  )
  assert.match(res.body.message, /tournee finale du 2026-08-31/)
})
